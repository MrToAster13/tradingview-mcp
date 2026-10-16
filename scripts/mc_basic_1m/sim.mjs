/**
 * mc_basic_1m offline simulator (design v14: Definitions through Report per run).
 * Pure: no CDP, no files, no clock. Input is a parsed snapshot object; output is
 * the trade list and per-run report data for runs HTF-a, HTF-b and HTF-c.
 *
 * Snapshot format (mc_basic_1m.snapshot.v1). The design fixes the content but
 * not the layout; this is the layout the snapshot writer must produce.
 *   {
 *     "format": "mc_basic_1m.snapshot.v1",
 *     "snapshot_time": <unix s, recorded before the reads>,
 *     "symbol": "CME_MINI:MES1!",
 *     "first_1m", "last_1m", "count_1m", "first_15m", "last_15m", "count_15m",
 *     "plots_b_1m":  [{ "id", "type" }, ...]   metaInfo().plots of tab 1's MarketCipher_B
 *     "plots_b_15m": [{ "id", "type" }, ...]   the same from tab 2
 *     "inputs_b_1m", "inputs_b_15m":           encrypted input values (any JSON), compared as JSON text
 *     "sr_period_s": optional, tab 1's MarketCipher_SR "Resolution" input in seconds (60 when absent)
 *     "sha256": hex SHA-256 of the UTF-8 bytes of JSON.stringify(rows),
 *     "rows": {
 *       "m1":  { "bars": [[t,o,h,l,c,v], ...], "b": [[t,p1..pN], ...], "sr": [[t,p1..pM], ...] },
 *       "m15": { "bars": [[t,o,h,l,c,v], ...], "b": [[t,p1..pN], ...] }
 *     }
 *   }
 * Each row array is the CDP valueAt() array as read, so plot k sits at index k.
 * Non-finite plot values are stored as null. Series join by time, never by index.
 *
 * Prices are handled internally as integer quarter points ("Q": price * 4), and
 * dollar amounts as integer quarter dollars ("nq": Net $ * 4), so no float
 * rounding enters the accounting.
 */
import { createHash } from 'node:crypto';

export const FORMAT = 'mc_basic_1m.snapshot.v1';
export const RUN_IDS = Object.freeze(['HTF-a', 'HTF-b', 'HTF-c']);
export const RUN_RULES = Object.freeze({
  'HTF-a': 'Rising(15m Mny Flow)',
  'HTF-b': 'at least 2 of Rising(15m Mny Flow), Rising(15m Blue Wave), Rising(15m RSI)',
  'HTF-c': 'all 3 of Rising(15m Mny Flow), Rising(15m Blue Wave), Rising(15m RSI)',
});
/** Run rules under the next and next15 target modes, where Mny Flow is judged by its trend. */
export const RUN_RULES_TREND = Object.freeze({
  'HTF-a': 'Avg4(15m Mny Flow)',
  'HTF-b': 'at least 2 of Avg4(15m Mny Flow), Rising(15m Blue Wave), Rising(15m RSI)',
  'HTF-c': 'all 3 of Avg4(15m Mny Flow), Rising(15m Blue Wave), Rising(15m RSI)',
});

const PLOT = Object.freeze({ BLUE_WAVE: 2, MNY_FLOW: 4, BUY: 6, CROSS_DOWN: 8, RSI: 15, STO_RSI: 16 });
const SR_PLOT = Object.freeze({ RESISTANCE: 4, SUPPORT: 5 });
const B_MIN_ENTRIES = 17;  // at least 16 plots plus time
const SR_MIN_ENTRIES = 6;  // at least 5 plots plus time
const M1 = 60;
const M15 = 900;
const WARMUP_1M_ROWS = 300;   // F index >= 300 (coordinator change to design line 7)
const WARMUP_15M_ROWS = 100;  // F's last closed 15m row index >= 100
const STOP_MIN_Q = 8;         // 2 points
const STOP_MAX_Q = 32;        // 8 points
const FEES_NQ = 12;           // $3 round trip in quarter dollars
const MF_AVG_BARS = 4;        // Avg4: 4-bar simple average of closed 15m Mny Flow values
const MIN_RR_NUM = 3;         // next and next15 modes: reward / risk >= 3/2
const MIN_RR_DEN = 2;
const ROLL_MONTHS = Object.freeze([3, 6, 9, 12]);
/**
 * Target modes: 'sr' = nearest confirmed Cipher Resistance/Support (default); '1R' = E plus or minus D;
 * 'srsl' = the 'sr' target, with the stop 1 tick beyond the nearest confirmed opposite Cipher level
 * that is 2 to 8 points from E (no clamp; no such level is outcome no_stop).
 * 'band' = Cipher Resistance and Support as plotted on the trigger row: a long targets Resistance
 * and stops 1 tick below Support, a short targets Support and stops 1 tick above Resistance
 * (user rule, 2026-10-16). No clamp. E outside Support < E < Resistance, or either level
 * missing or off the 0.25 grid, is outcome outside_band.
 * 'next' = the band stop, with the target at the nearest past Cipher line beyond E: any Resistance or
 * Support value plotted on a row at or before the trigger row. A reward under 1.5 times the risk is
 * outcome under_rr; no line beyond E is no_target. 'next15' is the same, except the target is the
 * nearest past line at least 1.5R from E (under_rr when there is none). Both modes judge 15m Mny Flow
 * by Avg4 instead of a one-bar change (user rule, 2026-10-16).
 */
export const TARGET_MODES = Object.freeze(['sr', '1R', 'srsl', 'band', 'next', 'next15']);
const NEXT_MODES = Object.freeze(['next', 'next15']);
const bandStop = (mode) => mode === 'band' || NEXT_MODES.includes(mode);
const OUTCOMES = Object.freeze([
  'ignored_position', 'ignored_window', 'cancelled', 'expired', 'filtered', 'insufficient', 'no_target', 'no_stop',
  'outside_band', 'under_rr', 'closed', 'open',
]);

function abort(message) {
  const e = new Error(`snapshot aborted: ${message}`);
  e.code = 'E_SNAPSHOT_ABORT';
  throw e;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const finite = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// ── Eastern time ─────────────────────────────────────────────────────────

const ET_FMT = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', hourCycle: 'h23', weekday: 'short',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

/** Unix seconds → America/New_York calendar parts. */
export function etParts(t) {
  const parts = {};
  for (const p of ET_FMT.formatToParts(new Date(t * 1000))) parts[p.type] = p.value;
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: Number(parts.hour), minute: Number(parts.minute), weekday: parts.weekday,
  };
}

/** Unix seconds → 'YYYY-MM-DD HH:MM ET'. */
export function etLabel(t) {
  const p = etParts(t);
  const two = (x) => String(x).padStart(2, '0');
  return `${p.year}-${two(p.month)}-${two(p.day)} ${two(p.hour)}:${two(p.minute)} ET`;
}

const dayNumber = (p) => Date.UTC(p.year, p.month - 1, p.day) / 86400000;

/**
 * Is the gap between consecutive rows at a and b the daily halt or the weekend
 * close? lastMinute is 59 for 1m rows and 45 for 15m rows (design line 33).
 */
export function isScheduledClose(a, b, lastMinute) {
  const pa = etParts(a);
  const pb = etParts(b);
  if (pa.hour !== 16 || pa.minute !== lastMinute || pb.hour !== 18 || pb.minute !== 0) return false;
  const days = dayNumber(pb) - dayNumber(pa);
  if (['Mon', 'Tue', 'Wed', 'Thu'].includes(pa.weekday)) return days === 0;
  if (pa.weekday === 'Fri') return pb.weekday === 'Sun' && days === 2;
  return false;
}

// ── Validation and preparation ───────────────────────────────────────────

export function sha256Rows(rows) {
  return createHash('sha256').update(JSON.stringify(rows), 'utf8').digest('hex');
}

function checkBars(bars, step, label) {
  if (!Array.isArray(bars) || bars.length === 0) abort(`${label} bars missing or empty`);
  let prev = null;
  bars.forEach((r, i) => {
    if (!Array.isArray(r) || r.length < 5) abort(`${label} bar row ${i}: expected [time, open, high, low, close, ...]`);
    const [t, o, h, l, c] = r;
    if (!Number.isInteger(t)) abort(`${label} bar row ${i}: time ${JSON.stringify(t)} is not an integer number of seconds`);
    if (t % step !== 0) abort(`${label} bar row ${i}: time ${t} is not a multiple of ${step}`);
    if (prev !== null && t <= prev) abort(`${label} bar row ${i}: time ${t} is not after ${prev} (duplicate or out of order)`);
    for (const [name, v] of [['open', o], ['high', h], ['low', l], ['close', c]]) {
      if (finite(v) === null) abort(`${label} bar at ${t}: ${name} is missing or non-finite`);
      if (!Number.isInteger(v * 4)) abort(`${label} bar at ${t}: ${name} ${v} is off the 0.25 grid`);
    }
    if (h < l) abort(`${label} bar at ${t}: high < low`);
    if (h < Math.max(o, c)) abort(`${label} bar at ${t}: high < max(open, close)`);
    if (l > Math.min(o, c)) abort(`${label} bar at ${t}: low > min(open, close)`);
    prev = t;
  });
}

/** Join a study series to bars by time; every bar needs exactly one row and every row a bar. */
function joinStudy(bars, study, minEntries, label) {
  if (!Array.isArray(study)) abort(`${label} rows missing`);
  const byTime = new Map();
  study.forEach((r, i) => {
    if (!Array.isArray(r)) abort(`${label} row ${i} is not an array`);
    const t = r[0];
    if (!Number.isInteger(t)) abort(`${label} row ${i}: time ${JSON.stringify(t)} is not an integer`);
    if (byTime.has(t)) abort(`${label} has two rows at ${t}`);
    if (r.length < minEntries) abort(`${label} row at ${t} has ${r.length - 1} plots; at least ${minEntries - 1} needed`);
    for (let p = 1; p < r.length; p++) {
      if (r[p] !== null && typeof r[p] !== 'number') abort(`${label} row at ${t}: plot ${p} is neither a number nor null`);
    }
    byTime.set(t, r);
  });
  const joined = bars.map((b) => {
    const r = byTime.get(b[0]);
    if (!r) abort(`${label} has no row at bar time ${b[0]}`);
    return r;
  });
  if (study.length !== bars.length) abort(`${label} has ${study.length} rows for ${bars.length} bars (rows with no bar)`);
  return joined;
}

function checkPlotLayout(a, b) {
  const ok = (list) => Array.isArray(list) && list.length > 0
    && list.every((p) => isObj(p) && typeof p.id === 'string' && typeof p.type === 'string');
  if (!ok(a) || !ok(b)) abort('15m plot layout unverified');
  if (a.length !== b.length) abort(`15m plot layout differs: tab 1 has ${a.length} plots, tab 2 has ${b.length}`);
  a.forEach((p, i) => {
    if (p.id !== b[i].id || p.type !== b[i].type) abort(`15m plot layout differs at plot ${i}`);
  });
}

function inRollWindow(t) {
  const p = etParts(t);
  return ROLL_MONTHS.includes(p.month) && p.day >= 5 && p.day <= 20;
}

/** Index of the last closed 15m row at decision time tk (S + 900 <= tk + 60), or -1. */
export function lastClosed15Index(t15, tk) {
  let lo = 0;
  let hi = t15.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (t15[mid] + M15 <= tk + M1) { best = mid; lo = mid + 1; } else { hi = mid - 1; }
  }
  return best;
}

/** First index whose time is > x, in a sorted array. */
function upperBound(arr, x) {
  let lo = 0;
  let hi = arr.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] <= x) lo = mid + 1; else hi = mid;
  }
  return lo;
}

function triggerOf(buy, crossDown, blueWave) {
  const fires = (v) => v !== null && v !== 0;
  const long = fires(buy);
  const short = fires(crossDown) && blueWave !== null && blueWave >= 60;
  return { long, short };
}

function gapList(times, step, lastMinute) {
  const out = [];
  for (let i = 1; i < times.length; i++) {
    const seconds = times[i] - times[i - 1];
    if (seconds > step && !isScheduledClose(times[i - 1], times[i], lastMinute)) {
      out.push({ from: times[i - 1], to: times[i], seconds });
    }
  }
  return out;
}

/**
 * Validate a snapshot and build the column arrays the simulator reads.
 * Throws an Error with code E_SNAPSHOT_ABORT on every abort rule.
 */
export function prepare(snap) {
  if (!isObj(snap)) abort('snapshot is not an object');
  if (snap.format !== FORMAT) abort(`format is ${JSON.stringify(snap.format)}, expected ${FORMAT}`);
  const rows = snap.rows;
  if (!isObj(rows) || !isObj(rows.m1) || !isObj(rows.m15)) abort('rows.m1 and rows.m15 are both needed');
  if (typeof snap.sha256 !== 'string') abort('sha256 missing');
  const sha = sha256Rows(rows);
  if (sha !== snap.sha256) abort(`sha256 mismatch: file says ${snap.sha256}, rows hash to ${sha}`);
  if (!Number.isInteger(snap.snapshot_time)) abort('snapshot_time is not an integer');
  const srPeriod = snap.sr_period_s === undefined ? M1 : snap.sr_period_s;
  if (!Number.isInteger(srPeriod) || srPeriod < M1 || srPeriod % M1 !== 0 || 3600 % srPeriod !== 0) {
    abort(`sr_period_s is ${JSON.stringify(snap.sr_period_s)}; it must be a whole number of minutes that divides an hour`);
  }

  checkPlotLayout(snap.plots_b_1m, snap.plots_b_15m);

  const bars1 = rows.m1.bars;
  const bars15 = rows.m15.bars;
  checkBars(bars1, M1, '1m');
  checkBars(bars15, M15, '15m');
  const b1 = joinStudy(bars1, rows.m1.b, B_MIN_ENTRIES, '1m MarketCipher_B');
  const sr1 = joinStudy(bars1, rows.m1.sr, SR_MIN_ENTRIES, '1m MarketCipher_SR');
  const b15 = joinStudy(bars15, rows.m15.b, B_MIN_ENTRIES, '15m MarketCipher_B');

  const n = bars1.length;
  const n15 = bars15.length;
  const t = bars1.map((r) => r[0]);
  const t15 = bars15.map((r) => r[0]);

  const header = {
    first_1m: t[0], last_1m: t[n - 1], count_1m: n,
    first_15m: t15[0], last_15m: t15[n15 - 1], count_15m: n15,
  };
  for (const [k, v] of Object.entries(header)) {
    if (snap[k] !== v) abort(`${k} is ${JSON.stringify(snap[k])} but the rows give ${v}`);
  }
  if (t[n - 1] + M1 > snap.snapshot_time) abort(`1m row at ${t[n - 1]} had not closed at snapshot time`);
  if (t15[n15 - 1] + M15 > snap.snapshot_time) abort(`15m row at ${t15[n15 - 1]} had not closed at snapshot time`);

  for (const x of t) if (inRollWindow(x)) abort(`1m row at ${x} (${etLabel(x)}) falls on the 5th-20th of a roll month`);
  for (const x of t15) if (inRollWindow(x)) abort(`15m row at ${x} (${etLabel(x)}) falls on the 5th-20th of a roll month`);

  const q4 = (col) => bars1.map((r) => r[col] * 4);
  const plot = (src, k) => src.map((r) => finite(r[k]));
  const d = {
    n, n15, t, t15,
    o: q4(1), h: q4(2), l: q4(3), c: q4(4),
    bw: plot(b1, PLOT.BLUE_WAVE), mf: plot(b1, PLOT.MNY_FLOW), buy: plot(b1, PLOT.BUY),
    cross: plot(b1, PLOT.CROSS_DOWN), sto: plot(b1, PLOT.STO_RSI),
    res: plot(sr1, SR_PLOT.RESISTANCE), sup: plot(sr1, SR_PLOT.SUPPORT),
    bw15: plot(b15, PLOT.BLUE_WAVE), mf15: plot(b15, PLOT.MNY_FLOW), rsi15: plot(b15, PLOT.RSI),
  };

  // Triggers on every row; a row with both aborts.
  d.trig = new Array(n);
  for (let i = 0; i < n; i++) {
    const { long, short } = triggerOf(d.buy[i], d.cross[i], d.bw[i]);
    if (long && short) abort(`1m row at ${t[i]} (${etLabel(t[i])}) has both a Buy and a short trigger`);
    d.trig[i] = long ? 'long' : (short ? 'short' : null);
  }

  // Last closed 15m row per 1m row, then F.
  d.q = new Array(n);
  let j = -1;
  for (let i = 0; i < n; i++) {
    while (j + 1 < n15 && t15[j + 1] + M15 <= t[i] + M1) j++;
    d.q[i] = j;
  }
  d.F = -1;
  for (let i = Math.max(1, WARMUP_1M_ROWS); i < n; i++) {
    if (d.q[i] >= 1 && d.q[i] >= WARMUP_15M_ROWS) { d.F = i; break; }
  }
  if (d.F < 0) {
    abort(`no row qualifies as F (needs 1m row index >= ${WARMUP_1M_ROWS}, a last closed 15m row at index >= ${WARMUP_15M_ROWS} and the 15m row before it)`);
  }

  // 15m coverage check (design line 9).
  const tL = t[n - 1];
  let bucket = null;
  for (let i = n - 1; i >= 0; i--) {
    const b = t[i] - (t[i] % M15);
    if (b + M15 <= tL + M1) { bucket = b; break; }
  }
  if (bucket === null) abort('15m coverage: no 15m bucket with a 1m row closes by the last 1m close');
  if (!t15.includes(bucket)) abort(`15m coverage: no 15m row at ${bucket} (${etLabel(bucket)})`);

  // Session breaks: prefix count of rows whose gap to the previous row is over 60 s.
  d.breakPrefix = new Array(n).fill(0);
  for (let i = 1; i < n; i++) d.breakPrefix[i] = d.breakPrefix[i - 1] + (t[i] - t[i - 1] > M1 ? 1 : 0);

  // Target candidates (design lines 69-70), in row order. With a 1m SR resolution the pivot
  // is row j-3. With a coarser one the pivot is the SR bar 3 bars before the SR bar holding
  // row j, counting only SR bars that hold a 1m row (TradingView counts bars, so the daily
  // halt adds none). Its high (low) is the max (min) over the 1m rows inside it.
  d.candLong = [];
  d.candShort = [];
  let pivotHigh = (jj) => d.h[jj - 3];
  let pivotLow = (jj) => d.l[jj - 3];
  if (srPeriod > M1) {
    // Rows are in time order, so SR bars are appended in time order too.
    const srBars = [];
    const srBarOf = new Array(n);
    for (let i = 0; i < n; i++) {
      const b = t[i] - (t[i] % srPeriod);
      const e = srBars[srBars.length - 1];
      if (e === undefined || e.b !== b) srBars.push({ b, h: d.h[i], l: d.l[i] });
      else { e.h = Math.max(e.h, d.h[i]); e.l = Math.min(e.l, d.l[i]); }
      srBarOf[i] = srBars.length - 1;
    }
    const pivotBar = (jj) => srBars[srBarOf[jj] - 3];
    pivotHigh = (jj) => pivotBar(jj)?.h;
    pivotLow = (jj) => pivotBar(jj)?.l;
  }
  for (let jj = 3; jj < n; jj++) {
    const r = d.res[jj];
    const rp = d.res[jj - 1];
    if (r !== null && rp !== null && r !== rp && r * 4 === pivotHigh(jj)) d.candLong.push({ j: jj, q: r * 4 });
    const s = d.sup[jj];
    const sp = d.sup[jj - 1];
    if (s !== null && sp !== null && s !== sp && s * 4 === pivotLow(jj)) d.candShort.push({ j: jj, q: s * 4 });
  }

  // Past Cipher lines: every on-grid Resistance or Support value, with the first row that plots it.
  d.lineFirst = new Map();
  for (let i = 0; i < n; i++) {
    for (const v of [d.res[i], d.sup[i]]) {
      if (v === null) continue;
      const lq = v * 4;
      if (Number.isInteger(lq) && !d.lineFirst.has(lq)) d.lineFirst.set(lq, i);
    }
  }

  // Report facts.
  const buckets1 = new Set(t.map((x) => x - (x % M15)));
  const emptyBuckets = [];
  let emptyOutside = 0;
  for (const S of t15) {
    if (buckets1.has(S)) continue;
    if (S + M15 > t[0] && S <= tL) emptyBuckets.push(S); else emptyOutside++;
  }
  const countNull = (arr) => arr.reduce((a, v) => a + (v === null ? 1 : 0), 0);
  const nonFinite = {
    '1m B plot 2 Blue Wave': countNull(d.bw),
    '1m B plot 4 Mny Flow': countNull(d.mf),
    '1m B plot 6 Buy': countNull(d.buy),
    '1m B plot 8 Blue Wave Crossing Down': countNull(d.cross),
    '1m B plot 16 Sto RSI': countNull(d.sto),
    '1m SR plot 4 Cipher Resistance': countNull(d.res),
    '1m SR plot 5 Cipher Support': countNull(d.sup),
    '15m B plot 2 Blue Wave': countNull(d.bw15),
    '15m B plot 4 Mny Flow': countNull(d.mf15),
    '15m B plot 15 RSI': countNull(d.rsi15),
  };
  const warnings = [];
  const in1 = snap.inputs_b_1m;
  const in15 = snap.inputs_b_15m;
  if (in1 === undefined || in15 === undefined) {
    warnings.push('15m MarketCipher_B inputs were not compared (missing in snapshot); 15m settings may not match the user\'s');
  } else if (JSON.stringify(in1) !== JSON.stringify(in15)) {
    warnings.push('15m MarketCipher_B inputs differ from tab 1; 15m settings may not match the user\'s');
  }

  d.info = {
    sha256: snap.sha256,
    id: snap.sha256.slice(0, 8),
    snapshotTime: snap.snapshot_time,
    ...header,
    F: d.F,
    fTime: t[d.F],
    rowsBeforeF: d.F,
    srPeriodS: srPeriod,
    targetCandidates: { long: d.candLong.length, short: d.candShort.length },
    gaps1m: gapList(t, M1, 59),
    gaps15m: gapList(t15, M15, 45),
    emptyBuckets15m: emptyBuckets,
    emptyBuckets15mOutside1mRange: emptyOutside,
    nonFinite,
    warnings,
    repaint: 'unverified',
  };
  return d;
}

// ── Rules ────────────────────────────────────────────────────────────────

const rising = (x, prev) => x !== null && prev !== null && x > prev;
const falling = (x, prev) => x !== null && prev !== null && x < prev;
const moved = (side) => (side === 'long' ? rising : falling);

/**
 * Avg4 of 15m Mny Flow at last closed 15m row qi (user rule, 2026-10-16): 1 when the 4-bar simple
 * average of Mny Flow rose from row qi-1 to row qi and the latest closed bar also rose, -1 for the
 * mirror, else 0. A latest bar that moved against the average, or did not move, is a counter bar
 * and gives 0. SMA4(qi) - SMA4(qi-1) = (mf[qi] - mf[qi-4]) / 4, so the sign is taken from that
 * difference directly. Too few rows or a missing value in mf[qi-4..qi] gives 0.
 */
export function mfTrend(d, qi) {
  if (qi < MF_AVG_BARS) return 0;
  for (let j = qi - MF_AVG_BARS; j <= qi; j++) if (d.mf15[j] === null) return 0;
  const avg = Math.sign(d.mf15[qi] - d.mf15[qi - MF_AVG_BARS]);
  const bar = Math.sign(d.mf15[qi] - d.mf15[qi - 1]);
  return avg !== 0 && bar === avg ? avg : 0;
}

/**
 * The run's 15m filter at decision row i, on the last closed 15m row and the one before it.
 * mfMode 'trend' judges Mny Flow by Avg4 instead of the one-bar change.
 */
export function filter15(d, runId, side, i, mfMode = 'bar') {
  const qi = d.q[i];
  if (qi < 1) return false;
  const dir = moved(side);
  const mf = mfMode === 'trend' ? mfTrend(d, qi) === (side === 'long' ? 1 : -1) : dir(d.mf15[qi], d.mf15[qi - 1]);
  const bw = dir(d.bw15[qi], d.bw15[qi - 1]);
  const rsi = dir(d.rsi15[qi], d.rsi15[qi - 1]);
  const votes = (mf ? 1 : 0) + (bw ? 1 : 0) + (rsi ? 1 : 0);
  if (runId === 'HTF-a') return mf;
  if (runId === 'HTF-b') return votes >= 2;
  if (runId === 'HTF-c') return votes === 3;
  throw new Error(`unknown run ${runId}`);
}

/** Stale label for an attempt at row k (design line 39): null, 'break' or 'no_break'. */
function staleLabel(d, k) {
  const close15 = d.t15[d.q[k]] + M15;
  if (d.t[k] + M1 - close15 < M15) return null;
  // Any 1m session break whose later row r has close15 < t(r) <= t(k).
  const lo = upperBound(d.t, close15);
  if (lo > k) return 'no_break';
  const before = lo === 0 ? 0 : d.breakPrefix[lo - 1];
  return d.breakPrefix[k] - before > 0 ? 'break' : 'no_break';
}

function chooseTarget(d, side, k, rQ) {
  let best = null;
  const list = side === 'long' ? d.candLong : d.candShort;
  for (const cand of list) {
    if (cand.j > k) break;
    if (side === 'long' && cand.q > rQ && (best === null || cand.q < best)) best = cand.q;
    if (side === 'short' && cand.q < rQ && (best === null || cand.q > best)) best = cand.q;
  }
  return best;
}

/**
 * srsl stop level for an entry at eQ: the nearest confirmed opposite Cipher level (Support for a long,
 * Resistance for a short) confirmed by row k whose stop, 1 tick beyond it, is at least STOP_MIN_Q from eQ.
 * Returns null when there is none or the nearest is more than STOP_MAX_Q away.
 */
function chooseStopLevel(d, side, k, eQ) {
  let best = null;
  const list = side === 'long' ? d.candShort : d.candLong;
  for (const cand of list) {
    if (cand.j > k) break;
    const distQ = side === 'long' ? eQ - (cand.q - 1) : (cand.q + 1) - eQ;
    if (distQ < STOP_MIN_Q) continue;
    if (best === null || (side === 'long' ? cand.q > best : cand.q < best)) best = cand.q;
  }
  if (best === null) return null;
  const distQ = side === 'long' ? eQ - (best - 1) : (best + 1) - eQ;
  return distQ > STOP_MAX_Q ? null : best;
}

/**
 * band levels for a trigger on row k with entry eQ: { tQ, stopLevelQ } from Cipher Resistance and
 * Support on row k, or null when either is missing or eQ is not strictly between them.
 */
function bandLevels(d, side, k, eQ) {
  const r = d.res[k];
  const s = d.sup[k];
  if (r === null || s === null) return null;
  const rQ = r * 4;
  const sQ = s * 4;
  if (!Number.isInteger(rQ) || !Number.isInteger(sQ)) return null;
  if (!(sQ < eQ && eQ < rQ)) return null;
  return side === 'long' ? { tQ: rQ, stopLevelQ: sQ } : { tQ: sQ, stopLevelQ: rQ };
}

/**
 * next and next15 target for an entry at eQ on trigger row k with risk riskQ (> 0). Lines are the past
 * Cipher lines plotted at or before row k, strictly beyond eQ. Returns { tQ } with the chosen line,
 * or { tQ: null, why } where why is 'no_target' (no line beyond eQ) or 'under_rr'.
 */
function nextLine(d, side, k, eQ, riskQ, mode) {
  let nearest = null;
  let nearestRr = null;
  for (const [lq, j] of d.lineFirst) {
    if (j > k) continue;
    const rewardQ = side === 'long' ? lq - eQ : eQ - lq;
    if (rewardQ <= 0) continue;
    if (nearest === null || rewardQ < nearest) nearest = rewardQ;
    if (MIN_RR_DEN * rewardQ >= MIN_RR_NUM * riskQ && (nearestRr === null || rewardQ < nearestRr)) nearestRr = rewardQ;
  }
  if (nearest === null) return { tQ: null, why: 'no_target' };
  const pick = mode === 'next' ? (nearest === nearestRr ? nearest : null) : nearestRr;
  if (pick === null) return { tQ: null, why: 'under_rr' };
  return { tQ: side === 'long' ? eQ + pick : eQ - pick };
}

function buildTrade(d, runId, win, k, srTQ, targetMode, stopLevelQ = null) {
  const long = win.side === 'long';
  const rawEntryQ = d.o[k + 1];
  const eQ = rawEntryQ + (long ? 1 : -1);
  let setupQ = long ? d.l[win.d] : d.h[win.d];
  for (let j = win.d; j <= k; j++) setupQ = long ? Math.min(setupQ, d.l[j]) : Math.max(setupQ, d.h[j]);
  if (targetMode === 'srsl' || bandStop(targetMode)) setupQ = stopLevelQ; // the Cipher level the stop sits beyond
  const rawStopQ = long ? setupQ - 1 : setupQ + 1;
  const rawDistQ = long ? eQ - rawStopQ : rawStopQ - eQ;
  const dQ = bandStop(targetMode) ? rawDistQ : Math.min(Math.max(rawDistQ, STOP_MIN_Q), STOP_MAX_Q);
  const sQ = long ? eQ - dQ : eQ + dQ;
  const tQ = targetMode === '1R' ? (long ? eQ + dQ : eQ - dQ) : srTQ;
  const rewardQ = long ? tQ - eQ : eQ - tQ;
  return {
    runId,
    side: win.side,
    triggerRow: win.d,
    triggerTime: d.t[win.d],
    confirmRow: k,
    entryRow: k + 1,
    entryTime: d.t[k + 1],
    rQ: d.c[k],
    tQ,
    rawEntryQ,
    eQ,
    setupQ,
    rawStopQ,
    rawDistQ,
    dQ,
    sQ,
    floor: !bandStop(targetMode) && rawDistQ < STOP_MIN_Q,
    cap: !bandStop(targetMode) && rawDistQ > STOP_MAX_Q,
    under1R: rewardQ < dQ,
    behind: rewardQ <= 0,
    gap: d.breakPrefix[k + 1] - d.breakPrefix[win.d] > 0,
    open: true,
    exitRow: null,
    exitTime: null,
    exitCase: null,
    reason: null,
    exitQ: null,
    rawExitQ: null,
    nq: null,
    grossNq: null,
    touched: false,
    stopTargetAlso: false,
    markNq: null,
  };
}

/** Check stop and target on row i (design line 80). Returns true when the trade exits. */
function checkExit(d, tr, i) {
  const long = tr.side === 'long';
  const o = d.o[i];
  const h = d.h[i];
  const l = d.l[i];
  const S = tr.sQ;
  const T = tr.tQ;
  if (long ? h === T : l === T) tr.touched = true;
  const stopRule = long ? l <= S : h >= S;
  const targetRule = long ? h >= T + 1 : l <= T - 1;
  let exitCase = null;
  if (long ? o <= S : o >= S) exitCase = 1;
  else if (long ? o >= T + 1 : o <= T - 1) exitCase = 2;
  else if (stopRule && targetRule) exitCase = 3;
  else if (stopRule || targetRule) exitCase = 4;
  if (exitCase === null) return false;

  const isStop = exitCase === 1 || exitCase === 3 || (exitCase === 4 && stopRule);
  if (isStop) {
    tr.reason = 'stop';
    tr.rawExitQ = long ? Math.min(S, o) : Math.max(S, o);
    tr.exitQ = long ? tr.rawExitQ - 1 : tr.rawExitQ + 1;
    tr.stopTargetAlso = targetRule;
  } else {
    tr.reason = 'target';
    tr.rawExitQ = long ? Math.max(T, o) : Math.min(T, o);
    tr.exitQ = tr.rawExitQ;
  }
  tr.open = false;
  tr.exitCase = exitCase;
  tr.exitRow = i;
  tr.exitTime = d.t[i];
  tr.nq = (long ? tr.exitQ - tr.eQ : tr.eQ - tr.exitQ) * 5 - FEES_NQ;
  tr.grossNq = (long ? tr.rawExitQ - tr.rawEntryQ : tr.rawEntryQ - tr.rawExitQ) * 5;
  return true;
}

/** 70/30 segment of a trigger at time tD (design line 104): 1 or 2. Integer arithmetic only. */
export function segmentOf(tD, tF, tLast) {
  return 10n * BigInt(tD - tF) < 7n * BigInt(tLast - tF) ? 1 : 2;
}

/** Run one HTF variant over prepared data (design line 52 order). opts.target is a TARGET_MODES entry. */
export function simulateRun(d, runId, { target = 'sr' } = {}) {
  if (!RUN_IDS.includes(runId)) throw new Error(`unknown run ${runId}`);
  if (!TARGET_MODES.includes(target)) throw new Error(`unknown target mode ${target}`);
  const triggers = [];
  const trades = [];
  let pos = null;
  const tF = d.t[d.F];
  const tLast = d.t[d.n - 1];

  for (let i = d.F; i < d.n; i++) {
    // 1. Exits.
    if (pos && pos.entryRow <= i && checkExit(d, pos, i)) pos = null;
    const trig = d.trig[i];
    if (!trig) continue;

    // 2. New trigger. Entry on confirmation: the dot's bar has closed, so the
    // decision is made at row i and the order fills at the next bar's open
    // (user rule, 2026-10-16; replaces the 5-bar 1m rising window).
    const rec = {
      row: i, time: d.t[i], side: trig, segment: segmentOf(d.t[i], tF, tLast),
      outcome: null, trade: null, attempts: [], filterFailInWindow: false,
    };
    triggers.push(rec);
    if (pos) {
      rec.outcome = 'ignored_position';
      continue;
    }
    const pass = filter15(d, runId, trig, i, NEXT_MODES.includes(target) ? 'trend' : 'bar');
    rec.attempts.push({ row: i, pass, stale: staleLabel(d, i) });
    if (!pass) {
      rec.outcome = 'filtered';
      rec.filterFailInWindow = true;
    } else if (i + 1 >= d.n) {
      rec.outcome = 'insufficient';
    } else {
      const eQ = d.o[i + 1] + (trig === 'long' ? 1 : -1);
      const band = bandStop(target) ? bandLevels(d, trig, i, eQ) : null;
      let next = null;
      if (band !== null && NEXT_MODES.includes(target)) {
        const riskQ = trig === 'long' ? eQ - (band.stopLevelQ - 1) : (band.stopLevelQ + 1) - eQ;
        next = nextLine(d, trig, i, eQ, riskQ, target);
      }
      let tQ;
      if (target === 'band') tQ = band?.tQ ?? null;
      else if (NEXT_MODES.includes(target)) tQ = next?.tQ ?? null;
      else tQ = target === '1R' ? null : chooseTarget(d, trig, i, d.c[i]);
      const stopLevelQ = bandStop(target) ? band?.stopLevelQ ?? null
        : (target === 'srsl' && tQ !== null ? chooseStopLevel(d, trig, i, eQ) : null);
      if (bandStop(target) && band === null) {
        rec.outcome = 'outside_band';
      } else if (next !== null && next.tQ === null) {
        rec.outcome = next.why;
      } else if (target !== '1R' && tQ === null) {
        rec.outcome = 'no_target';
      } else if (target === 'srsl' && stopLevelQ === null) {
        rec.outcome = 'no_stop';
      } else {
        const tr = buildTrade(d, runId, { d: i, side: trig, rec }, i, tQ, target, stopLevelQ);
        rec.outcome = 'trade';
        rec.trade = tr;
        trades.push(tr);
        pos = tr;
      }
    }
  }

  // 3. Last row.
  if (pos) {
    const lastC = d.c[d.n - 1];
    pos.markNq = (pos.side === 'long' ? lastC - pos.eQ : pos.eQ - lastC) * 5 - FEES_NQ;
  }
  return { runId, triggers, trades };
}

// ── Accounting ───────────────────────────────────────────────────────────

const absBig = (x) => (x < 0n ? -x : x);
const gcdBig = (a, b) => {
  let x = absBig(a);
  let y = absBig(b);
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

/** numer / denom (denom > 0) rounded half away from zero to hundredths, as a BigInt count of hundredths. */
export function roundHundredths(numer, denom) {
  const num = absBig(numer) * 100n;
  const r = (2n * num + denom) / (2n * denom);
  return numer < 0n ? -r : r;
}

/** Per-trade R in hundredths (design line 92): Nq / (5 * Dq). */
export function rHundredths(nq, dq) {
  return Number(roundHundredths(BigInt(nq), 5n * BigInt(dq)));
}

/** Exact average R in hundredths over [{ nq, dq }], or null for an empty list. */
export function averageRHundredths(list) {
  if (list.length === 0) return null;
  let lcm = 1n;
  for (const x of list) {
    const den = 5n * BigInt(x.dq);
    lcm = (lcm / gcdBig(lcm, den)) * den;
  }
  let N = 0n;
  for (const x of list) N += BigInt(x.nq) * (lcm / (5n * BigInt(x.dq)));
  return Number(roundHundredths(N, lcm * BigInt(list.length)));
}

/** Wilson 95% interval in float64, in the order of design line 100. */
export function wilson(wins, n) {
  if (n === 0) return null;
  const z = 1.96;
  const p = wins / n;
  const denom = 1 + (z * z) / n;
  const centre = (p + (z * z) / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / denom;
  return { lower: Math.max(0, centre - half), upper: Math.min(1, centre + half) };
}

/** Stats, funnel and counts for a set of trigger records (whole run or one segment). */
export function summarize(triggers) {
  const funnel = Object.fromEntries(OUTCOMES.map((k) => [k, 0]));
  let expiredWithFilterFail = 0;
  const stale = { break: { pass: 0, fail: 0 }, no_break: { pass: 0, fail: 0 } };
  const trades = [];
  for (const rec of triggers) {
    if (rec.outcome === 'trade') {
      funnel[rec.trade.open ? 'open' : 'closed']++;
      trades.push(rec.trade);
    } else if (Object.hasOwn(funnel, rec.outcome)) {
      funnel[rec.outcome]++;
    } else {
      throw new Error(`trigger at row ${rec.row} has no outcome`);
    }
    if (rec.outcome === 'expired' && rec.filterFailInWindow) expiredWithFilterFail++;
    for (const a of rec.attempts) if (a.stale) stale[a.stale][a.pass ? 'pass' : 'fail']++;
  }
  const sum = OUTCOMES.reduce((a, k) => a + funnel[k], 0);
  const closed = trades.filter((t) => !t.open).sort((a, b) => a.exitRow - b.exitRow);
  const open = trades.filter((t) => t.open);
  const n = closed.length;
  const wins = closed.filter((t) => t.nq > 0).length;
  const targetExits = closed.filter((t) => t.reason === 'target');

  let cum = 0;
  let peak = 0;
  let maxDdNq = 0;
  for (const t of closed) {
    cum += t.nq;
    peak = Math.max(peak, cum);
    maxDdNq = Math.max(maxDdNq, peak - cum);
  }
  const count = (list, f) => list.filter(f).length;
  return {
    funnel: { triggers: triggers.length, ...funnel, sum, reconciles: sum === triggers.length },
    expiredWithFilterFail,
    stale,
    closed: { n, long: count(closed, (t) => t.side === 'long'), short: count(closed, (t) => t.side === 'short') },
    open: { n: open.length, long: count(open, (t) => t.side === 'long'), short: count(open, (t) => t.side === 'short') },
    wins,
    winRate: n ? wins / n : null,
    wilson: wilson(wins, n),
    netNq: closed.reduce((a, t) => a + t.nq, 0),
    grossNq: closed.reduce((a, t) => a + t.grossNq, 0),
    avgRHundredths: averageRHundredths(closed.map((t) => ({ nq: t.nq, dq: t.dQ }))),
    maxDdNq,
    stopsOnFloor: count(trades, (t) => t.floor),
    stopsOnCap: count(trades, (t) => t.cap),
    targetsUnder1R: count(trades, (t) => t.under1R),
    targetAtOrBehindEntry: count(trades, (t) => t.behind),
    gapTrades: count(trades, (t) => t.gap),
    targetHitRate: n ? targetExits.length / n : null,
    targetExitsNonPositive: count(targetExits, (t) => t.nq <= 0),
    touchedNotFilled: count(closed, (t) => t.reason !== 'target' && t.touched),
    stopTakenTargetReached: count(closed, (t) => t.reason === 'stop' && t.stopTargetAlso),
  };
}

/** Validate the snapshot and simulate all three runs. opts.target is a TARGET_MODES entry (default 'sr'). */
export function simulate(snap, { target = 'sr' } = {}) {
  if (!TARGET_MODES.includes(target)) throw new Error(`unknown target mode ${target}`);
  const d = prepare(snap);
  const runs = RUN_IDS.map((runId) => {
    const r = simulateRun(d, runId, { target });
    return {
      ...r,
      whole: summarize(r.triggers),
      first: summarize(r.triggers.filter((x) => x.segment === 1)),
      second: summarize(r.triggers.filter((x) => x.segment === 2)),
    };
  });
  return { info: { ...d.info, targetMode: target }, lastCloseQ: d.c[d.n - 1], runs };
}

// ── Display ──────────────────────────────────────────────────────────────

/** Rate as a percentage with one decimal; "-0.0" prints as "0.0"; null prints "n/a". */
export function fmtRate(x) {
  if (x === null || x === undefined) return 'n/a';
  const s = (100 * x).toFixed(1);
  return s === '-0.0' ? '0.0' : s;
}

/** Quarter-dollar integer → dollars with two decimals, exact. */
export function fmtDollarsNq(nq) {
  const a = Math.abs(nq);
  const s = `${Math.floor(a / 4)}.${['00', '25', '50', '75'][a % 4]}`;
  return nq < 0 ? `-${s}` : s;
}

/** Quarter-point integer → price with two decimals, exact. */
export const fmtPriceQ = (q) => fmtDollarsNq(q);

/** R in hundredths → two decimals via toFixed(2) on the already rounded value. */
export function fmtR(h) {
  if (h === null || h === undefined) return 'n/a';
  return (h / 100).toFixed(2);
}
