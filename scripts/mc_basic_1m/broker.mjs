/**
 * First-draw broker check (design_v14 lines 158, 165, 166): pure gate functions, the guard-state
 * handling every lock-holding draw shares, and the broker-reset command.
 * Usage: broker-reset --expect-guard <digest>
 * Exit: 0 when reset, 1 when refused or failed, 2 for usage.
 */
import { createHash } from 'node:crypto';
import * as store from './store.mjs';

export const BROKER_RESET_USAGE = 'usage: broker-reset --expect-guard <digest>';
export const DIGEST_RE = /^([0-9a-f]{8}|missing)\+\d+$/;

/* ---------- small helpers ---------- */

function isObj(x) {
  return x !== null && typeof x === 'object' && !Array.isArray(x);
}

function arr(x) {
  return Array.isArray(x) ? x : [];
}

function intOr0(x) {
  return Number.isInteger(x) && x >= 0 ? x : 0;
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

export function refusal(message, code = 'E_REFUSED') {
  const e = new Error(message);
  e.code = code;
  return e;
}

export function usageError(message) {
  const e = new Error(message);
  e.code = 'E_USAGE';
  return e;
}

/** Guard digest from the guard bytes read once and the flag list read once (design line 166). */
export function digestOf(bytes, flagCount) {
  const part = bytes === null || bytes === undefined ? 'missing' : createHash('sha256').update(bytes).digest('hex').slice(0, 8);
  return `${part}+${flagCount}`;
}

/** The guard a fresh state stands for: broker_check "none", nothing stored (design line 166). */
export function freshGuard() {
  return {
    broker_check: 'none',
    baseline_count: null,
    probe_key: null,
    count_refused: false,
    reset_count: 0,
    colour_ok: [],
    consumed_flags: [],
    draw_mismatches: [],
    lost_at: null,
    reset_stamps: [],
  };
}

/* ---------- pure gate functions ---------- */

/** reset_count from both files, the higher value (design line 165). */
export function resetCount(log, guard) {
  return Math.max(intOr0(isObj(log) ? log.reset_count : 0), intOr0(isObj(guard) ? guard.reset_count : 0));
}

/** Flag names not listed in consumed_flags of both the log and guard.json (design line 165). */
export function unconsumedFlags(flags, log, guard) {
  const inLog = new Set(arr(isObj(log) ? log.consumed_flags : null));
  const inGuard = new Set(arr(isObj(guard) ? guard.consumed_flags : null));
  return arr(flags).filter((f) => !(inLog.has(f) && inGuard.has(f)));
}

/** Probe entries of the current epoch, in log order. */
export function epochProbes(log, guard) {
  const rc = resetCount(log, guard);
  return arr(isObj(log) ? log.probes : null).filter((p) => isObj(p) && p.epoch === rc);
}

/** The log's current probe key: the last probe entry of the current epoch, or null. */
export function logProbeKey(log, guard) {
  const list = epochProbes(log, guard);
  return list.length === 0 ? null : list[list.length - 1].key;
}

function logIsEmpty(log) {
  return (
    isObj(log) &&
    arr(log.probes).length === 0 &&
    (!isObj(log.records) || Object.keys(log.records).length === 0) &&
    intOr0(log.reset_count) === 0
  );
}

const BROKER_STATES = ['none', 'pending', 'passed', 'lost'];

function guardShapeOk(g) {
  return (
    isObj(g) &&
    BROKER_STATES.includes(g.broker_check) &&
    Number.isInteger(g.reset_count) &&
    Array.isArray(g.colour_ok) &&
    Array.isArray(g.consumed_flags) &&
    Array.isArray(g.draw_mismatches) &&
    Array.isArray(g.reset_stamps) &&
    typeof g.count_refused === 'boolean' &&
    (g.probe_key === null || typeof g.probe_key === 'string')
  );
}

/**
 * Classifies guard.json (design lines 158, 166). guardRead and logRead are the store read results.
 * fresh: guard missing, no flag file, no log.bak, and the log missing or holding no entry.
 * ok: parses and agrees with the log. lost: parses but reset_count is lower than the log's, its
 * probe key is not one of the log's probe entries, or its fields are malformed. corrupt: does not
 * parse. missing: missing and not fresh.
 * recorderFiles only adds to the reason: surviving recorder files do not stop a fresh state
 * (the residual risk design line 166 states).
 */
export function classifyGuard({ guardRead, logRead, logBak, flags, recorderFiles }) {
  const log = logRead && logRead.state === 'ok' ? logRead.log : null;
  if (!guardRead || guardRead.state === 'corrupt') {
    return { kind: 'corrupt', reason: 'guard.json does not parse' };
  }
  if (guardRead.state === 'missing') {
    const logEmpty = logRead && (logRead.state === 'missing' || (logRead.state === 'ok' && logIsEmpty(log)));
    if (arr(flags).length === 0 && !logBak && logEmpty) {
      const note = recorderFiles ? ' (recorder files exist; residual risk of design line 166)' : '';
      return { kind: 'fresh', reason: `fresh state: no guard.json, no flag file, no log.bak, no log entry${note}` };
    }
    return { kind: 'missing', reason: 'guard.json is missing and the state is not fresh' };
  }
  const g = guardRead.guard;
  if (!guardShapeOk(g)) return { kind: 'lost', reason: 'guard.json parses but its fields are malformed' };
  if (log !== null) {
    if (g.reset_count < intOr0(log.reset_count)) {
      return { kind: 'lost', reason: `guard.json reset_count ${g.reset_count} is lower than the log's ${log.reset_count}` };
    }
    if (g.probe_key !== null && !arr(log.probes).some((p) => isObj(p) && p.key === g.probe_key)) {
      return { kind: 'lost', reason: `guard.json probe key ${g.probe_key} is not one of the log's probe entries` };
    }
  }
  return { kind: 'ok', reason: 'guard.json parses and agrees with the log' };
}

/** The guard written on a lost, corrupt or missing guard.json (design line 166). */
export function buildLostGuard({ log, oldGuard, now }) {
  const old = isObj(oldGuard) ? oldGuard : {};
  return {
    broker_check: 'lost',
    baseline_count: null,
    probe_key: null,
    count_refused: false,
    reset_count: resetCount(log, old),
    colour_ok: union(isObj(log) ? log.colour_ok : null, old.colour_ok),
    consumed_flags: arr(old.consumed_flags).slice(),
    draw_mismatches: arr(old.draw_mismatches).slice(),
    lost_at: now,
    reset_stamps: arr(old.reset_stamps).slice(),
  };
}

/** True when a record exists and its trade sits at (cycle, index, entryTime). */
function recordsOfRun(log, runId) {
  if (!isObj(log) || !isObj(log.records)) return [];
  return Object.values(log.records).filter((r) => isObj(r) && r.run === runId);
}

export function recordKey(run, cycle, index, entryTime, attempt) {
  return `${run}:${cycle}:${index}:${entryTime}:${attempt}`;
}

/** The run's current draw cycle (design line 159): 1 with no records, +1 after a clear. */
export function currentCycle(log, runId) {
  const recs = recordsOfRun(log, runId);
  if (recs.length === 0) return 1;
  const maxCycle = Math.max(...recs.map((r) => (Number.isInteger(r.cycle) ? r.cycle : 1)));
  const cleared = recs.some((r) => r.cycle === maxCycle && r.state === 'cleared');
  return cleared ? maxCycle + 1 : maxCycle;
}

function latestFor(log, runId, cycle, index, entryTime) {
  let best = null;
  for (const r of recordsOfRun(log, runId)) {
    if (r.cycle !== cycle || r.index !== index || r.entry_time !== entryTime) continue;
    if (best === null || r.attempt > best.attempt) best = r;
  }
  return best;
}

/**
 * The run's next trade by the normal draw order (design line 165): the first trade in run order
 * with no record in the current cycle, or whose latest record in the cycle is "not drawn" (next
 * attempt). Returns { index, trade, cycle, attempt, key } or null when none is left.
 */
export function nextDraw(log, runId, trades) {
  const cycle = currentCycle(log, runId);
  for (let index = 0; index < arr(trades).length; index++) {
    const trade = trades[index];
    const latest = latestFor(log, runId, cycle, index, trade.entryTime);
    let attempt;
    if (latest === null) attempt = 1;
    else if (latest.state === 'not drawn') attempt = latest.attempt + 1;
    else continue;
    return { index, trade, cycle, attempt, key: recordKey(runId, cycle, index, trade.entryTime, attempt) };
  }
  return null;
}

function replaceable(rec) {
  return (rec.state === 'not drawn' && !rec.seen_position) || rec.state === 'not drawable';
}

function checkable(rec) {
  return rec.state === 'drawn' || rec.state === 'cleared' || (rec.state === 'not drawn' && rec.seen_position === true);
}

/**
 * The replacement probe (design line 165): the same trade with the next attempt if the probe is
 * "not drawn", else the next trade in run order after it with no record in the cycle. Returns the
 * target or null when none is left.
 */
export function replacementTarget(log, probe, trades) {
  const list = arr(trades);
  if (probe.state === 'not drawn') {
    const trade = list[probe.index];
    if (!trade || trade.entryTime !== probe.entry_time) return null;
    const attempt = probe.attempt + 1;
    return { index: probe.index, trade, cycle: probe.cycle, attempt, key: recordKey(probe.run, probe.cycle, probe.index, trade.entryTime, attempt) };
  }
  for (let index = probe.index + 1; index < list.length; index++) {
    const trade = list[index];
    if (latestFor(log, probe.run, probe.cycle, index, trade.entryTime) !== null) continue;
    return { index, trade, cycle: probe.cycle, attempt: 1, key: recordKey(probe.run, probe.cycle, index, trade.entryTime, 1) };
  }
  return null;
}

/**
 * The broker gate for one draw command (design line 165). guard is the parsed guard (or
 * freshGuard() in the fresh state). opts: { runId, brokerBaseline, probeRecheck, brokerChecked,
 * panelOk, allowProbe } (counts are integers or null). runTrades: the trades of opts.runId from
 * the current snapshot (null in checked mode).
 * Returns { mode, reason, writes }. writes: { probeEntry, guard, target } for baseline and
 * replacement, { guard } for checked and for a count_refused refusal, {} otherwise.
 */
export function drawMode({ log, guard, flags, opts, runTrades }) {
  const refuse = (reason, writes = {}) => ({ mode: 'refuse', reason, writes });
  const o = opts || {};
  const has = (v) => v !== null && v !== undefined;
  if (!isObj(guard)) return refuse('guard.json is not readable');
  const open = unconsumedFlags(flags, log, guard);
  if (open.length > 0) return refuse(`broker_check failed: unconsumed flag file ${open.join(', ')}; broker-reset is the exit`);
  if (guard.broker_check === 'lost') return refuse('broker_check is lost; broker-reset is the exit');

  const rc = resetCount(log, guard);
  if (rc >= 2 && (has(o.brokerBaseline) || has(o.probeRecheck)) && o.allowProbe !== rc) {
    return refuse(`reset_count is ${rc}; --broker-baseline and --probe-recheck need --allow-probe ${rc}`);
  }
  if (has(o.probeRecheck) && has(o.brokerChecked)) return refuse('--probe-recheck and --broker-checked cannot be combined');

  const entries = epochProbes(log, guard);
  const logKey = entries.length === 0 ? null : entries[entries.length - 1].key;
  if (logKey !== guard.probe_key) {
    return refuse(`the log's probe key ${logKey} differs from guard.json's ${guard.probe_key}; broker-reset is the exit`);
  }

  if (guard.broker_check === 'none') {
    if (has(o.probeRecheck) || has(o.brokerChecked)) return refuse('broker_check is none; --probe-recheck and --broker-checked need a pending probe');
    if (o.panelOk) return refuse('broker_check is none; --panel-ok applies only after the probe passed');
    if (!has(o.brokerBaseline)) return refuse('broker_check is none; the first draw needs --broker-baseline <count>');
    if (entries.length > 0) return refuse(`the log holds a probe entry for reset_count ${rc}; broker-reset is the exit`);
    const target = nextDraw(log, o.runId, runTrades);
    if (target === null) return refuse(`run ${o.runId} has no trade left to draw`);
    return {
      mode: 'baseline',
      reason: `baseline count ${o.brokerBaseline}; probe ${target.key}`,
      writes: {
        probeEntry: { epoch: rc, key: target.key },
        guard: { broker_check: 'pending', baseline_count: o.brokerBaseline, probe_key: target.key },
        target,
      },
    };
  }

  if (guard.broker_check === 'pending') {
    if (has(o.brokerBaseline)) return refuse('broker_check is pending; --broker-baseline is refused');
    if (o.panelOk) return refuse('broker_check is pending; --panel-ok applies only after the probe passed');
    const key = guard.probe_key;
    if (key === null) return refuse('broker_check is pending with no probe key; broker-reset is the exit');
    const probe = isObj(log) && isObj(log.records) ? log.records[key] : undefined;
    if (!isObj(probe)) return refuse(`probe key ${key} has no record; broker-reset is the exit`);
    const count = has(o.probeRecheck) ? o.probeRecheck : o.brokerChecked;
    if (has(count) && count !== guard.baseline_count) {
      const writes = guard.count_refused ? {} : { guard: { count_refused: true } };
      return refuse(`count ${count} differs from the baseline count ${guard.baseline_count}; count_refused is set and broker-reset is the exit`, writes);
    }
    if (guard.count_refused) return refuse('count_refused is true; broker-reset is the exit');
    if (replaceable(probe)) {
      if (has(o.brokerChecked)) return refuse(`probe ${key} is "${probe.state}"; it needs --probe-recheck, not --broker-checked`);
      if (!has(o.probeRecheck)) return refuse(`probe ${key} is "${probe.state}"; a replacement probe needs --probe-recheck <count>`);
      if (entries.length !== 1) return refuse(`the epoch holds ${entries.length} probe entries; broker-reset is the exit`);
      if (o.runId !== probe.run) return refuse(`the replacement probe belongs to run ${probe.run}, not ${o.runId}`);
      const target = replacementTarget(log, probe, runTrades);
      if (target === null) return refuse(`no trade is left to replace probe ${key}; broker-reset is the exit`);
      return {
        mode: 'replacement',
        reason: `replacement probe ${target.key} for ${key}`,
        writes: { probeEntry: { epoch: rc, key: target.key }, guard: { probe_key: target.key }, target },
      };
    }
    if (checkable(probe)) {
      if (has(o.probeRecheck)) return refuse(`probe ${key} is "${probe.state}"; it needs --broker-checked, not --probe-recheck`);
      if (!has(o.brokerChecked)) return refuse(`probe ${key} is "${probe.state}"; no draw runs until --broker-checked <count>`);
      return { mode: 'checked', reason: `probe ${key} checked; broker_check passed`, writes: { guard: { broker_check: 'passed' } } };
    }
    return refuse(`probe ${key} is in state "${probe.state}"; resolve settles a pending probe, otherwise broker-reset is the exit`);
  }

  if (guard.broker_check === 'passed') {
    if (has(o.brokerBaseline) || has(o.probeRecheck) || has(o.brokerChecked)) {
      return refuse('broker_check is passed; --broker-baseline, --probe-recheck and --broker-checked are refused');
    }
    if (!o.panelOk) return refuse('broker_check is passed; every draw needs --panel-ok');
    return { mode: 'passed', reason: 'broker_check passed; up to 10 trades', writes: {} };
  }
  return refuse(`unknown broker_check ${String(guard.broker_check)}`);
}

/**
 * broker-reset's allow list (design line 165). replacementLeft: whether a trade is left to replace
 * a replaceable probe (the caller computes it from the current snapshot; true when unknown).
 */
export function brokerResetAllowed({ log, guard, flags, logRead, logBak, replacementLeft = true }) {
  const g = isObj(guard) ? guard : null;
  const records = isObj(log) && isObj(log.records) ? log.records : {};
  if (unconsumedFlags(flags, log, g).length > 0) return { ok: true, reason: 'an unconsumed flag file exists' };
  if (g !== null && g.broker_check === 'lost') return { ok: true, reason: 'broker_check is lost' };
  if (g !== null && logRead && logRead.state === 'missing' && !logBak) {
    return { ok: true, reason: 'the log and log.bak are both missing while guard.json exists' };
  }
  if (g === null) return { ok: false, reason: 'no guard.json and nothing to reset' };
  const entries = epochProbes(log, g);
  const logKey = entries.length === 0 ? null : entries[entries.length - 1].key;
  if (g.broker_check === 'none' && entries.length > 0) {
    return { ok: true, reason: 'broker_check is none while the log holds a probe entry for the current reset_count' };
  }
  for (const k of [g.probe_key, logKey]) {
    if (k !== null && !Object.hasOwn(records, k)) return { ok: true, reason: `probe key ${k} has no record` };
  }
  if (logKey !== g.probe_key) return { ok: true, reason: "the log and guard.json disagree about the probe key" };
  if (g.count_refused === true) return { ok: true, reason: 'count_refused is true' };
  if (g.broker_check === 'pending' && g.probe_key !== null) {
    const probe = records[g.probe_key];
    if (isObj(probe) && replaceable(probe) && (entries.length >= 2 || !replacementLeft)) {
      return { ok: true, reason: `probe ${g.probe_key} is "${probe.state}" with ${entries.length} probe entries and ${replacementLeft ? 'a' : 'no'} trade left` };
    }
  }
  return { ok: false, reason: `nothing to reset (broker_check ${g.broker_check})` };
}

/* ---------- shared lock-holding steps ---------- */

/** Parses flags by spec: { '--name': 'string'|'int'|'bool'|'list' }. Throws E_USAGE. */
export function parseFlags(argv, spec) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!Object.hasOwn(spec, a)) throw usageError(`unknown argument ${a}`);
    if (Object.hasOwn(opts, a)) throw usageError(`${a} given twice`);
    const kind = spec[a];
    if (kind === 'bool') {
      opts[a] = true;
      continue;
    }
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw usageError(`${a} needs a value`);
    i++;
    if (kind === 'int') {
      if (!/^\d{1,9}$/.test(v)) throw usageError(`${a} needs a non-negative integer`);
      opts[a] = Number(v);
    } else if (kind === 'list') {
      const ids = v.split(',').map((s) => s.trim());
      if (ids.some((s) => s.length === 0)) throw usageError(`${a} needs a comma-separated list of IDs`);
      opts[a] = ids;
    } else {
      opts[a] = v;
    }
  }
  return opts;
}

/** Pre-lock refusals of design line 158. Throws a refusal. Returns the log read. */
export function preLockCheck() {
  const logRead = store.readLog();
  if (logRead.state === 'corrupt') throw refusal('trade_log.json does not parse; restore log.bak by hand (design line 158)');
  if (logRead.state === 'missing' && store.logBakExists()) {
    throw refusal('trade_log.json is missing while log.bak exists; the exit is a manual restore of log.bak (design line 158)');
  }
  if (logRead.state === 'missing' && store.logLockExists()) {
    throw refusal('trade_log.json is missing while trade.lock exists (design line 158)');
  }
  return logRead;
}

/**
 * Runs under the trade-log lock, right after taking it (design line 166): lists the flag files
 * once, reads both files, writes the "lost" guard when guard.json is lost, corrupt or missing
 * (then refuses), and compares the digest with --expect-guard. Returns
 * { logRead, logBak, guardRead, flags, kind, guard, log, digest }.
 */
export function lockedGuardGate({ expectGuard, now, out }) {
  const flags = store.listFlagFiles();
  const logRead = store.readLog();
  if (logRead.state === 'corrupt') throw refusal('trade_log.json does not parse (design line 158)');
  const logBak = store.logBakExists();
  if (logRead.state === 'missing' && logBak) throw refusal('trade_log.json is missing while log.bak exists (design line 158)');
  const guardRead = store.readGuard();
  const cls = classifyGuard({ guardRead, logRead, logBak, flags, recorderFiles: store.recorderFilesExist() });
  const log = logRead.state === 'ok' ? logRead.log : null;
  if (cls.kind === 'lost' || cls.kind === 'corrupt' || cls.kind === 'missing') {
    let copy = null;
    if (cls.kind === 'corrupt') copy = store.copyGuardCorrupt();
    const oldGuard = cls.kind === 'lost' && isObj(guardRead.guard) ? guardRead.guard : null;
    store.writeGuard(buildLostGuard({ log, oldGuard, now }));
    if (copy !== null) out(`copied the unparseable guard.json to ${copy}`);
    out(`guard.json ${cls.kind}: ${cls.reason}; wrote broker_check "lost" (design line 166)`);
    throw refusal('broker_check is lost; broker-reset is the exit (design line 166)', 'E_GUARD_LOST');
  }
  const digest = digestOf(guardRead.bytes, flags.length);
  if (digest !== expectGuard) {
    throw refusal(`guard digest on disk is ${digest}, not ${expectGuard} (design line 166)`, 'E_DIGEST');
  }
  const guard = cls.kind === 'fresh' ? freshGuard() : guardRead.guard;
  const open = unconsumedFlags(flags, log, guard);
  out(`broker_check = ${open.length > 0 ? 'failed' : guard.broker_check}`);
  out(`probe_key = ${guard.probe_key === null ? 'none' : guard.probe_key}`);
  out(`epoch probe entries = ${epochProbes(log, guard).length} (reset_count ${resetCount(log, guard)})`);
  if (cls.kind === 'fresh') out(cls.reason);
  return { logRead, logBak, guardRead, flags, kind: cls.kind, guard, log, digest };
}

/** Prints the guard digest; a read failure is reported, not thrown. */
export function printDigest(deps) {
  try {
    deps.out(`guard_digest = ${store.guardDigest()}`);
  } catch (e) {
    deps.err(`guard_digest unavailable: ${e.message}`);
  }
}

/** Takes the trade-log lock, runs body, releases the lock and prints the digest on every exit. */
export async function withLock(deps, body) {
  let locked = false;
  try {
    store.takeLogLock();
    locked = true;
    return await body();
  } finally {
    if (locked) {
      try {
        store.releaseLogLock();
      } catch (e) {
        deps.err(`could not release trade.lock: ${e.message}`);
      }
    }
    printDigest(deps);
  }
}

/* ---------- broker-reset command ---------- */

export async function main(argv, deps) {
  let opts;
  try {
    opts = parseFlags(argv, { '--expect-guard': 'string' });
    if (!Object.hasOwn(opts, '--expect-guard')) throw usageError('--expect-guard <digest> is required');
    if (!DIGEST_RE.test(opts['--expect-guard'])) throw usageError('--expect-guard needs a digest such as 3fa9c01e+1 or missing+0');
  } catch (e) {
    deps.err(e.message);
    deps.err(BROKER_RESET_USAGE);
    return 2;
  }
  try {
    preLockCheck();
  } catch (e) {
    deps.err(`${e.code || 'E_FAILED'}: ${e.message}`);
    printDigest(deps);
    return 1;
  }
  try {
    return await withLock(deps, async () => {
      const now = deps.now();
      const st = lockedGuardGate({ expectGuard: opts['--expect-guard'], now, out: deps.out });
      const guard = st.kind === 'fresh' ? null : st.guard;
      const allowed = brokerResetAllowed({
        log: st.log,
        guard,
        flags: st.flags,
        logRead: st.logRead,
        logBak: st.logBak,
        replacementLeft: true,
      });
      if (!allowed.ok) throw refusal(`broker-reset refused: ${allowed.reason} (design line 165)`);
      deps.out(`broker-reset allowed: ${allowed.reason}`);
      if (st.logRead.state === 'missing') {
        store.createEmptyLog();
        deps.out('created an empty trade log (design line 165)');
      }
      const logNow = store.readLog();
      if (logNow.state !== 'ok') throw refusal(`trade_log.json is ${logNow.state} after the reset start`);
      const log = logNow.log;
      const rc = resetCount(log, guard) + 1;
      const consumed = union(log.consumed_flags, guard ? guard.consumed_flags : [], st.flags);
      store.writeLog({ ...log, reset_count: rc, consumed_flags: consumed });
      const old = guard || {};
      store.writeGuard({
        broker_check: 'none',
        baseline_count: null,
        probe_key: null,
        count_refused: false,
        reset_count: rc,
        colour_ok: union(log.colour_ok, old.colour_ok),
        consumed_flags: consumed,
        draw_mismatches: arr(old.draw_mismatches).slice(),
        lost_at: old.lost_at === undefined ? null : old.lost_at,
        reset_stamps: [...arr(old.reset_stamps), now],
      });
      deps.out(`reset_count = ${rc}; broker_check = none; consumed ${st.flags.length} flag file(s)`);
      return 0;
    });
  } catch (e) {
    deps.err(`${e.code || 'E_FAILED'}: ${e.message}`);
    return 1;
  }
}
