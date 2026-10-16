/**
 * mc_basic_1m repaint check (design v14 lines 108-115, 157, 166). Pure: no files, no clock,
 * no CDP. Every wall-clock time comes in as an argument, in milliseconds. Row times are
 * unix seconds, as the recorder keys them.
 *
 * A "first" value is { bar: [t,o,h,l,c,v], b: [t, p1..pN], sr: [t, p1..pM] | null }, the
 * values of one closed bar as the recorder first stored them. A live row is a first value
 * read from tab 1 or tab 2 now. "absent" stands for a recorded row missing from the live read.
 */

/** Plots that count as a mismatch (plot k sits at index k of its row array). */
export const MISMATCH_PLOTS = Object.freeze({
  b: Object.freeze([2, 4, 6, 8, 15, 16]),
  sr: Object.freeze([4, 5]),
});

const EPS = 1e-9;
const PERIOD_S = Object.freeze({ tab1: 60, tab2: 900 });
const STORE_DELAY_MS = 5000;
const SEEN_TOLERANCE_MS = Object.freeze({ tab1: 2000, tab2: 10000 });
const FINAL_AGE_MS = 30 * 60 * 1000;
const POLL_STALE_MS = Object.freeze({ tab1: 10000, tab2: 15000 });
const ROW_WAIT_MS = 12000;
const COVERAGE = Object.freeze({ rows1m: 300, rows15m: 20, buys: 3, shorts: 3 });
const BUY_PLOT = 6;
const CROSS_DOWN_PLOT = 8;
const BLUE_WAVE_PLOT = 2;
const SHORT_BLUE_WAVE_MIN = 60;

function argError(message) {
  const e = new Error(`repaint: ${message}`);
  e.code = 'E_ARGS';
  return e;
}

function requireTab(tab) {
  if (tab !== 'tab1' && tab !== 'tab2') throw argError(`unknown tab ${String(tab)}`);
}

function requireMs(now) {
  if (typeof now !== 'number' || !Number.isFinite(now)) throw argError('now must be a finite number of ms');
}

function assertFirst(v) {
  if (v === null || typeof v !== 'object' || !Array.isArray(v.bar) || !Array.isArray(v.b)) {
    throw argError('first value must be { bar, b, sr }');
  }
  if (v.sr !== null && !Array.isArray(v.sr)) throw argError('first.sr must be an array or null');
}

const finiteOrNull = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Value at index k, or null when the row or the index is missing. */
const at = (arr, k) => (Array.isArray(arr) && k < arr.length ? finiteOrNull(arr[k]) : null);

/** True when two plot values differ: one side non-finite, or finite values more than 1e-9 apart. */
function numDiffer(x, y) {
  const a = finiteOrNull(x);
  const b = finiteOrNull(y);
  if (a === null || b === null) return a !== b;
  return Math.abs(a - b) > EPS;
}

const byNumericKey = (x, y) => Number(x) - Number(y);

function copyFirst(first) {
  return {
    bar: first.bar.slice(),
    b: first.b.slice(),
    sr: first.sr === null ? null : first.sr.slice(),
  };
}

/**
 * Bar period from the spacing of sorted unique times: the smallest positive gap. Gaps only
 * widen a spacing (halts, weekends), so the smallest gap is the bar length. Null when there
 * are fewer than two times.
 */
function periodFromTimes(times) {
  const sorted = [...new Set(times)].sort((x, y) => x - y);
  let period = null;
  for (let i = 1; i < sorted.length; i++) {
    const gap = sorted[i] - sorted[i - 1];
    if (gap > 0 && (period === null || gap < period)) period = gap;
  }
  return period;
}

/**
 * True when a mismatch needs a new entry: the row's values differ from its latest values
 * (design line 112 rule). Only "absent" or a first-shaped object is valid. Compares the
 * OHLC of the bar (indices 1 to 4, volume is not compared), the MISMATCH_PLOTS of the B row
 * and of the SR row. A null SR row (tab 2) counts as all-null values.
 */
export function valuesDiffer(a, b) {
  if (a === 'absent' || b === 'absent') return a !== b;
  assertFirst(a);
  assertFirst(b);
  for (let i = 1; i <= 4; i++) {
    if (numDiffer(at(a.bar, i), at(b.bar, i))) return true;
  }
  for (const k of MISMATCH_PLOTS.b) {
    if (numDiffer(at(a.b, k), at(b.b, k))) return true;
  }
  for (const k of MISMATCH_PLOTS.sr) {
    if (numDiffer(at(a.sr, k), at(b.sr, k))) return true;
  }
  return false;
}

/**
 * The latest values of one row: the newest of its mismatch_history entries and guard
 * draw_mismatches (guard uses `new`), or its first stored values when neither has it.
 * A tie on detected_at keeps the history entry.
 */
function latestValues(tab, key, history, guardMismatches, firstStored) {
  let best = null;
  const consider = (detectedAt, values) => {
    if (best === null || detectedAt > best.detectedAt) best = { detectedAt, values };
  };
  for (const e of history) {
    if (e && e.kind === 'mismatch' && e.tab === tab && String(e.row_time) === key) {
      consider(e.detected_at, e.values);
    }
  }
  for (const e of guardMismatches) {
    if (e && e.tab === tab && String(e.row_time) === key) consider(e.detected_at, e.new);
  }
  return best === null ? firstStored : best.values;
}

/**
 * New mismatches for one tab, from a full check of every recorded row (including final
 * rows). The live value of a recorded row missing from `live` is "absent". A row is new
 * only when its live value differs from its latest value (see latestValues), so a change
 * that persists adds one entry. Live rows not recorded yet are not checked here.
 *
 * history: the entries array of mismatch_history.json. guardMismatches: guard.json's
 * draw_mismatches array. The returned entries have no `kind`; the caller adds kind
 * "mismatch" when it writes them to mismatch_history.json.
 */
export function newMismatches({ tab, recorded, live, history = [], guardMismatches = [], now }) {
  requireTab(tab);
  requireMs(now);
  if (!Array.isArray(history) || !Array.isArray(guardMismatches)) {
    throw argError('history and guardMismatches must be arrays');
  }
  const out = [];
  for (const key of Object.keys(recorded).sort(byNumericKey)) {
    const liveValue = Object.hasOwn(live, key) ? live[key] : 'absent';
    const latest = latestValues(tab, key, history, guardMismatches, recorded[key].first);
    if (valuesDiffer(latest, liveValue)) {
      out.push({ tab, row_time: Number(key), values: liveValue, detected_at: now });
    }
  }
  return out;
}

/**
 * Stores closed bars that have not been stored yet (design lines 109-110). A closed bar j
 * is stored when the recorder first sees row j+1 (firstSeen), or when now reaches close +
 * 5 s. It is valid only if row j+1 was first seen within 2 s of j's close on tab 1 (10 s
 * on tab 2). Stored values are the live values now; stored_at is now.
 *
 * firstSeen: a plain object, row time (string key) to the ms the caller first read that bar
 * live. It must include the open bar, because `live` holds closed bars only. A row missing
 * from firstSeen counts as not seen. Returns a new rows object; the input is not changed.
 */
export function storeNewRows({ tab, rows, live, now, firstSeen = {} }) {
  requireTab(tab);
  requireMs(now);
  const period = PERIOD_S[tab];
  const tolerance = SEEN_TOLERANCE_MS[tab];
  const out = { ...rows };
  for (const key of Object.keys(live).sort(byNumericKey)) {
    if (Object.hasOwn(out, key)) continue;
    const t = Number(key);
    const closeMs = (t + period) * 1000;
    if (now < closeMs) continue; // closed bars only
    const nextKey = String(t + period);
    const nextSeen = Object.hasOwn(firstSeen, nextKey) ? firstSeen[nextKey] : null;
    const timerDue = now >= closeMs + STORE_DELAY_MS;
    if (nextSeen === null && !timerDue) continue;
    const valid = nextSeen !== null && Math.abs(nextSeen - closeMs) <= tolerance;
    assertFirst(live[key]);
    out[key] = { first: copyFirst(live[key]), stored_at: now, valid, final: false };
  }
  return out;
}

/**
 * Marks a stored row final when a check at least 30 minutes after its close finds it
 * matching its first stored values (design line 111). The period is inferred from the
 * closed bars in `live`; with fewer than two, nothing becomes final. Final never reverts.
 * Returns a new rows object.
 */
export function markFinal(rows, live, now) {
  requireMs(now);
  const period = periodFromTimes(Object.keys(live).map(Number));
  const out = {};
  for (const key of Object.keys(rows)) {
    const row = rows[key];
    let final = row.final === true;
    if (!final && period !== null && Object.hasOwn(live, key)) {
      const closeMs = (Number(key) + period) * 1000;
      if (now - closeMs >= FINAL_AGE_MS && !valuesDiffer(row.first, live[key])) final = true;
    }
    out[key] = { ...row, final };
  }
  return out;
}

const isNumber = (v) => typeof v === 'number' && Number.isFinite(v);
const fires = (v) => v !== null && v !== 0;

/**
 * The cutoff: the latest entry in mismatch_history.json, guard draw_mismatches, guard lost_at
 * or guard reset_stamps (design lines 112, 166). Ties go to the entry with a row, then to the
 * larger row time, which is the stricter choice. Returns null when there is no entry.
 */
function latestCutoff(entries, guard) {
  const cands = [];
  for (const e of entries) {
    if (!isNumber(e.detected_at)) return { error: 'malformed mismatch_history entry' };
    const row = e.kind === 'mismatch' ? { tab: e.tab, row_time: Number(e.row_time) } : null;
    cands.push({ at: e.detected_at, row, label: e.kind });
  }
  for (const e of guard.draw_mismatches) {
    if (!isNumber(e.detected_at)) return { error: 'malformed guard draw_mismatches entry' };
    cands.push({ at: e.detected_at, row: { tab: e.tab, row_time: Number(e.row_time) }, label: 'mismatch' });
  }
  if (guard.lost_at !== null && guard.lost_at !== undefined) {
    if (!isNumber(guard.lost_at)) return { error: 'malformed guard lost_at' };
    cands.push({ at: guard.lost_at, row: null, label: 'lost' });
  }
  for (const s of guard.reset_stamps) {
    if (!isNumber(s)) return { error: 'malformed guard reset_stamps' };
    cands.push({ at: s, row: null, label: 'broker reset' });
  }
  let best = null;
  for (const c of cands) {
    if (best === null || c.at > best.at) best = c;
    else if (c.at === best.at) {
      const cRow = c.row !== null;
      const bRow = best.row !== null;
      if ((cRow && !bRow) || (cRow && bRow && c.row.row_time > best.row.row_time)) best = c;
    }
  }
  return best;
}

/** Valid final rows stored after the cutoff, with their Buy and short-trigger counts. */
function coverageAfter(tabRows, tab, cutoff, mismatched) {
  let count = 0;
  let buys = 0;
  let shorts = 0;
  for (const key of Object.keys(tabRows)) {
    const row = tabRows[key];
    if (row.valid !== true || row.final !== true) continue;
    if (!(row.stored_at > cutoff.at)) continue;
    if (cutoff.row !== null && !(Number(key) > cutoff.row.row_time)) continue;
    if (mismatched.has(`${tab}|${key}`)) continue;
    count += 1;
    const b = row.first.b;
    if (fires(at(b, BUY_PLOT))) buys += 1;
    if (fires(at(b, CROSS_DOWN_PLOT)) && (at(b, BLUE_WAVE_PLOT) ?? -Infinity) >= SHORT_BLUE_WAVE_MIN) shorts += 1;
  }
  return { count, buys, shorts };
}

/**
 * The repaint status for one write (design lines 111-115, 157, 166). Returns
 * { status: "verified"|"unverified", reason }. A row is unverified when it is unreadable,
 * stale, or does not yet meet the pass rule. When the newest closed row is missing but closed
 * less than 12 s ago, it also sets retry: true; the caller waits and calls again.
 *
 * recorder: readRecorder() result { state, data }. history: readMismatchHistory() result
 * { state, data }. guard: readGuard() result { state, guard }, plus fresh: true when the
 * guard state is fresh (design line 166; a missing guard counts as unreadable otherwise).
 * newestLive: { tab1, tab2 }, the newest closed row times (seconds) in the pre-write reads;
 * null when a read failed.
 */
export function computeStatus({ recorder, history, guard, now, newestLive }) {
  requireMs(now);
  const bad = (reason) => ({ status: 'unverified', reason });

  if (!recorder || recorder.state !== 'ok') return bad(`recorder.json ${recorder ? recorder.state : 'unread'}`);
  const rec = recorder.data;
  if (!rec || typeof rec.rows !== 'object' || rec.rows === null) return bad('recorder.json has no rows');
  const rows = { tab1: rec.rows.tab1, tab2: rec.rows.tab2 };
  if (!rows.tab1 || !rows.tab2) return bad('recorder.json has no tab rows');

  if (!history || history.state !== 'ok' || !history.data || !Array.isArray(history.data.entries)) {
    return bad(`mismatch_history.json ${history ? history.state : 'unread'}`);
  }
  const entries = history.data.entries;

  let guardData;
  if (!guard) return bad('guard.json unread');
  if (guard.state === 'ok') {
    guardData = guard.guard;
  } else if (guard.state === 'missing' && guard.fresh === true) {
    guardData = { broker_check: 'none', draw_mismatches: [], lost_at: null, reset_stamps: [] };
  } else if (guard.state === 'missing') {
    return bad('guard.json missing and not fresh');
  } else {
    return bad(`guard.json ${guard.state}`);
  }
  if (!guardData || typeof guardData !== 'object' || !Array.isArray(guardData.draw_mismatches) || !Array.isArray(guardData.reset_stamps)) {
    return bad('guard.json malformed');
  }

  for (const [tab, field] of [['tab1', 'last_poll_t1'], ['tab2', 'last_poll_t2']]) {
    const polled = rec[field];
    if (!isNumber(polled) || now - polled > POLL_STALE_MS[tab]) return bad(`stale: ${tab} last poll too old or unknown`);
  }

  const cutoff = latestCutoff(entries, guardData);
  if (cutoff === null) return bad('no start entry in mismatch_history.json or guard.json');
  if (cutoff.error) return bad(cutoff.error);

  for (const tab of ['tab1', 'tab2']) {
    const period = PERIOD_S[tab];
    const nl = newestLive ? newestLive[tab] : undefined;
    if (!isNumber(nl)) return bad(`cannot read ${tab}`);
    if (!Object.hasOwn(rows[tab], String(nl))) {
      const closeMs = (nl + period) * 1000;
      if (now - closeMs <= ROW_WAIT_MS) {
        return { status: 'unverified', reason: `${tab} newest closed row ${nl} not stored yet`, retry: true };
      }
      return bad(`stale: newest closed ${tab} row ${nl} missing from recorder`);
    }
  }

  const mismatched = new Set();
  for (const e of entries) {
    if (e.kind === 'mismatch') mismatched.add(`${e.tab}|${String(Number(e.row_time))}`);
  }
  for (const e of guardData.draw_mismatches) mismatched.add(`${e.tab}|${String(Number(e.row_time))}`);

  const c1 = coverageAfter(rows.tab1, 'tab1', cutoff, mismatched);
  const c15 = coverageAfter(rows.tab2, 'tab2', cutoff, mismatched);
  const since = cutoff.row === null ? cutoff.label : `${cutoff.label} ${cutoff.row.tab} ${cutoff.row.row_time}`;
  const summary = `1m ${c1.count}/${COVERAGE.rows1m} (buy ${c1.buys}/${COVERAGE.buys}, short ${c1.shorts}/${COVERAGE.shorts}), 15m ${c15.count}/${COVERAGE.rows15m}, since ${since} at ${cutoff.at}`;
  if (c1.count < COVERAGE.rows1m || c1.buys < COVERAGE.buys || c1.shorts < COVERAGE.shorts || c15.count < COVERAGE.rows15m) {
    return bad(`coverage short: ${summary}`);
  }
  return { status: 'verified', reason: `pass: ${summary}` };
}

/**
 * Converts a read_history result [bars, b, sr, bPlots, srPlots] into { <row_time>: first }
 * for closed bars only. A bar closes at t + period, the bar period taken from the smallest
 * gap between bar times. With fewer than two bars the period is unknown and the result is
 * empty. A bar with no matching b row (or sr row, when sr is given) is left out, so a
 * recorded row for it reads "absent". sr null (tab 2) stores sr null.
 */
export function toRows(readHistoryResult, nowMs) {
  requireMs(nowMs);
  if (!Array.isArray(readHistoryResult)) throw argError('read_history result must be an array');
  const [bars, b, sr] = readHistoryResult;
  if (!Array.isArray(bars) || !Array.isArray(b)) throw argError('read_history bars and b must be arrays');
  const period = periodFromTimes(bars.map((bar) => bar[0]));
  if (period === null) return {};
  const bByTime = new Map(b.map((row) => [row[0], row]));
  const srByTime = sr === null || sr === undefined ? null : new Map(sr.map((row) => [row[0], row]));
  const out = {};
  for (const bar of bars) {
    const t = bar[0];
    if ((t + period) * 1000 > nowMs) continue;
    const bRow = bByTime.get(t);
    if (!bRow) continue;
    let srRow = null;
    if (srByTime !== null) {
      srRow = srByTime.get(t);
      if (!srRow) continue;
    }
    out[String(t)] = { bar: bar.slice(), b: bRow.slice(), sr: srRow === null ? null : srRow.slice() };
  }
  return out;
}
