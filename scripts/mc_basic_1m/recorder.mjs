/**
 * Read-only repaint recorder (design lines 109-115, 157). Polls tab 1 every 1 s and tab 2 every 5 s,
 * stores each closed row's values as first seen, records every mismatch in mismatch_history.json,
 * and writes recorder.json after every poll. It never writes the trade log or guard.json.
 *
 * Flags: --rename-corrupt (after the user's approval, moves an unparseable mismatch_history.json
 * aside and starts a new history), --max-polls N (test-only: stop after N polls).
 */
import * as store from './store.mjs';
import * as repaint from './repaint.mjs';

const TAB1_POLL_MS = 1000;
const TAB2_POLL_MS = 5000;

/** Parse argv. Returns { renameCorrupt, maxPolls } or null on a usage error. */
function parseArgs(argv) {
  const renameCorrupt = argv.includes('--rename-corrupt');
  let maxPolls = null;
  const at = argv.indexOf('--max-polls');
  if (at !== -1) {
    const raw = argv[at + 1];
    if (!/^\d+$/.test(String(raw))) return null;
    maxPolls = Number(raw);
  }
  return { renameCorrupt, maxPolls };
}

/** Start-up checks and history entries (design line 157). Returns the loaded state, or null when refused. */
function startUp(deps, renameCorrupt) {
  const rec = store.readRecorder();
  if (rec.state === 'corrupt') {
    deps.err('recorder.json does not parse; refusing to start (status stays "repaint unverified")');
    return null;
  }
  const hist = store.readMismatchHistory();
  if (hist.state === 'corrupt') {
    if (!renameCorrupt) {
      deps.err('mismatch_history.json does not parse; refusing to start. Run with --rename-corrupt only after the user approves.');
      return null;
    }
    const copy = store.copyMismatchHistoryCorrupt();
    deps.out(`copied corrupt history to ${copy}`);
    store.createMismatchHistory({ kind: 'history_lost', detected_at: deps.now() });
    deps.out('mismatch_history.json recreated with a history_lost entry');
    store.appendMismatchHistory({ kind: 'start', detected_at: deps.now() });
  } else if (hist.state === 'missing') {
    // A first run has no recorder files at all: its first entry is "start".
    // Missing history beside an existing recorder.json is a lost history: "history_lost" restarts coverage.
    const kind = store.recorderFilesExist() ? 'history_lost' : 'start';
    store.createMismatchHistory({ kind, detected_at: deps.now() });
  } else {
    store.appendMismatchHistory({ kind: 'start', detected_at: deps.now() });
  }
  const data = rec.state === 'ok' ? rec.data : {};
  return {
    rows: {
      tab1: (data.rows && data.rows.tab1) || {},
      tab2: (data.rows && data.rows.tab2) || {},
    },
    lastPoll1: typeof data.last_poll_t1 === 'number' ? data.last_poll_t1 : null,
    lastPoll2: typeof data.last_poll_t2 === 'number' ? data.last_poll_t2 : null,
    // In-memory first-seen times per tab (ms), keyed by bar time, pruned to the bars in each read.
    firstSeen: { tab1: {}, tab2: {} },
    // Newest closed row time (seconds) from the last successful read of each tab.
    newest: { tab1: null, tab2: null },
    nextTab2: 0,
    status: null,
  };
}

/**
 * One read_history call. Returns { live, barTimes, newest } (live: closed rows from toRows,
 * barTimes: every bar time in the read, including the open bar), or null when the read failed.
 */
async function readTab(deps, tab, now) {
  let result;
  try {
    result = await deps.run('read_history', {}, tab);
  } catch (err) {
    deps.err(`${tab} read failed: ${err.code || 'E_UNKNOWN'} ${err.message}`);
    return null;
  }
  if (!Array.isArray(result)) {
    deps.err(`${tab} read failed: ${JSON.stringify(result)}`);
    return null;
  }
  try {
    const live = repaint.toRows(result, now);
    const barTimes = result[0].map((bar) => String(bar[0]));
    return { live, barTimes, newest: newestOf(live) };
  } catch (err) {
    deps.err(`${tab} read failed: ${err.message}`);
    return null;
  }
}

/** Mismatch check, storage and finality for one tab. Appends mismatch entries before any recorder.json write. */
function updateTab(deps, st, tab, read, now) {
  const hist = store.readMismatchHistory();
  if (hist.state !== 'ok') {
    const code = hist.state === 'missing' ? 'E_HISTORY_MISSING' : 'E_HISTORY_CORRUPT';
    throw Object.assign(new Error(`mismatch_history.json is ${hist.state}; stopping`), { code });
  }
  const guard = store.readGuard();
  const guardMismatches = guard.state === 'ok' && Array.isArray(guard.guard.draw_mismatches)
    ? guard.guard.draw_mismatches.filter((m) => m && m.tab === tab)
    : [];
  const fresh = repaint.newMismatches({
    tab,
    recorded: st.rows[tab],
    live: read.live,
    history: hist.data.entries,
    guardMismatches,
    now,
  });
  for (const entry of fresh) {
    store.appendMismatchHistory({ kind: 'mismatch', ...entry });
    deps.out(`MISMATCH ${tab} row ${entry.row_time} (repaint unverified)`);
  }

  const firstSeen = st.firstSeen[tab];
  for (const key of read.barTimes) {
    if (!(key in firstSeen)) firstSeen[key] = now;
  }
  const inRead = new Set(read.barTimes);
  for (const key of Object.keys(firstSeen)) {
    if (!inRead.has(key)) delete firstSeen[key];
  }
  st.rows[tab] = repaint.storeNewRows({ tab, rows: st.rows[tab], live: read.live, now, firstSeen });
  st.rows[tab] = repaint.markFinal(st.rows[tab], read.live, now);
}

/** Newest closed row time in a live read (seconds), or null. */
function newestOf(live) {
  const keys = Object.keys(live).map(Number);
  return keys.length === 0 ? null : Math.max(...keys);
}

/** guard.json counts as fresh (design line 166) when it, trade_log.json, log.bak and every flag file are all absent. */
function guardIsFresh(guard) {
  return guard.state === 'missing'
    && store.readLog().state === 'missing'
    && !store.logBakExists()
    && store.listFlagFiles().length === 0;
}

/** One poll: tab 1 always, tab 2 when due. Then recompute the status and rewrite recorder.json. */
async function poll(deps, st) {
  const now = deps.now();
  const read1 = await readTab(deps, 'tab1', now);
  let read2 = null;
  if (now >= st.nextTab2) {
    st.nextTab2 = now + TAB2_POLL_MS;
    read2 = await readTab(deps, 'tab2', now);
  }
  if (read1 !== null) {
    updateTab(deps, st, 'tab1', read1, now);
    st.lastPoll1 = now;
    st.newest.tab1 = read1.newest;
  }
  if (read2 !== null) {
    updateTab(deps, st, 'tab2', read2, now);
    st.lastPoll2 = now;
    st.newest.tab2 = read2.newest;
  }
  const hist = store.readMismatchHistory();
  const guard = store.readGuard();
  guard.fresh = guardIsFresh(guard);
  const recorder = {
    state: 'ok',
    data: { rows: st.rows, last_poll_t1: st.lastPoll1, last_poll_t2: st.lastPoll2 },
  };
  const status = repaint.computeStatus({
    recorder,
    history: hist,
    guard,
    now,
    newestLive: { tab1: st.newest.tab1, tab2: st.newest.tab2 },
  });
  if (JSON.stringify(status) !== JSON.stringify(st.status)) {
    st.status = status;
    deps.out(`status ${status.status}: ${status.reason}`);
  }
  store.writeRecorder({
    rows: st.rows,
    last_poll_t1: st.lastPoll1,
    last_poll_t2: st.lastPoll2,
    status,
  });
}

/** The poll loop. Returns 0 after --max-polls polls; otherwise it runs until an error stops it. */
async function loop(deps, renameCorrupt, maxPolls) {
  const st = startUp(deps, renameCorrupt);
  if (st === null) return 1;
  deps.out('recorder started');
  for (let polls = 0; maxPolls === null || polls < maxPolls; polls++) {
    await poll(deps, st);
    if (maxPolls !== null && polls + 1 >= maxPolls) break;
    await deps.sleep(TAB1_POLL_MS);
  }
  return 0;
}

/**
 * Recorder command. Takes recorder.lock (refuses with 1 when it is held), runs the poll loop,
 * prints guard_digest and releases the lock on every exit path.
 */
export async function main(argv, deps) {
  const args = parseArgs(argv);
  if (args === null) {
    deps.err('usage: recorder [--rename-corrupt] [--max-polls N]');
    return 2;
  }
  try {
    store.takeRecorderLock();
  } catch (err) {
    deps.err(err.code === 'E_LOCK_HELD'
      ? 'recorder.lock is held; refusing to start'
      : `cannot take recorder.lock: ${err.code || 'E_UNKNOWN'} ${err.message}`);
    return 1;
  }
  let code = 1;
  try {
    code = await loop(deps, args.renameCorrupt, args.maxPolls);
  } catch (err) {
    deps.err(`recorder stopped: ${err.code || 'E_UNKNOWN'} ${err.message}`);
    code = 1;
  } finally {
    try {
      deps.out(`guard_digest = ${store.guardDigest()}`);
    } catch (err) {
      deps.err(`guard_digest unavailable: ${err.message}`);
    }
    try {
      store.releaseRecorderLock();
    } catch (err) {
      deps.err(`cannot release recorder.lock: ${err.message}`);
      code = 1;
    }
  }
  return code;
}
