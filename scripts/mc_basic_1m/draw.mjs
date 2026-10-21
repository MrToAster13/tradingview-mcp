/**
 * The draw command (design_v14 lines 141-165 and 172). Draws one approved run's trades on tab 1,
 * one draw_trade expression per trade, under the trade-log lock.
 * Usage:
 *   draw --broker-failed
 *   draw --expect-guard <digest> --broker-checked <count>
 *   draw --expect-guard <digest> --approve <run id>:<8 hex> [--broker-baseline <count>]
 *        [--probe-recheck <count>] [--panel-ok] [--allow-probe <n>] [--ack-unverified]
 *        [--colour-ok <id,id,...>] [--chart-empty-ok]
 * Exit: 0 when the command finished its work, 1 when refused or stopped, 2 for usage.
 */
import * as store from './store.mjs';
import { simulate, sha256Rows } from './sim.mjs';
import { newMismatches, computeStatus, toRows, valuesDiffer } from './repaint.mjs';
import { colourScan, clearedRecordCheck, loadingTest } from './shapes.mjs';
import * as broker from './broker.mjs';
import { CALLER_KEYS, RUN_COLOURS, buildLabel, normalizeColour } from './templates.mjs';

export const DRAW_USAGE = [
  'usage: draw --broker-failed',
  '       draw --expect-guard <digest> --broker-checked <count>',
  '       draw --expect-guard <digest> --approve <run id>:<8 hex> [--broker-baseline <count>] [--probe-recheck <count>]',
  '            [--panel-ok] [--allow-probe <n>] [--ack-unverified] [--colour-ok <id,id,...>] [--chart-empty-ok]',
].join('\n');

const APPROVE_RE = /^(HTF-a|HTF-b|HTF-c):([0-9a-f]{8})$/;
const MAX_PASSED_DRAWS = 10;
const DEADLINE_MS = 30000;
const SHAPES_GAP_MS = 2000;
const STATUS_RETRY_MS = 1000;
const STATUS_RETRIES = 15;
const MIN_WIDTH_S = 300;

const FLAG_SPEC = {
  '--broker-failed': 'bool',
  '--approve': 'string',
  '--ack-unverified': 'bool',
  '--broker-baseline': 'int',
  '--probe-recheck': 'int',
  '--broker-checked': 'int',
  '--panel-ok': 'bool',
  '--allow-probe': 'int',
  '--expect-guard': 'string',
  '--colour-ok': 'list',
  '--chart-empty-ok': 'bool',
};

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function union(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const v of arr(list)) {
      if (!seen.has(v)) {
        seen.add(v);
        out.push(v);
      }
    }
  }
  return out;
}

/**
 * SHA-256 of a run's trade list as the report shows it (design line 163): entry time, side, E, S, T
 * per trade, in quarter points. Same formula as report.mjs tradeListSha256.
 */
export function tradeListSha(trades) {
  return sha256Rows(arr(trades).map((t) => [t.entryTime, t.side, t.eQ, t.sQ, t.tQ]));
}

/** Parses the draw flags. Throws E_USAGE. */
export function parseDrawArgs(argv) {
  const raw = broker.parseFlags(argv, FLAG_SPEC);
  const get = (k) => (Object.hasOwn(raw, k) ? raw[k] : null);
  if (get('--broker-failed') !== null) {
    if (argv.length !== 1) throw broker.usageError('--broker-failed takes no other flag');
    return { brokerFailed: true };
  }
  const expectGuard = get('--expect-guard');
  if (expectGuard === null) throw broker.usageError('--expect-guard <digest> is required');
  if (!broker.DIGEST_RE.test(expectGuard)) throw broker.usageError('--expect-guard needs a digest such as 3fa9c01e+1 or missing+0');
  const opts = {
    brokerFailed: false,
    expectGuard,
    approve: null,
    ackUnverified: get('--ack-unverified') === true,
    brokerBaseline: get('--broker-baseline'),
    probeRecheck: get('--probe-recheck'),
    brokerChecked: get('--broker-checked'),
    panelOk: get('--panel-ok') === true,
    allowProbe: get('--allow-probe'),
    colourOk: get('--colour-ok') || [],
    chartEmptyOk: get('--chart-empty-ok') === true,
  };
  if (opts.brokerChecked !== null) {
    const extra = Object.keys(raw).filter((k) => k !== '--broker-checked' && k !== '--expect-guard');
    if (extra.length > 0) throw broker.usageError(`--broker-checked takes only --expect-guard (got ${extra.join(', ')})`);
    return opts;
  }
  const approve = get('--approve');
  if (approve === null) throw broker.usageError('--approve <run id>:<first 8 hex of the snapshot SHA-256> is required');
  const m = APPROVE_RE.exec(approve);
  if (!m) throw broker.usageError('--approve needs <HTF-a|HTF-b|HTF-c>:<8 lowercase hex>');
  opts.approve = { runId: m[1], hex: m[2] };
  return opts;
}

function modeOpts(opts) {
  return {
    runId: opts.approve ? opts.approve.runId : null,
    brokerBaseline: opts.brokerBaseline,
    probeRecheck: opts.probeRecheck,
    brokerChecked: opts.brokerChecked,
    panelOk: opts.panelOk,
    allowProbe: opts.allowProbe,
  };
}

/** draw_trade values and record fields for one trade (design lines 145, 149, 159-160). */
export function tradePlan(trade, info) {
  const long = trade.side === 'long';
  const stopLevel = trade.dQ;
  const profitLevel = long ? trade.tQ - trade.eQ : trade.eQ - trade.tQ;
  const end = trade.exitTime === null || trade.exitTime === undefined ? info.last_1m : trade.exitTime;
  const p2Time = Math.max(end, trade.entryTime + MIN_WIDTH_S);
  const entryPrice = trade.eQ / 4;
  return {
    long,
    stopLevel,
    profitLevel,
    drawable: trade.behind !== true && profitLevel > 0,
    entryPrice,
    p1: { time: trade.entryTime, price: entryPrice },
    p2: { time: p2Time, price: entryPrice },
    stop: trade.sQ / 4,
    target: trade.tQ / 4,
    textTime: trade.entryTime,
    textPrice: trade.tQ / 4,
  };
}

/** Node-side check that E -/+ stopLevel = S and E +/- profitLevel = T in quarter points (line 149). */
export function arithmeticOk(trade, plan) {
  if (!Number.isInteger(plan.stopLevel) || plan.stopLevel <= 0) return false;
  if (!Number.isInteger(plan.profitLevel) || plan.profitLevel <= 0) return false;
  const s = plan.long ? trade.eQ - plan.stopLevel : trade.eQ + plan.stopLevel;
  const t = plan.long ? trade.eQ + plan.profitLevel : trade.eQ - plan.profitLevel;
  return s === trade.sQ && t === trade.tQ;
}

/** The latest stored values of a row across mismatch_history and guard draw_mismatches (line 111). */
function latestValues(tab, key, entries, guardMismatches, firstStored) {
  let best = null;
  for (const e of arr(entries)) {
    if (isObj(e) && e.kind === 'mismatch' && e.tab === tab && String(e.row_time) === key) {
      if (best === null || e.detected_at > best.at) best = { at: e.detected_at, values: e.values };
    }
  }
  for (const e of arr(guardMismatches)) {
    if (isObj(e) && e.tab === tab && String(e.row_time) === key) {
      if (best === null || e.detected_at > best.at) best = { at: e.detected_at, values: e.new };
    }
  }
  return best === null ? firstStored : best.values;
}

function newestKey(live) {
  const keys = Object.keys(live).map(Number).filter(Number.isFinite);
  return keys.length === 0 ? null : Math.max(...keys);
}

function refuse(message, code) {
  return broker.refusal(message, code);
}

function sameKeys(obj, keys) {
  const a = Object.keys(obj).sort();
  const b = [...keys].sort();
  return a.length === b.length && a.every((k, i) => k === b[i]);
}

function idOk(x) {
  return (typeof x === 'string' && x.length > 0) || (typeof x === 'number' && Number.isFinite(x));
}

/* ---------- the run under the lock ---------- */

// The class has no special set-up method because its name is a banned word in this folder (design line 125).
// init sets the fields and returns the instance.
class DrawRun {
  init(opts, deps, st) {
    this.opts = opts;
    this.deps = deps;
    this.log = st.log;
    this.guard = st.guard;
    this.fresh = st.kind === 'fresh';
    return this;
  }

  saveLog(log) {
    store.writeLog(log);
    this.log = log;
  }

  saveGuard(guard) {
    store.writeGuard(guard);
    this.guard = guard;
    this.fresh = false;
  }

  updateRecord(key, fields) {
    const rec = { ...this.log.records[key], ...fields };
    this.saveLog({ ...this.log, records: { ...this.log.records, [key]: rec } });
  }

  checkFlags(when) {
    const open = broker.unconsumedFlags(store.listFlagFiles(), this.log, this.guard);
    if (open.length > 0) {
      throw refuse(`broker_check failed: unconsumed flag file ${open.join(', ')} ${when}; broker-reset is the exit (design line 165)`);
    }
  }

  /** The pre-draw repaint check (design line 111). Returns { status, reason }. */
  async repaintCheck() {
    const { deps } = this;
    const now = deps.now();
    const live = {};
    for (const tab of ['tab1', 'tab2']) {
      live[tab] = null;
      let result;
      try {
        result = await deps.run('read_history', {}, tab);
      } catch (e) {
        deps.err(`${tab} read_history failed: ${e.code || 'E_UNKNOWN'} ${e.message}`);
        continue;
      }
      if (!Array.isArray(result)) {
        deps.err(`${tab} read_history failed: ${JSON.stringify(result)}`);
        continue;
      }
      try {
        live[tab] = toRows(result, now);
      } catch (e) {
        deps.err(`${tab} read_history unusable: ${e.message}`);
      }
    }
    let recorder = store.readRecorder();
    let history = store.readMismatchHistory();
    if (recorder.state === 'ok' && history.state === 'ok' && isObj(recorder.data) && isObj(recorder.data.rows)) {
      const found = [];
      for (const tab of ['tab1', 'tab2']) {
        const recorded = recorder.data.rows[tab];
        if (live[tab] === null || !isObj(recorded)) continue;
        const entries = newMismatches({
          tab,
          recorded,
          live: live[tab],
          history: history.data.entries,
          guardMismatches: arr(this.guard.draw_mismatches),
          now,
        });
        for (const e of entries) {
          const key = String(e.row_time);
          const first = isObj(recorded[key]) ? recorded[key].first : null;
          const old = latestValues(tab, key, history.data.entries, this.guard.draw_mismatches, first);
          found.push({ tab, row_time: e.row_time, old, new: e.values, detected_at: e.detected_at });
        }
      }
      if (found.length > 0) {
        this.saveGuard({ ...this.guard, draw_mismatches: [...arr(this.guard.draw_mismatches), ...found] });
        deps.out(`repaint mismatch: wrote ${found.length} draw-time mismatch(es) to guard.json (design line 111)`);
      }
    }
    const newestLive = {
      tab1: live.tab1 === null ? null : newestKey(live.tab1),
      tab2: live.tab2 === null ? null : newestKey(live.tab2),
    };
    const guardArg = () => (this.fresh ? { state: 'missing', fresh: true } : { state: 'ok', guard: this.guard });
    let status = computeStatus({ recorder, history, guard: guardArg(), now: deps.now(), newestLive });
    for (let i = 0; i < STATUS_RETRIES && status.retry === true; i++) {
      await deps.sleep(STATUS_RETRY_MS);
      recorder = store.readRecorder();
      history = store.readMismatchHistory();
      status = computeStatus({ recorder, history, guard: guardArg(), now: deps.now(), newestLive });
    }
    deps.out(`repaint status = ${status.status}: ${status.reason}`);
    return status;
  }

  /** Two read_shapes reads 2 s apart, the loading test, colour scan and cleared-record check. */
  async shapeChecks(runId) {
    const { deps, opts } = this;
    const read = async () => {
      try {
        const r = await deps.run('read_shapes', {}, 'tab1');
        if (!Array.isArray(r)) {
          deps.err(`read_shapes failed: ${JSON.stringify(r)}`);
          return null;
        }
        return r;
      } catch (e) {
        deps.err(`read_shapes failed: ${e.code || 'E_UNKNOWN'} ${e.message}`);
        return null;
      }
    };
    const read1 = await read();
    await deps.sleep(SHAPES_GAP_MS);
    const read2 = await read();
    const lt = loadingTest(read1, read2, opts.chartEmptyOk);
    if (!lt.ok) throw refuse(`loading test failed: ${lt.reason} (design lines 155, 170)`);
    const scanLog = { ...this.log, colour_ok: union(this.log.colour_ok, opts.colourOk) };
    const scan = colourScan({ shapes: read2, log: scanLog, guard: this.guard, runId });
    if (scan.blocking.length > 0) {
      const known = new Set();
      for (const r of Object.values(this.log.records)) {
        if (isObj(r)) {
          if (r.position_id != null) known.add(r.position_id);
          if (r.text_id != null) known.add(r.text_id);
        }
      }
      for (const s of scan.blocking) deps.out(`colour check stop: ${JSON.stringify(s)}`);
      if (scan.blocking.some((s) => s.reasons.includes('run colour') && !known.has(s.id))) {
        deps.out('a shape in a run colour has no record: a drawing may have placed an order; look for and cancel any such order before giving an order and position count (design line 155)');
      }
      throw refuse(`colour check stopped the draw on ${scan.blocking.length} shape(s) (design line 155)`);
    }
    const cleared = clearedRecordCheck({ shapes: read2, log: scanLog, guard: this.guard });
    for (const s of cleared.reported) deps.out(`cleared record ${s.key}: ID ${s.id} is present with other attributes: ${JSON.stringify(s)}`);
    if (cleared.blocking.length > 0) {
      for (const s of cleared.blocking) deps.out(`cleared record ${s.key}: position still on tab 1: ${JSON.stringify(s)}`);
      throw refuse(`a cleared record's position is still on tab 1; delete it by hand (design line 172)`);
    }
    return read2.map((s) => s.id);
  }

  /** The guard/log writes drawMode asks for, once per command (design line 165). */
  applyModeWrites(dm) {
    const { opts } = this;
    const colourGiven = opts.colourOk.length > 0;
    if (dm.mode === 'baseline' || dm.mode === 'replacement') {
      const log = {
        ...this.log,
        probes: [...arr(this.log.probes), dm.writes.probeEntry],
        colour_ok: union(this.log.colour_ok, opts.colourOk),
      };
      this.saveLog(log);
      this.saveGuard({ ...this.guard, ...dm.writes.guard, colour_ok: union(this.guard.colour_ok, this.log.colour_ok, opts.colourOk) });
      this.deps.out(`probe entry ${dm.writes.probeEntry.key} (epoch ${dm.writes.probeEntry.epoch}) written; broker_check = pending`);
    } else if (colourGiven) {
      this.saveLog({ ...this.log, colour_ok: union(this.log.colour_ok, opts.colourOk) });
      this.saveGuard({ ...this.guard, colour_ok: union(this.guard.colour_ok, this.log.colour_ok, opts.colourOk) });
    }
    if (colourGiven) this.deps.out(`stored --colour-ok IDs ${opts.colourOk.join(', ')} in the log and guard.json`);
  }

  baseRecord(target, plan, snapshotSha, unverified) {
    const t = target.trade;
    return {
      key: target.key,
      run: this.opts.approve.runId,
      cycle: target.cycle,
      index: target.index,
      attempt: target.attempt,
      snapshot_sha256: snapshotSha,
      side: t.side,
      entry_time: t.entryTime,
      entry_price: plan.entryPrice,
      p1: plan.p1,
      p2: plan.p2,
      stop: plan.stop,
      target: plan.target,
      text: buildLabel(this.opts.approve.runId, unverified),
      text_time: plan.textTime,
      text_price: plan.textPrice,
      stop_level: plan.stopLevel,
      profit_level: plan.profitLevel,
      deadline: null,
      pre_draw_ids: [],
      position_id: null,
      text_id: null,
      state: 'pending',
      mismatch: false,
      seen_position: false,
      written_at: null,
    };
  }

  /** Handles one draw_trade return (design lines 143-152). Returns true when drawn cleanly. */
  handleResult(key, res, runId) {
    const { deps } = this;
    if (isObj(res) && Object.hasOwn(res, 'value') && Object.hasOwn(res, 'identity')) {
      const v = res.value;
      if (Array.isArray(v)) {
        const fields = {};
        if (idOk(v[1])) fields.text_id = v[1];
        if (idOk(v[2])) fields.position_id = v[2];
        if (Object.keys(fields).length > 0) this.updateRecord(key, fields);
      }
      const why = res.identity === true ? 'the deadline passed' : `identity check returned ${JSON.stringify(res.identity)}`;
      throw refuse(`draw_trade returned E_GUARD (${why}); record ${key} stays pending for resolve (design lines 143, 161)`, 'E_GUARD');
    }
    if (Array.isArray(res)) {
      const [code, textId, posId] = res;
      const fields = {};
      if (idOk(textId)) fields.text_id = textId;
      if (idOk(posId)) fields.position_id = posId;
      if (code === 'E_SHAPE_MISMATCH') {
        this.updateRecord(key, { ...fields, state: 'drawn', mismatch: true });
        throw refuse(`draw_trade returned E_SHAPE_MISMATCH; record ${key} is drawn with a mismatch flag; clearing it is the exit (design line 150)`, 'E_SHAPE_MISMATCH');
      }
      if (Object.keys(fields).length > 0) this.updateRecord(key, fields);
      throw refuse(`draw_trade returned ${String(code)}; record ${key} stays pending for resolve (design lines 147-151)`, typeof code === 'string' ? code : 'E_DRAW');
    }
    if (isObj(res) && idOk(res.id) && idOk(res.text)) {
      const norm = normalizeColour(res.linecolor);
      const want = normalizeColour(RUN_COLOURS[runId]);
      if (norm !== null && norm === want) {
        this.updateRecord(key, { state: 'drawn', position_id: res.id, text_id: res.text });
        deps.out(`drawn ${key}: position ${res.id}, text ${res.text}`);
        return true;
      }
      this.updateRecord(key, { state: 'drawn', mismatch: true, position_id: res.id, text_id: res.text });
      throw refuse(`record ${key} drawn with linecolor ${JSON.stringify(res.linecolor)}, not ${want}; mismatch flag set, the run stops (design line 149)`, 'E_SHAPE_MISMATCH');
    }
    throw refuse(`draw_trade returned an unexpected value ${JSON.stringify(res)}; record ${key} stays pending for resolve`, 'E_DRAW');
  }
}

/** Approval and snapshot checks (design line 163). Returns { snapshotSha, info, trades }. */
function approvalCheck(log, opts) {
  const runId = opts.approve.runId;
  const ls = isObj(log) ? log.last_shown : null;
  if (!isObj(ls) || typeof ls.snapshot_sha256 !== 'string' || !isObj(ls.runs)) {
    throw refuse('the log holds no "last shown" report; run the report first (design line 163)');
  }
  if (ls.snapshot_sha256.slice(0, 8) !== opts.approve.hex) {
    throw refuse(`--approve ${opts.approve.hex} does not match the last shown snapshot ${ls.snapshot_sha256.slice(0, 8)} (design line 163)`);
  }
  if (typeof ls.runs[runId] !== 'string') throw refuse(`run ${runId} has no last shown trade list (design line 163)`);
  const before = store.snapshotFileSha256('current');
  if (before === null) throw refuse('the snapshot file is missing (design line 163)');
  const snap = store.readSnapshot(store.snapshotPath('current'));
  const after = store.snapshotFileSha256('current');
  if (after !== before) throw refuse('the snapshot file changed while it was read');
  if (!isObj(snap) || snap.sha256 !== ls.snapshot_sha256) {
    throw refuse('the snapshot on disk is not the last shown snapshot (design line 163)');
  }
  const result = simulate(snap);
  if (result.info.sha256 !== ls.snapshot_sha256) throw refuse('the re-simulated snapshot is not the last shown snapshot');
  const run = result.runs.find((r) => r.runId === runId);
  if (!run) throw refuse(`run ${runId} is missing from the simulation`);
  if (tradeListSha(run.trades) !== ls.runs[runId]) {
    throw refuse(`run ${runId}'s re-simulated trade list differs from the one last shown; report again (design line 163)`);
  }
  for (const r of Object.values(isObj(log.records) ? log.records : {})) {
    if (isObj(r) && r.run === runId && (r.state === 'pending' || r.state === 'drawn') && r.snapshot_sha256 !== ls.snapshot_sha256) {
      throw refuse(`record ${r.key} of run ${runId} comes from another snapshot; clear the run first (design line 163)`);
    }
  }
  return { snapshotSha: ls.snapshot_sha256, info: result.info, trades: run.trades };
}

async function drawLocked(opts, deps) {
  const st = broker.lockedGuardGate({ expectGuard: opts.expectGuard, now: deps.now(), out: deps.out });
  if (st.kind !== 'fresh' && st.logRead.state === 'missing' && !st.logBak) {
    throw refuse('the log and log.bak are both missing while guard.json exists; no record is known and broker-reset is the exit (design line 158)');
  }
  const ctx = new DrawRun().init(opts, deps, st);
  const records = isObj(ctx.log) && isObj(ctx.log.records) ? Object.values(ctx.log.records).filter(isObj) : [];
  const pending = records.find((r) => r.state === 'pending');
  if (pending) throw refuse(`record ${pending.key} is pending; resolve settles it first (design line 160)`);
  const bad = records.find((r) => r.state === 'drawn' && r.mismatch === true);
  if (bad) throw refuse(`record ${bad.key} is drawn with a mismatch flag; clearing it is the exit (design line 160)`);

  if (opts.brokerChecked !== null) {
    const dm = broker.drawMode({ log: ctx.log, guard: ctx.guard, flags: st.flags, opts: modeOpts(opts), runTrades: null });
    if (dm.mode === 'refuse') {
      if (dm.writes.guard) {
        ctx.saveGuard({ ...ctx.guard, ...dm.writes.guard });
        deps.out('wrote count_refused = true to guard.json (design line 165)');
      }
      throw refuse(`${dm.reason} (design line 165)`);
    }
    if (dm.mode !== 'checked') throw refuse(`unexpected draw mode ${dm.mode} for --broker-checked`);
    ctx.saveGuard({ ...ctx.guard, ...dm.writes.guard });
    deps.out(`${dm.reason}; the next draw needs --panel-ok (design line 165)`);
    return 0;
  }

  const runId = opts.approve.runId;
  const other = records.find((r) => r.run !== runId && (r.state === 'pending' || r.state === 'drawn'));
  if (other) throw refuse(`run ${other.run} has a ${other.state} record ${other.key}; one run on the chart at a time (design lines 160, 172)`);
  const appr = approvalCheck(ctx.log, opts);
  const dm = broker.drawMode({ log: ctx.log, guard: ctx.guard, flags: st.flags, opts: modeOpts(opts), runTrades: appr.trades });
  if (dm.mode === 'refuse') {
    if (dm.writes.guard) {
      ctx.saveGuard({ ...ctx.guard, ...dm.writes.guard });
      deps.out('wrote count_refused = true to guard.json (design line 165)');
    }
    throw refuse(`${dm.reason} (design line 165)`);
  }
  if (dm.mode !== 'baseline' && dm.mode !== 'replacement' && dm.mode !== 'passed') {
    throw refuse(`unexpected draw mode ${dm.mode}`);
  }
  deps.out(`draw mode = ${dm.mode}: ${dm.reason}`);

  const single = dm.mode !== 'passed';
  let modeWritten = false;
  let draws = 0;
  const notDrawable = [];
  for (;;) {
    if (!single && draws >= MAX_PASSED_DRAWS) {
      deps.out(`drew ${draws} trades, the per-command cap; run the draw command again for more (design line 165)`);
      break;
    }
    const target = single ? dm.writes.target : broker.nextDraw(ctx.log, runId, appr.trades);
    if (target === null) {
      deps.out(`run ${runId} has no trade left to draw`);
      break;
    }
    if (isObj(ctx.log.records) && Object.hasOwn(ctx.log.records, target.key)) {
      throw refuse(`record key ${target.key} already exists (design line 159)`);
    }
    const plan = tradePlan(target.trade, appr.info);

    if (!plan.drawable) {
      if (!modeWritten) {
        ctx.applyModeWrites(dm);
        modeWritten = true;
      }
      const rec = { ...ctx.baseRecord(target, plan, appr.snapshotSha, false), state: 'not drawable', written_at: deps.now() };
      ctx.saveLog({ ...ctx.log, records: { ...ctx.log.records, [target.key]: rec } });
      notDrawable.push(target.key);
      deps.out(`not drawable ${target.key}: target at or behind entry, no CDP call (design line 149)`);
      if (single) break;
      continue;
    }

    const status = await ctx.repaintCheck();
    const unverified = status.status !== 'verified';
    if (unverified && !opts.ackUnverified) {
      throw refuse(`repaint status is unverified (${status.reason}); drawing needs --ack-unverified (design lines 111, 164)`);
    }
    const preDrawIds = await ctx.shapeChecks(runId);
    ctx.checkFlags('before the draw');
    if (!arithmeticOk(target.trade, plan)) {
      throw refuse(`trade ${target.key}: entry, stop and target do not agree with the tick levels (design line 149)`);
    }
    if (!modeWritten) {
      ctx.applyModeWrites(dm);
      modeWritten = true;
    }

    const writtenAt = deps.now();
    const rec = {
      ...ctx.baseRecord(target, plan, appr.snapshotSha, unverified),
      deadline: writtenAt + DEADLINE_MS,
      pre_draw_ids: preDrawIds,
      written_at: writtenAt,
    };
    ctx.saveLog({ ...ctx.log, records: { ...ctx.log.records, [target.key]: rec } });
    const back = store.readLog();
    if (back.state !== 'ok' || !isObj(back.log.records) || !isObj(back.log.records[target.key]) || back.log.records[target.key].state !== 'pending') {
      throw refuse(`the pending record ${target.key} did not read back; no draw_trade runs (design line 158)`);
    }
    deps.out(`pending record ${target.key} written; deadline ${rec.deadline}`);
    ctx.checkFlags('immediately before draw_trade');

    const args = {
      RUN_ID: runId,
      UNVERIFIED: unverified,
      DEADLINE: rec.deadline,
      IS_LONG: plan.long,
      P1_TIME: plan.p1.time,
      P1_PRICE: plan.p1.price,
      P2_TIME: plan.p2.time,
      P2_PRICE: plan.p2.price,
      TEXT_TIME: plan.textTime,
      TEXT_PRICE: plan.textPrice,
      STOP_LEVEL: plan.stopLevel,
      PROFIT_LEVEL: plan.profitLevel,
    };
    if (!sameKeys(args, CALLER_KEYS.draw_trade)) throw refuse('draw_trade arguments do not match CALLER_KEYS.draw_trade');
    let res;
    try {
      res = await deps.run("draw_trade", args, "tab1");
    } catch (e) {
      throw refuse(`draw_trade threw ${e.code || 'E_UNKNOWN'}: ${e.message}; record ${target.key} stays pending for resolve (design line 161)`, e.code || 'E_DRAW');
    }
    draws += 1;
    ctx.handleResult(target.key, res, runId);
    if (single) break;
  }
  if (notDrawable.length > 0) deps.out(`not drawable: ${notDrawable.join(', ')}`);
  deps.out(`done: ${draws} trade(s) drawn for ${runId} in mode ${dm.mode}`);
  return 0;
}

export async function main(argv, deps) {
  let opts;
  try {
    opts = parseDrawArgs(argv);
  } catch (e) {
    deps.err(e.message);
    deps.err(DRAW_USAGE);
    return 2;
  }
  if (opts.brokerFailed) {
    try {
      const name = store.createBrokerFailedFlag();
      deps.out(`created flag file ${name}`);
      deps.out('broker_check = failed');
    } catch (e) {
      deps.err(`${e.code || 'E_FAILED'}: ${e.message}`);
      broker.printDigest(deps);
      return 1;
    }
    broker.printDigest(deps);
    return 0;
  }
  try {
    broker.preLockCheck();
  } catch (e) {
    deps.err(`${e.code || 'E_FAILED'}: ${e.message}`);
    broker.printDigest(deps);
    return 1;
  }
  try {
    return await broker.withLock(deps, () => drawLocked(opts, deps));
  } catch (e) {
    deps.err(`${e.code || 'E_FAILED'}: ${e.message}`);
    return 1;
  }
}
