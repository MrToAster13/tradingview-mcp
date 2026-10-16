/**
 * resolve command (design lines 161-162). Settles one pending record of a run from two reads of tab 1.
 * Usage: resolve <run id> <record key> --expect-guard <digest> [--colour-ok <ids>] [--chart-empty-ok]
 * Exit: 0 when the record is settled (drawn or not drawn), 1 when refused or undecided, 2 for usage.
 *
 * Also exports the helpers that clear.mjs shares: argument parsing, the locked guard gate (design
 * line 166), the colour-ok storage, the tab 1 read and the lock wrapper.
 */
import * as store from './store.mjs';
import * as shapes from './shapes.mjs';

/** Design line 161: a pending record settles no earlier than 60 s after its deadline. */
export const SETTLE_MS = 60000;
/** Design line 162: two reads at least 5 s apart. */
export const RESOLVE_GAP_MS = 5000;
/** Design line 170: the loading test reads twice 2 s apart. */
export const CLEAR_GAP_MS = 2000;

export const RESOLVE_USAGE = 'usage: resolve <run id> <record key> --expect-guard <digest> [--colour-ok <ids>] [--chart-empty-ok]';
export const CLEAR_USAGE = 'usage: clear <run id> --expect-guard <digest> [--colour-ok <ids>] [--chart-empty-ok]';

const DIGEST_RE = /^(missing|[0-9a-f]{8})\+\d+$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

/** A refusal: the command stops, writes nothing further and exits 1. */
export function refusal(message) {
  const e = new Error(message);
  e.code = 'E_REFUSED';
  return e;
}

function usageError(message) {
  const e = new Error(message);
  e.code = 'E_USAGE';
  return e;
}

/** Splits argv into positional values and the shared flags. Throws E_USAGE on a bad flag. */
export function parseArgs(argv) {
  const pos = [];
  const opts = { expectGuard: null, colourOk: [], chartEmptyOk: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--expect-guard' || a === '--colour-ok') {
      if (i + 1 >= argv.length) throw usageError(`${a} needs a value`);
      const v = argv[++i];
      if (a === '--expect-guard') {
        if (!DIGEST_RE.test(v)) throw usageError('--expect-guard needs a digest such as 3fa9c01e+1 or missing+0');
        opts.expectGuard = v;
      } else {
        for (const id of v.split(',')) {
          if (!ID_RE.test(id)) throw usageError(`bad shape id in --colour-ok: "${id}"`);
          if (!opts.colourOk.includes(id)) opts.colourOk.push(id);
        }
      }
    } else if (a === '--chart-empty-ok') {
      opts.chartEmptyOk = true;
    } else if (a.startsWith('--')) {
      throw usageError(`unknown flag ${a}`);
    } else {
      pos.push(a);
    }
  }
  if (opts.expectGuard === null) throw usageError('--expect-guard <digest> is required');
  return { pos, ...opts };
}

/** Reads the trade log; every command except --broker-failed refuses unless it parses (design line 158). */
export function loadLog() {
  const r = store.readLog();
  if (r.state !== 'ok') {
    throw refusal(`trade log is ${r.state}; a log.bak or a manual restore is the exit (design line 158)`);
  }
  return r.log;
}

/** All records of a run, in any state. */
export function recordsOf(log, runId) {
  return Object.values(log.records || {}).filter((r) => r && r.run === runId);
}

/**
 * Guard gate, run right after the trade-log lock is taken (design line 166): the digest must equal
 * --expect-guard, and the guard must not be lost, corrupt or missing. Prints broker_check, the probe
 * key and the epoch's probe-entry count. Returns the guard.
 * Departure: a corrupt or missing guard.json is refused here; the lost-state write is left to broker-reset.
 */
export function guardGate(opts, log, deps) {
  const gr = store.readGuard();
  if (gr.state === 'corrupt') {
    throw refusal('guard.json does not parse; broker-reset is the exit (design line 166)');
  }
  if (gr.state === 'missing') {
    throw refusal('guard.json is missing while the trade log holds records; broker-reset is the exit (design line 166)');
  }
  const guard = gr.guard;
  const digest = store.guardDigest();
  if (digest !== opts.expectGuard) {
    throw refusal(`guard digest on disk is ${digest}, not ${opts.expectGuard}; not adopting it (design line 166)`);
  }
  if (guard.broker_check === 'lost') {
    throw refusal('broker_check is lost; broker-reset is the exit (design line 166)');
  }
  const epoch = Math.max(log.reset_count || 0, guard.reset_count || 0);
  const probes = (log.probes || []).filter((p) => p && p.epoch === epoch).length;
  deps.out(`broker_check = ${guard.broker_check}`);
  deps.out(`probe_key = ${guard.probe_key}`);
  deps.out(`epoch ${epoch} probe entries = ${probes}`);
  return guard;
}

function union(a, b) {
  const out = [...(a || [])];
  for (const x of b) if (!out.includes(x)) out.push(x);
  return out;
}

/**
 * Stores --colour-ok IDs in the trade log and in guard.json (design line 155). Writes only the file
 * whose list grew. The caller holds the trade-log lock.
 */
export function storeColourOk(opts, log, guard) {
  if (opts.colourOk.length === 0) return;
  const logIds = union(log.colour_ok, opts.colourOk);
  if (logIds.length !== (log.colour_ok || []).length) {
    log.colour_ok = logIds;
    store.writeLog(log);
  }
  const guardIds = union(guard.colour_ok, opts.colourOk);
  if (guardIds.length !== (guard.colour_ok || []).length) {
    guard.colour_ok = guardIds;
    store.writeGuard(guard);
  }
}

/** One read of tab 1 shapes. A template error code or any non-list result is a refusal. */
export async function readTab1(deps) {
  const r = await deps.run('read_shapes', {}, 'tab1');
  if (!Array.isArray(r)) {
    const what = typeof r === 'string' ? r : 'a non-list value';
    throw refusal(`read_shapes on tab1 returned ${what}`);
  }
  return r;
}

/** One line for a shape: ID, name, points, colour and text. */
export function fmtShape(s) {
  if (s === null || typeof s !== 'object') return String(s);
  const pts = Array.isArray(s.pts)
    ? s.pts.map((p) => `${(p || {}).time}@${(p || {}).price}`).join(' ')
    : 'no points';
  return `${s.id} ${s.name} [${pts}] ${s.linecolor} ${JSON.stringify(s.text ?? null)}`;
}

/**
 * Runs body under the trade-log lock. Releases the lock in finally and prints guard_digest on every
 * stop after the lock is taken. Refusals and errors print one line on stderr and return 1.
 */
export async function withTradeLock(deps, body) {
  try {
    store.takeLogLock();
  } catch (e) {
    deps.err(`${e.code || 'E_LOCK'}: ${e.message}`);
    return 1;
  }
  try {
    return await body();
  } catch (e) {
    deps.err(`${e.code || 'E_ERROR'}: ${e.message}`);
    return 1;
  } finally {
    try {
      deps.out(`guard_digest = ${store.guardDigest()}`);
    } catch (e) {
      deps.err(`guard_digest unavailable: ${e.message}`);
    }
    store.releaseLogLock();
  }
}

/** Refuses unless the record is pending and at least 60 s past its deadline (design line 161). */
export function checkRecord(log, runId, key, now) {
  const rec = (log.records || {})[key];
  if (!rec) throw refusal(`no record with key ${key}`);
  if (rec.run !== runId) throw refusal(`record ${key} belongs to run ${rec.run}, not ${runId}`);
  if (rec.state !== 'pending') throw refusal(`record ${key} is ${rec.state}; resolve settles pending records only`);
  if (now < rec.deadline + SETTLE_MS) {
    throw refusal(`record ${key} may still be written until ${rec.deadline + SETTLE_MS} ms (60 s after its deadline, design line 161)`);
  }
  return rec;
}

/** Refuses a run with no records, or with a pending record that is still inside its 60 s window. */
export function checkRunSettled(log, runId, now) {
  const recs = recordsOf(log, runId);
  if (recs.length === 0) throw refusal(`no records for run ${runId} in the trade log`);
  for (const r of recs) {
    if (r.state === 'pending' && now < r.deadline + SETTLE_MS) {
      throw refusal(`pending record ${r.key} may still be written until ${r.deadline + SETTLE_MS} ms (design line 161)`);
    }
  }
}

/** resolve entry point. Takes deps as in design line 13 and returns the exit code. */
export async function main(argv, deps) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    deps.err(e.message);
    deps.err(RESOLVE_USAGE);
    return 2;
  }
  if (opts.pos.length !== 2) {
    deps.err(RESOLVE_USAGE);
    return 2;
  }
  const [runId, key] = opts.pos;

  try {
    checkRecord(loadLog(), runId, key, deps.now());
  } catch (e) {
    deps.err(`${e.code || 'E_ERROR'}: ${e.message}`);
    return 1;
  }

  return withTradeLock(deps, async () => {
    const log = loadLog();
    const guard = guardGate(opts, log, deps);
    storeColourOk(opts, log, guard);
    const record = checkRecord(log, runId, key, deps.now());

    const read1 = await readTab1(deps);
    await deps.sleep(RESOLVE_GAP_MS);
    const read2 = await readTab1(deps);
    const stable = shapes.loadingTest(read1, read2, opts.chartEmptyOk);
    if (!stable.ok) throw refusal(`tab 1 reads not settled: ${stable.reason}`);

    const m = shapes.matchResolve({ record, read1, read2, log, guard });
    const now = deps.now();

    if (m.verdict === 'drawn') {
      record.state = 'drawn';
      record.position_id = m.position_id;
      record.text_id = m.text_id;
      record.written_at = now;
      store.writeLog(log);
      deps.out(`drawn: ${key} position ${m.position_id} text ${m.text_id}`);
      return 0;
    }

    if (m.verdict === 'not drawn') {
      record.state = 'not drawn';
      record.written_at = now;
      store.writeLog(log);
      deps.out(`not drawn: ${key}`);
      return 0;
    }

    if (m.saw_position && !record.seen_position) {
      record.seen_position = true;
      record.written_at = now;
      store.writeLog(log);
    }
    deps.out(`undecided: ${key} stays pending`);
    for (const c of m.candidates || []) deps.out(`candidate ${fmtShape(c)}`);
    deps.out('delete the leftovers by hand, or name one for --colour-ok, then run resolve again');
    return 1;
  });
}
