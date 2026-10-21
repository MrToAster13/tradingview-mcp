/**
 * Tests for the mc_basic_1m repaint check (design v14 lines 108-115, 157, 166). Pure: synthetic
 * rows and times only. No files, no CDP, no TradingView.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MISMATCH_PLOTS, valuesDiffer, newMismatches, storeNewRows, markFinal, computeStatus, toRows,
} from './repaint.mjs';

// ── Builders ─────────────────────────────────────────────────────────────

const T1 = 1_780_999_200; // unix s, divisible by 900 so 1m and 15m grids line up
const MIN = 60;
const QUARTER = 900;

/** Bar [t, o, h, l, c, v]; `over` maps an index to a value. */
function mkBar(t, over = {}) {
  const a = [t, 5000, 5001, 4999, 5000, 10];
  for (const [k, v] of Object.entries(over)) a[Number(k)] = v;
  return a;
}

/** B row [t, p1..p16]; plots default to 0 and `over` maps plot index to value. */
function mkB(t, over = {}) {
  const a = [t];
  for (let k = 1; k <= 16; k++) a.push(0);
  for (const [k, v] of Object.entries(over)) a[Number(k)] = v;
  return a;
}

/** SR row [t, p1..p5]. */
function mkSR(t, over = {}) {
  const a = [t, 0, 0, 0, 0, 0];
  for (const [k, v] of Object.entries(over)) a[Number(k)] = v;
  return a;
}

/** A first-shaped value. tab 1 carries SR, tab 2 carries null. */
function mkFirst(t, { bar, b, sr } = {}) {
  return {
    bar: bar ?? mkBar(t),
    b: b ?? mkB(t),
    sr: sr === undefined ? mkSR(t) : sr,
  };
}

/** Stored row as storeNewRows would write it on tab 1 (stored one second after the row's close + 5 s). */
function storedRow(tab, t, { first, valid = true, final = true, storedAt } = {}) {
  const period = tab === 'tab1' ? MIN : QUARTER;
  return {
    first: first ?? mkFirst(t, { sr: tab === 'tab1' ? mkSR(t) : null }),
    stored_at: storedAt ?? (t + period) * 1000 + 5000,
    valid,
    final,
  };
}

// ── MISMATCH_PLOTS ───────────────────────────────────────────────────────

describe('MISMATCH_PLOTS', () => {
  it('lists the B plots 2,4,6,8,15,16 and the SR plots 4,5 and is frozen', () => {
    assert.deepEqual(MISMATCH_PLOTS.b, [2, 4, 6, 8, 15, 16]);
    assert.deepEqual(MISMATCH_PLOTS.sr, [4, 5]);
    assert.equal(Object.isFrozen(MISMATCH_PLOTS), true);
    assert.equal(Object.isFrozen(MISMATCH_PLOTS.b), true);
    assert.equal(Object.isFrozen(MISMATCH_PLOTS.sr), true);
  });
});

// ── valuesDiffer ─────────────────────────────────────────────────────────

describe('valuesDiffer', () => {
  it('reports an equal row as not different, with separate copies', () => {
    const a = mkFirst(T1);
    const b = JSON.parse(JSON.stringify(a));
    assert.equal(valuesDiffer(a, b), false);
  });

  it('reports a changed watched B plot as different', () => {
    const a = mkFirst(T1, { b: mkB(T1, { 2: 10 }) });
    const b = mkFirst(T1, { b: mkB(T1, { 2: 11 }) });
    assert.equal(valuesDiffer(a, b), true);
    const c = mkFirst(T1, { b: mkB(T1, { 16: 1 }) });
    assert.equal(valuesDiffer(mkFirst(T1), c), true);
  });

  it('ignores a changed unwatched B plot', () => {
    const a = mkFirst(T1, { b: mkB(T1, { 3: 10, 5: 1, 10: 7 }) });
    const b = mkFirst(T1, { b: mkB(T1, { 3: 99, 5: -4, 10: 0 }) });
    assert.equal(valuesDiffer(a, b), false);
  });

  it('reports null against a number as different, in both directions', () => {
    const a = mkFirst(T1, { b: mkB(T1, { 4: null }) });
    const b = mkFirst(T1, { b: mkB(T1, { 4: 1.5 }) });
    assert.equal(valuesDiffer(a, b), true);
    assert.equal(valuesDiffer(b, a), true);
  });

  it('treats null against null as equal', () => {
    const a = mkFirst(T1, { b: mkB(T1, { 4: null, 6: null }) });
    const b = mkFirst(T1, { b: mkB(T1, { 4: null, 6: null }) });
    assert.equal(valuesDiffer(a, b), false);
  });

  it('uses the 1e-9 tolerance on finite values', () => {
    const base = mkFirst(T1, { b: mkB(T1, { 15: 50 }) });
    const tiny = mkFirst(T1, { b: mkB(T1, { 15: 50 + 5e-10 }) });
    const more = mkFirst(T1, { b: mkB(T1, { 15: 50 + 2e-9 }) });
    assert.equal(valuesDiffer(base, tiny), false);
    assert.equal(valuesDiffer(base, more), true);
  });

  it('reports a changed OHLC value as different', () => {
    const a = mkFirst(T1);
    const b = mkFirst(T1, { bar: mkBar(T1, { 2: 5002 }) });
    assert.equal(valuesDiffer(a, b), true);
    const c = mkFirst(T1, { bar: mkBar(T1, { 4: 4990 }) });
    assert.equal(valuesDiffer(a, c), true);
  });

  it('does not compare volume (design line 112 lists OHLC only)', () => {
    const a = mkFirst(T1);
    const b = mkFirst(T1, { bar: mkBar(T1, { 5: 999 }) });
    assert.equal(valuesDiffer(a, b), false);
  });

  it('reports a changed watched SR plot and ignores an unwatched one', () => {
    const a = mkFirst(T1, { sr: mkSR(T1, { 1: 1, 4: 100 }) });
    const watched = mkFirst(T1, { sr: mkSR(T1, { 1: 1, 4: 101 }) });
    const unwatched = mkFirst(T1, { sr: mkSR(T1, { 1: 9, 2: 9, 3: 9, 4: 100 }) });
    assert.equal(valuesDiffer(a, watched), true);
    assert.equal(valuesDiffer(a, unwatched), false);
    const plot5 = mkFirst(T1, { sr: mkSR(T1, { 5: 7 }) });
    assert.equal(valuesDiffer(mkFirst(T1, { sr: mkSR(T1) }), plot5), true);
  });

  it('treats two null SR rows (tab 2) as equal', () => {
    const a = mkFirst(T1, { sr: null });
    const b = mkFirst(T1, { sr: null });
    assert.equal(valuesDiffer(a, b), false);
  });

  it('compares "absent" with "absent" as equal and with a row as different', () => {
    assert.equal(valuesDiffer('absent', 'absent'), false);
    assert.equal(valuesDiffer('absent', mkFirst(T1)), true);
    assert.equal(valuesDiffer(mkFirst(T1), 'absent'), true);
  });

  it('rejects a value that is neither "absent" nor a first-shaped object', () => {
    assert.throws(() => valuesDiffer(42, mkFirst(T1)), (e) => e.code === 'E_ARGS');
    assert.throws(() => valuesDiffer(mkFirst(T1), { bar: [] }), (e) => e.code === 'E_ARGS');
    assert.throws(() => valuesDiffer(null, mkFirst(T1)), (e) => e.code === 'E_ARGS');
  });
});

// ── newMismatches ────────────────────────────────────────────────────────

describe('newMismatches', () => {
  const NOW = 1_781_000_000_000;

  it('returns nothing for an equal row', () => {
    const f = mkFirst(T1);
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: f } }, live: { [T1]: mkFirst(T1) }, now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it('adds an entry for a changed watched plot, with numeric row_time and detection time', () => {
    const live = { [T1]: mkFirst(T1, { b: mkB(T1, { 8: 5 }) }) };
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: mkFirst(T1) } }, live, now: NOW,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].tab, 'tab1');
    assert.equal(out[0].row_time, T1);
    assert.equal(out[0].detected_at, NOW);
    assert.deepEqual(out[0].values, live[T1]);
  });

  it('ignores a changed unwatched plot', () => {
    const live = { [T1]: mkFirst(T1, { b: mkB(T1, { 1: 77, 7: 3 }) }) };
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: mkFirst(T1) } }, live, now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it('adds an "absent" entry for a recorded row missing from the live read', () => {
    const out = newMismatches({
      tab: 'tab2', recorded: { [T1]: { first: mkFirst(T1, { sr: null }) } }, live: {}, now: NOW,
    });
    assert.equal(out.length, 1);
    assert.equal(out[0].tab, 'tab2');
    assert.equal(out[0].values, 'absent');
    assert.equal(out[0].detected_at, NOW);
  });

  it('does not add a second "absent" entry when history already holds "absent"', () => {
    const history = [{ kind: 'mismatch', tab: 'tab1', row_time: T1, values: 'absent', detected_at: NOW - 10 }];
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: mkFirst(T1) } }, live: {}, history, now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it('does not re-report a mismatch already in history when the live value still matches it', () => {
    const changed = mkFirst(T1, { b: mkB(T1, { 15: 42 }) });
    const history = [{ kind: 'mismatch', tab: 'tab1', row_time: T1, values: changed, detected_at: NOW - 10 }];
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: mkFirst(T1) } }, live: { [T1]: changed }, history, now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it('compares against the latest history value, not the first stored value', () => {
    const first = mkFirst(T1);
    const b1 = mkFirst(T1, { b: mkB(T1, { 2: 1 }) });
    const b2 = mkFirst(T1, { b: mkB(T1, { 2: 2 }) });
    const history = [{ kind: 'mismatch', tab: 'tab1', row_time: T1, values: b1, detected_at: NOW - 100 }];
    const recorded = { [T1]: { first } };
    // Live equals the latest history value: no new entry, even though it differs from first.
    assert.deepEqual(newMismatches({ tab: 'tab1', recorded, live: { [T1]: b1 }, history, now: NOW }), []);
    // Live changed again: one new entry.
    const again = newMismatches({ tab: 'tab1', recorded, live: { [T1]: b2 }, history, now: NOW });
    assert.equal(again.length, 1);
    // Live back at the first stored values: that differs from the latest, so it is a new change.
    const reverted = newMismatches({ tab: 'tab1', recorded, live: { [T1]: first }, history, now: NOW });
    assert.equal(reverted.length, 1);
  });

  it('uses the later of a history entry and a guard draw mismatch (guard uses its new value)', () => {
    const first = mkFirst(T1);
    const histVal = mkFirst(T1, { b: mkB(T1, { 2: 1 }) });
    const guardVal = mkFirst(T1, { b: mkB(T1, { 2: 3 }) });
    const recorded = { [T1]: { first } };
    const history = [{ kind: 'mismatch', tab: 'tab1', row_time: T1, values: histVal, detected_at: NOW - 200 }];
    const guardMismatches = [{ tab: 'tab1', row_time: T1, old: histVal, new: guardVal, detected_at: NOW - 100 }];
    assert.deepEqual(
      newMismatches({ tab: 'tab1', recorded, live: { [T1]: guardVal }, history, guardMismatches, now: NOW }),
      [],
    );
    const stale = newMismatches({ tab: 'tab1', recorded, live: { [T1]: histVal }, history, guardMismatches, now: NOW });
    assert.equal(stale.length, 1);
  });

  it('ignores guard and history entries for the other tab and for other rows', () => {
    const changed = mkFirst(T1, { b: mkB(T1, { 2: 9 }) });
    const history = [{ kind: 'mismatch', tab: 'tab2', row_time: T1, values: changed, detected_at: NOW - 5 }];
    const guardMismatches = [{ tab: 'tab1', row_time: T1 + 60, old: 'absent', new: changed, detected_at: NOW - 5 }];
    const out = newMismatches({
      tab: 'tab1', recorded: { [T1]: { first: mkFirst(T1) } }, live: { [T1]: changed }, history, guardMismatches, now: NOW,
    });
    assert.equal(out.length, 1);
  });

  it('does not report live rows that are not recorded yet', () => {
    const out = newMismatches({
      tab: 'tab1', recorded: {}, live: { [T1]: mkFirst(T1, { b: mkB(T1, { 2: 1 }) }) }, now: NOW,
    });
    assert.deepEqual(out, []);
  });

  it('checks every recorded row, including final ones', () => {
    const recorded = {
      [T1]: { first: mkFirst(T1), final: true },
      [T1 + 60]: { first: mkFirst(T1 + 60), final: false },
    };
    const live = { [T1]: mkFirst(T1, { b: mkB(T1, { 6: 1 }) }), [T1 + 60]: mkFirst(T1 + 60) };
    const out = newMismatches({ tab: 'tab1', recorded, live, now: NOW });
    assert.equal(out.length, 1);
    assert.equal(out[0].row_time, T1);
  });

  it('rejects an unknown tab and non-array history', () => {
    assert.throws(() => newMismatches({ tab: 'tab3', recorded: {}, live: {}, now: NOW }), (e) => e.code === 'E_ARGS');
    assert.throws(
      () => newMismatches({ tab: 'tab1', recorded: {}, live: {}, history: { entries: [] }, now: NOW }),
      (e) => e.code === 'E_ARGS',
    );
  });
});

// ── storeNewRows ─────────────────────────────────────────────────────────

describe('storeNewRows', () => {
  const closeMs = (t, period) => (t + period) * 1000;

  it('stores a closed bar when the next bar is first seen, valid when seen within 2 s of the close (tab 1)', () => {
    const live = { [T1]: mkFirst(T1) };
    const now = closeMs(T1, MIN) + 1000;
    const firstSeen = { [T1 + MIN]: closeMs(T1, MIN) + 1500 };
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now, firstSeen });
    assert.equal(out[T1].valid, true);
    assert.equal(out[T1].final, false);
    assert.equal(out[T1].stored_at, now);
    assert.deepEqual(out[T1].first, mkFirst(T1));
  });

  it('stores as invalid when the next bar is first seen more than 2 s after the close (tab 1)', () => {
    const live = { [T1]: mkFirst(T1) };
    const now = closeMs(T1, MIN) + 3000;
    const firstSeen = { [T1 + MIN]: closeMs(T1, MIN) + 3000 };
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now, firstSeen });
    assert.equal(out[T1].valid, false);
  });

  it('keeps the values as seen at storage, and copies them so the input is not aliased', () => {
    const live = { [T1]: mkFirst(T1, { b: mkB(T1, { 2: 4 }) }) };
    const now = closeMs(T1, MIN) + 1000;
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now, firstSeen: { [T1 + MIN]: now } });
    live[T1].b[2] = 999;
    assert.equal(out[T1].first.b[2], 4);
  });

  it('does not store a closed bar before the next bar is seen and before close + 5 s', () => {
    const live = { [T1]: mkFirst(T1) };
    const now = closeMs(T1, MIN) + 4999;
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now, firstSeen: {} });
    assert.deepEqual(out, {});
  });

  it('stores at close + 5 s as invalid when the next bar has not been seen (tab 1)', () => {
    const live = { [T1]: mkFirst(T1) };
    const now = closeMs(T1, MIN) + 5000;
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now, firstSeen: {} });
    assert.equal(out[T1].valid, false);
    assert.equal(out[T1].stored_at, now);
  });

  it('uses the 10 s tolerance and the 905 s timer on tab 2', () => {
    const live = { [T1]: mkFirst(T1, { sr: null }) };
    const close = closeMs(T1, QUARTER);
    const valid = storeNewRows({ tab: 'tab2', rows: {}, live, now: close + 10000, firstSeen: { [T1 + QUARTER]: close + 10000 } });
    assert.equal(valid[T1].valid, true);
    const invalid = storeNewRows({ tab: 'tab2', rows: {}, live, now: close + 10001, firstSeen: { [T1 + QUARTER]: close + 10001 } });
    assert.equal(invalid[T1].valid, false);
    const notYet = storeNewRows({ tab: 'tab2', rows: {}, live, now: close + 4999, firstSeen: {} });
    assert.deepEqual(notYet, {});
    const timer = storeNewRows({ tab: 'tab2', rows: {}, live, now: T1 * 1000 + 905 * 1000, firstSeen: {} });
    assert.equal(timer[T1].valid, false);
  });

  it('leaves rows that are already stored untouched, even when the live value differs', () => {
    const stored = storedRow('tab1', T1, { first: mkFirst(T1, { b: mkB(T1, { 2: 1 }) }) });
    const rows = { [T1]: stored };
    const live = { [T1]: mkFirst(T1, { b: mkB(T1, { 2: 2 }) }) };
    const out = storeNewRows({ tab: 'tab1', rows, live, now: closeMs(T1, MIN) + 9000, firstSeen: {} });
    assert.equal(out[T1], stored);
    assert.equal(out[T1].first.b[2], 1);
  });

  it('returns a new object and does not change the input rows', () => {
    const rows = {};
    const live = { [T1]: mkFirst(T1) };
    const out = storeNewRows({ tab: 'tab1', rows, live, now: closeMs(T1, MIN) + 5000, firstSeen: {} });
    assert.notEqual(out, rows);
    assert.deepEqual(rows, {});
  });

  it('stores nothing from a bar whose close is not reached and whose successor is not seen', () => {
    const live = { [T1]: mkFirst(T1) };
    const out = storeNewRows({ tab: 'tab1', rows: {}, live, now: closeMs(T1, MIN) - 1, firstSeen: { [T1 + MIN]: 1 } });
    assert.deepEqual(out, {});
  });

  it('rejects an unknown tab', () => {
    assert.throws(
      () => storeNewRows({ tab: 'x', rows: {}, live: {}, now: 1, firstSeen: {} }),
      (e) => e.code === 'E_ARGS',
    );
  });
});

// ── markFinal ────────────────────────────────────────────────────────────

describe('markFinal', () => {
  const closeT1 = (T1 + MIN) * 1000;
  const liveBars = () => ({ [T1]: mkFirst(T1), [T1 + MIN]: mkFirst(T1 + MIN) });

  it('marks final at 30 minutes after the close when the row matches', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false }) };
    const out = markFinal(rows, liveBars(), closeT1 + 30 * 60 * 1000);
    assert.equal(out[T1].final, true);
  });

  it('does not mark final before 30 minutes after the close', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false }) };
    const out = markFinal(rows, liveBars(), closeT1 + 30 * 60 * 1000 - 1);
    assert.equal(out[T1].final, false);
  });

  it('does not mark final a row whose live value differs from its stored values', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false }) };
    const live = { ...liveBars(), [T1]: mkFirst(T1, { b: mkB(T1, { 6: 1 }) }) };
    const out = markFinal(rows, live, closeT1 + 60 * 60 * 1000);
    assert.equal(out[T1].final, false);
  });

  it('does not mark final a row missing from the live read', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false }) };
    const live = { [T1 + MIN]: mkFirst(T1 + MIN), [T1 + 2 * MIN]: mkFirst(T1 + 2 * MIN) };
    const out = markFinal(rows, live, closeT1 + 60 * 60 * 1000);
    assert.equal(out[T1].final, false);
  });

  it('keeps a final row final even if a later live value differs', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: true }) };
    const live = { ...liveBars(), [T1]: mkFirst(T1, { b: mkB(T1, { 6: 1 }) }) };
    const out = markFinal(rows, live, closeT1 + 60 * 60 * 1000);
    assert.equal(out[T1].final, true);
  });

  it('uses the 900 s period from the live bars on tab 2 data', () => {
    const rows = { [T1]: storedRow('tab2', T1, { first: mkFirst(T1, { sr: null }), final: false }) };
    const live = { [T1]: mkFirst(T1, { sr: null }), [T1 + QUARTER]: mkFirst(T1 + QUARTER, { sr: null }) };
    const close = (T1 + QUARTER) * 1000;
    assert.equal(markFinal(rows, live, close + 30 * 60 * 1000 - 1)[T1].final, false);
    assert.equal(markFinal(rows, live, close + 30 * 60 * 1000)[T1].final, true);
  });

  it('marks nothing final when the period cannot be inferred from one live bar', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false }) };
    const out = markFinal(rows, { [T1]: mkFirst(T1) }, closeT1 + 60 * 60 * 1000);
    assert.equal(out[T1].final, false);
  });

  it('returns a new object and leaves valid and stored_at unchanged', () => {
    const rows = { [T1]: storedRow('tab1', T1, { final: false, valid: false }) };
    const out = markFinal(rows, liveBars(), closeT1 + 60 * 60 * 1000);
    assert.notEqual(out, rows);
    assert.equal(rows[T1].final, false);
    assert.equal(out[T1].valid, false);
    assert.equal(out[T1].stored_at, rows[T1].stored_at);
  });
});

// ── toRows ───────────────────────────────────────────────────────────────

describe('toRows', () => {
  const bars = (n) => Array.from({ length: n }, (_, i) => mkBar(T1 + i * MIN));
  const bRows = (n) => Array.from({ length: n }, (_, i) => mkB(T1 + i * MIN, { 2: i }));
  const srRows = (n) => Array.from({ length: n }, (_, i) => mkSR(T1 + i * MIN, { 4: i }));
  // now = T1 + 299 s: bars at T1, +60, +120, +180 have closed (close = t + 60); bar at +240 is open.
  const NOW = (T1 + 299) * 1000;

  it('keeps closed bars only and keys them by row time', () => {
    const out = toRows([bars(5), bRows(5), srRows(5)], NOW);
    assert.deepEqual(Object.keys(out).map(Number), [T1, T1 + 60, T1 + 120, T1 + 180]);
  });

  it('treats a bar as closed exactly at its close instant', () => {
    const at = toRows([bars(5), bRows(5), srRows(5)], (T1 + 300) * 1000);
    assert.equal(Object.keys(at).length, 5);
    const before = toRows([bars(5), bRows(5), srRows(5)], (T1 + 300) * 1000 - 1);
    assert.equal(Object.keys(before).length, 4);
  });

  it('joins the B and SR series by time, not by index', () => {
    const b = bRows(5).reverse();
    const sr = srRows(5).reverse();
    const out = toRows([bars(5), b, sr], NOW);
    assert.equal(out[T1 + 60].b[2], 1);
    assert.equal(out[T1 + 60].sr[4], 1);
    assert.equal(out[T1 + 60].bar[0], T1 + 60);
  });

  it('stores sr as null when the read has no SR series (tab 2)', () => {
    const out = toRows([bars(5), bRows(5), null], NOW);
    assert.equal(out[T1].sr, null);
  });

  it('leaves out a closed bar that has no matching B row, so it reads "absent" later', () => {
    const b = bRows(5).filter((row) => row[0] !== T1 + 60);
    const out = toRows([bars(5), b, srRows(5)], NOW);
    assert.equal(Object.hasOwn(out, String(T1 + 60)), false);
    assert.equal(Object.hasOwn(out, String(T1)), true);
  });

  it('returns nothing when the bar period cannot be inferred from one bar', () => {
    assert.deepEqual(toRows([[mkBar(T1)], [mkB(T1)], [mkSR(T1)]], NOW * 10), {});
    assert.deepEqual(toRows([[], [], []], NOW), {});
  });

  it('copies the values it returns', () => {
    const source = [bars(5), bRows(5), srRows(5)];
    const out = toRows(source, NOW);
    source[1][0][2] = 555;
    assert.equal(out[T1].b[2], 0);
  });

  it('rejects a read that is not an array', () => {
    assert.throws(() => toRows(null, NOW), (e) => e.code === 'E_ARGS');
  });
});

// ── computeStatus ────────────────────────────────────────────────────────

/** A passing recorder and history for a cut-off of START; every tests tweaks one thing. */
const START = T1 * 1000 - 3_600_000;
const NOW = (T1 + 18000) * 1000 + 30_000; // just after both newest rows closed
const N1 = 300;
const N15 = 20;

function guardOk(over = {}) {
  return {
    state: 'ok',
    guard: {
      broker_check: 'none', baseline_count: null, probe_key: null, count_refused: false, reset_count: 0,
      colour_ok: [], consumed_flags: [], draw_mismatches: [], lost_at: null, reset_stamps: [], ...over,
    },
  };
}

function fixture({ n1 = N1, n15 = N15, buys = 3, shorts = 3, now = NOW } = {}) {
  const rows = { tab1: {}, tab2: {} };
  for (let i = 0; i < n1; i++) {
    const t = T1 + i * MIN;
    rows.tab1[String(t)] = storedRow('tab1', t, {
      valid: true,
      final: true,
      // buy rows start at index 1 so that row 0 can be the mismatched row in cut-off tests
      first: mkFirst(t, {
        b: mkB(t, { 6: i >= 1 && i < 1 + buys ? 1 : 0, 8: i >= 10 && i < 10 + shorts ? 5 : 0, 2: i >= 10 && i < 10 + shorts ? 70 : 0 }),
      }),
    });
  }
  for (let i = 0; i < n15; i++) {
    const t = T1 + i * QUARTER;
    rows.tab2[String(t)] = storedRow('tab2', t, { first: mkFirst(t, { sr: null }) });
  }
  return {
    recorder: { state: 'ok', data: { rows, last_poll_t1: now - 1000, last_poll_t2: now - 1000, status: 'verified' } },
    history: { state: 'ok', data: { entries: [{ kind: 'start', detected_at: START }] } },
    guard: guardOk(),
    now,
    newestLive: { tab1: T1 + (n1 - 1) * MIN, tab2: T1 + (n15 - 1) * QUARTER },
  };
}

const statusOf = (over = {}, base = fixture()) => computeStatus({ ...base, ...over });

describe('computeStatus: pass rule', () => {
  it('verifies at 300 valid final 1m rows, 3 buys, 3 shorts and 20 valid final 15m rows', () => {
    const r = statusOf();
    assert.equal(r.status, 'verified');
    assert.match(r.reason, /^pass:/);
  });

  it('is unverified at 299 valid final 1m rows', () => {
    const r = statusOf({}, fixture({ n1: 299 }));
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /coverage short/);
  });

  it('is unverified with 2 Buy rows', () => {
    assert.equal(statusOf({}, fixture({ buys: 2 })).status, 'unverified');
  });

  it('is unverified with 2 short triggers', () => {
    assert.equal(statusOf({}, fixture({ shorts: 2 })).status, 'unverified');
  });

  it('is unverified with 19 valid final 15m rows', () => {
    assert.equal(statusOf({}, fixture({ n15: 19 })).status, 'unverified');
  });

  it('does not count a row that is not final', () => {
    const base = fixture();
    base.recorder.data.rows.tab1[String(T1 + 5 * MIN)].final = false;
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /1m 299\//);
  });

  it('does not count a row that is not valid', () => {
    const base = fixture();
    base.recorder.data.rows.tab2[String(T1)].valid = false;
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /15m 19\//);
  });

  it('counts a short trigger only when Blue Wave is at least 60', () => {
    const base = fixture({ shorts: 3 });
    const shortRow = base.recorder.data.rows.tab1[String(T1 + 10 * MIN)];
    shortRow.first.b[2] = 59;
    assert.equal(statusOf({}, base).status, 'unverified');
  });

  it('counts a Buy when plot 6 is finite and not zero (a null does not count)', () => {
    const base = fixture({ buys: 3 });
    base.recorder.data.rows.tab1[String(T1 + 1 * MIN)].first.b[6] = null;
    assert.equal(statusOf({}, base).status, 'unverified');
  });
});

describe('computeStatus: cut-off entries', () => {
  it('a mismatch cut-off excludes rows whose open time is not later than the mismatched row', () => {
    const base = fixture();
    base.history.data.entries.push({
      kind: 'mismatch', tab: 'tab1', row_time: T1, values: 'absent', detected_at: START + 500,
    });
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /1m 299\//);
  });

  it('a mismatch cut-off with a later row time counts only the rows after it', () => {
    const base = fixture();
    base.history.data.entries.push({
      kind: 'mismatch', tab: 'tab1', row_time: T1 + 100 * MIN, values: 'absent', detected_at: START + 500,
    });
    assert.equal(statusOf({}, base).status, 'unverified');
  });

  it('excludes rows stored at or before the cut-off detection time', () => {
    const base = fixture();
    const lostAt = base.recorder.data.rows.tab1[String(T1 + 99 * MIN)].stored_at;
    base.guard = guardOk({ lost_at: lostAt });
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /1m 200\//);
  });

  it('a lost_at cut-off counts as an entry with no row', () => {
    const base = fixture();
    base.guard = guardOk({ lost_at: START + 1 });
    assert.equal(statusOf({}, base).status, 'verified');
  });

  it('a broker-reset stamp is a cut-off with no row', () => {
    const base = fixture();
    const stamp = base.recorder.data.rows.tab1[String(T1 + 99 * MIN)].stored_at;
    base.guard = guardOk({ reset_stamps: [stamp] });
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /1m 200\//);
  });

  it('a row that has ever mismatched never counts toward coverage', () => {
    const base = fixture();
    base.history.data.entries.push({
      kind: 'mismatch', tab: 'tab1', row_time: T1, values: 'absent', detected_at: START + 500,
    });
    base.guard = guardOk({
      draw_mismatches: [{ tab: 'tab1', row_time: T1 + 100 * MIN, old: 'absent', new: 'absent', detected_at: START + 100 }],
    });
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /1m 298\//);
  });

  it('with no entries at all the status is unverified', () => {
    const base = fixture();
    base.history.data.entries = [];
    assert.equal(statusOf({}, base).status, 'unverified');
  });

  it('a malformed draw_mismatches array is unverified', () => {
    const base = fixture();
    base.guard = { state: 'ok', guard: { ...guardOk().guard, draw_mismatches: 'x' } };
    assert.equal(statusOf({}, base).status, 'unverified');
  });
});

describe('computeStatus: stale recorder', () => {
  it('a tab-1 poll 10 s old is fresh, one 10.001 s old is stale', () => {
    const fresh = fixture();
    fresh.recorder.data.last_poll_t1 = NOW - 10000;
    assert.equal(statusOf({}, fresh).status, 'verified');
    const stale = fixture();
    stale.recorder.data.last_poll_t1 = NOW - 10001;
    const r = statusOf({}, stale);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /stale: tab1/);
  });

  it('a tab-2 poll 15 s old is fresh, one 15.001 s old is stale', () => {
    const fresh = fixture();
    fresh.recorder.data.last_poll_t2 = NOW - 15000;
    assert.equal(statusOf({}, fresh).status, 'verified');
    const stale = fixture();
    stale.recorder.data.last_poll_t2 = NOW - 15001;
    const r = statusOf({}, stale);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /stale: tab2/);
  });

  it('a poll time that was never recorded counts as stale', () => {
    const base = fixture();
    base.recorder.data.last_poll_t1 = null;
    assert.equal(statusOf({}, base).status, 'unverified');
  });

  it('a newest closed 15m row missing from the records is stale', () => {
    const base = fixture();
    delete base.recorder.data.rows.tab2[String(T1 + (N15 - 1) * QUARTER)];
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /stale: newest closed tab2/);
    assert.equal(r.retry, undefined);
  });

  it('a newest closed 1m row missing from the records is stale once the 12 s wait has passed', () => {
    const base = fixture();
    const newest = T1 + (N1 - 1) * MIN;
    delete base.recorder.data.rows.tab1[String(newest)];
    const r = statusOf({}, base);
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /stale: newest closed tab1/);
  });

  it('a just-closed missing row asks the caller to wait and retry (within 12 s of the close)', () => {
    const newest = T1 + (N1 - 1) * MIN;
    const closeMs = (newest + MIN) * 1000;
    const now = closeMs + 5000;
    const base = fixture({ now });
    delete base.recorder.data.rows.tab1[String(newest)];
    const r = statusOf({ now }, base);
    assert.equal(r.status, 'unverified');
    assert.equal(r.retry, true);
  });

  it('a missing row 12 s after its close is stale, not retried', () => {
    const newest = T1 + (N1 - 1) * MIN;
    const closeMs = (newest + MIN) * 1000;
    const now = closeMs + 12001;
    const base = fixture({ now });
    delete base.recorder.data.rows.tab1[String(newest)];
    const r = statusOf({ now }, base);
    assert.match(r.reason, /stale: newest closed tab1/);
    assert.equal(r.retry, undefined);
  });

  it('a newest closed row that cannot be read (null) is unverified', () => {
    const r = statusOf({ newestLive: { tab1: null, tab2: T1 } });
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /cannot read tab1/);
  });

  it('a missing newestLive object is unverified', () => {
    assert.equal(statusOf({ newestLive: undefined }).status, 'unverified');
  });
});

describe('computeStatus: unreadable files', () => {
  it('a missing recorder.json is unverified', () => {
    const r = statusOf({ recorder: { state: 'missing', data: null } });
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /recorder\.json missing/);
  });

  it('a corrupt recorder.json is unverified', () => {
    assert.equal(statusOf({ recorder: { state: 'corrupt', data: null } }).status, 'unverified');
  });

  it('a missing mismatch_history.json is unverified', () => {
    const r = statusOf({ history: { state: 'missing', data: null } });
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /mismatch_history\.json missing/);
  });

  it('a corrupt mismatch_history.json is unverified', () => {
    assert.equal(statusOf({ history: { state: 'corrupt', data: null } }).status, 'unverified');
  });

  it('a missing guard.json that is not fresh is unverified', () => {
    const r = statusOf({ guard: { state: 'missing', guard: null, fresh: false } });
    assert.equal(r.status, 'unverified');
    assert.match(r.reason, /not fresh/);
  });

  it('a missing guard.json in the fresh state counts as no stored mismatches and can pass', () => {
    const r = statusOf({ guard: { state: 'missing', guard: null, fresh: true } });
    assert.equal(r.status, 'verified');
  });

  it('a corrupt guard.json is unverified, even when fresh is set', () => {
    assert.equal(statusOf({ guard: { state: 'corrupt', guard: null, fresh: true } }).status, 'unverified');
  });
});

describe('computeStatus: result shape', () => {
  it('returns only status and reason when verified or stale, and retry only for a just-closed missing row', () => {
    const ok = statusOf();
    assert.deepEqual(Object.keys(ok).sort(), ['reason', 'status']);
  });
});
