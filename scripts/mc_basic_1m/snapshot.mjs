/**
 * snapshot command (design lines 6, 155, 163). Reads tab 1 and tab 2 through deps.run, keeps
 * closed bars only, validates the result with sim.prepare, clears "last shown" under the
 * trade-log lock, then writes the snapshot file. It only reads TradingView.
 * main(argv, deps) returns 0 when the snapshot is written, 1 when refused or failed, 2 on usage.
 */
import { FORMAT, prepare, sha256Rows } from './sim.mjs';
import * as store from './store.mjs';
import { colourScan } from './shapes.mjs';

const SYMBOL = 'CME_MINI:MES1!';
const M1 = 60;
const M15 = 900;
const USAGE = 'usage: snapshot [--forward]';

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

/** A read that returned an error code string (or any other non-array) is refused with its text. */
function readReply(result, label) {
  if (typeof result === 'string') return `${label} returned ${result}`;
  return null;
}

function checkTimedRows(rows, label) {
  if (!Array.isArray(rows)) throw fail('E_READ_SHAPE', `${label} is not an array`);
  for (const r of rows) {
    if (!Array.isArray(r) || typeof r[0] !== 'number' || !Number.isFinite(r[0])) {
      throw fail('E_READ_SHAPE', `${label} has a row without a numeric time`);
    }
  }
}

/**
 * MarketCipher_SR "Resolution" input (in_2, read as { v: "5" }) in seconds. Only a whole number of
 * minutes is accepted; "1D", "1W" and the like refuse, so the snapshot never falls back to 1m.
 */
function srPeriodSeconds(input, label) {
  const v = input && typeof input === 'object' ? input.v : undefined;
  if (typeof v !== 'string' || !/^[1-9][0-9]*$/.test(v)) {
    throw fail('E_READ_SHAPE', `${label} MarketCipher_SR Resolution is ${JSON.stringify(v)}; a whole number of minutes is needed`);
  }
  return Number(v) * M1;
}

/**
 * Validate one read_history result: [bars, b, sr, bPlots, srPlots, srResolution]. sr and the
 * MarketCipher_SR Resolution input are kept on tab 1 only.
 */
function checkHistory(result, label, wantSr) {
  if (!Array.isArray(result) || result.length !== 6) {
    throw fail('E_READ_SHAPE', `${label} did not return [bars, b, sr, bPlots, srPlots, srResolution]`);
  }
  const [bars, b, sr, bPlots, , srRes] = result;
  checkTimedRows(bars, `${label} bars`);
  checkTimedRows(b, `${label} MarketCipher_B rows`);
  if (wantSr) checkTimedRows(sr, `${label} MarketCipher_SR rows`);
  if (!Array.isArray(bPlots)) throw fail('E_READ_SHAPE', `${label} bPlots is not an array`);
  const srPeriodS = wantSr ? srPeriodSeconds(srRes, label) : null;
  return { bars, b, sr: wantSr ? sr : null, bPlots, srPeriodS };
}

/** Non-finite values become null, as the snapshot format requires. Holes count as undefined. */
const plain = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const cleanRow = (r) => Array.from(r, plain);

/**
 * Split bars into closed ones (open + step <= snapshot time) and forming ones. Study rows of a
 * forming bar are dropped with it; every other row is kept so sim.prepare can reject a row with no bar.
 */
function splitForming(bars, step, snapshotTime) {
  const closed = [];
  const forming = new Set();
  for (const r of bars) {
    if (r[0] + step <= snapshotTime) closed.push(r);
    else forming.add(r[0]);
  }
  return { closed, forming };
}

function studyWithoutForming(rows, forming) {
  return rows.filter((r) => !forming.has(r[0])).map(cleanRow);
}

function headerOf(bars) {
  if (bars.length === 0) return { first: null, last: null, count: 0 };
  return { first: bars[0][0], last: bars[bars.length - 1][0], count: bars.length };
}

/** Build the mc_basic_1m.snapshot.v1 object (sim.mjs header) from the two history reads. */
function buildSnapshot(h1, h15, snapshotTime) {
  const s1 = splitForming(h1.bars, M1, snapshotTime);
  const s15 = splitForming(h15.bars, M15, snapshotTime);
  const rows = {
    m1: {
      bars: s1.closed.map(cleanRow),
      b: studyWithoutForming(h1.b, s1.forming),
      sr: studyWithoutForming(h1.sr, s1.forming),
    },
    m15: {
      bars: s15.closed.map(cleanRow),
      b: studyWithoutForming(h15.b, s15.forming),
    },
  };
  const f1 = headerOf(rows.m1.bars);
  const f15 = headerOf(rows.m15.bars);
  return {
    format: FORMAT,
    snapshot_time: snapshotTime,
    symbol: SYMBOL,
    first_1m: f1.first,
    last_1m: f1.last,
    count_1m: f1.count,
    first_15m: f15.first,
    last_15m: f15.last,
    count_15m: f15.count,
    plots_b_1m: h1.bPlots.map((p) => ({ id: p && p.id, type: p && p.type })),
    plots_b_15m: h15.bPlots.map((p) => ({ id: p && p.id, type: p && p.type })),
    sr_period_s: h1.srPeriodS,
    sha256: sha256Rows(rows),
    rows,
  };
}

/**
 * Clear "last shown" in the trade log so an approval given before this snapshot stops working.
 * A missing log has nothing to clear. A corrupt log refuses, so no new snapshot sits over it.
 */
function clearLastShown() {
  const before = store.readLog();
  if (before.state === 'missing') return;
  if (before.state === 'corrupt') {
    throw fail('E_LOG_CORRUPT', 'trade_log.json does not parse; last shown cannot be cleared, so no snapshot was written');
  }
  store.takeLogLock();
  try {
    const current = store.readLog();
    if (current.state === 'missing') return;
    if (current.state === 'corrupt') {
      throw fail('E_LOG_CORRUPT', 'trade_log.json does not parse; last shown cannot be cleared, so no snapshot was written');
    }
    if (current.log.last_shown === null || current.log.last_shown === undefined) return;
    store.writeLog({ ...current.log, last_shown: null });
  } finally {
    store.releaseLogLock();
  }
}

/** Linecolour format of one shape, for the format probe (design line 155). */
function colourFormat(raw) {
  if (typeof raw !== 'string') return 'missing';
  if (/^#[0-9a-fA-F]{6}$/.test(raw)) return 'hex';
  if (/^rgba\(/i.test(raw)) return 'rgba';
  if (/^rgb\(/i.test(raw)) return 'rgb';
  return 'other';
}

function printColours(deps, shapes, log, guard) {
  const counts = {};
  for (const s of shapes) {
    const f = colourFormat(s && s.linecolor);
    counts[f] = (counts[f] || 0) + 1;
    if (f !== 'hex') deps.out(`colour format ${f}: shape ${s && s.id} linecolor ${JSON.stringify(s && s.linecolor)}`);
  }
  const summary = Object.keys(counts).sort().map((k) => `${k} ${counts[k]}`).join(', ') || 'no shapes';
  deps.out(`colour formats on tab 1: ${summary}`);
  // runId null: no position counts as the run's own, so every run-colour shape is listed.
  const scan = colourScan({ shapes, log, guard, runId: null });
  deps.out(`colour scan (all runs): ${scan.blocking.length} shape(s) flagged, ${scan.unknown.length} unknown colour, ${scan.labels.length} unstored BACKTEST label`);
  for (const s of scan.blocking) {
    deps.out(`  shape ${s.id} name ${JSON.stringify(s.name)} linecolor ${JSON.stringify(s.linecolor)} reasons: ${s.reasons.join(', ')}`);
  }
}

/**
 * Entry point. argv is the arguments after the command name; --forward writes the forward snapshot.
 */
export async function main(argv, deps) {
  if (!Array.isArray(argv) || !argv.every((a) => a === '--forward')) {
    deps.err(USAGE);
    return 2;
  }
  const kind = argv.includes('--forward') ? 'forward' : 'current';

  try {
    const snapshotTime = Math.floor(deps.now() / 1000);

    const r1 = await deps.run('read_history', {}, 'tab1');
    const bad1 = readReply(r1, 'read_history tab1');
    if (bad1) { deps.err(bad1); return 1; }
    const r2 = await deps.run('read_history', {}, 'tab2');
    const bad2 = readReply(r2, 'read_history tab2');
    if (bad2) { deps.err(bad2); return 1; }
    const rs = await deps.run('read_shapes', {}, 'tab1');
    const badS = readReply(rs, 'read_shapes tab1');
    if (badS) { deps.err(badS); return 1; }

    const h1 = checkHistory(r1, 'read_history tab1', true);
    const h15 = checkHistory(r2, 'read_history tab2', false);
    if (!Array.isArray(rs)) throw fail('E_READ_SHAPE', 'read_shapes tab1 did not return an array');

    const obj = buildSnapshot(h1, h15, snapshotTime);
    const info = prepare(obj).info;

    clearLastShown();
    const written = store.writeSnapshot(obj, kind);

    deps.out(`snapshot ${kind} written: ${written.file}`);
    deps.out(`snapshot_time ${snapshotTime}  id ${info.id}  sha256 ${info.sha256}`);
    deps.out(`file sha256 ${written.sha256}`);
    deps.out(`1m rows ${info.count_1m} (${info.first_1m} to ${info.last_1m}), 15m rows ${info.count_15m} (${info.first_15m} to ${info.last_15m})`);
    deps.out(`first eligible row F at ${info.fTime} (index ${info.F}); 1m gaps ${info.gaps1m.length}, 15m gaps ${info.gaps15m.length}, empty 15m buckets ${info.emptyBuckets15m.length}`);
    for (const w of info.warnings) deps.out(`warning: ${w}`);

    const log = store.readLog();
    const guard = store.readGuard();
    printColours(deps, rs, log.state === 'ok' ? log.log : null, guard.state === 'ok' ? guard.guard : null);
    return 0;
  } catch (e) {
    const code = e && typeof e.code === 'string' ? e.code : 'E_ERROR';
    deps.err(`${code}: ${e && e.message ? e.message : String(e)}`);
    return 1;
  }
}
