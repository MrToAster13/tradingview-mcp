// Tests for the pure helpers behind the multi-window collector.
// Run: node --test scripts/mc_b_dot/chartdata.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specFromSymbolInfo, nextReplayPoint, replayPointFromBars, windowName, shouldStop } from './chartdata.mjs';

// Unix seconds for a UTC wall-clock time.
const utc = (y, mo, d, h, mi) => Date.UTC(y, mo - 1, d, h, mi) / 1000;

// ---- specFromSymbolInfo ------------------------------------------------------

test('specFromSymbolInfo gives tick 0.1 exactly for minmov 1 and pricescale 10', () => {
  const s = specFromSymbolInfo({ minmov: 1, pricescale: 10, pointvalue: 1 });
  assert.equal(s.tick, 0.1);
  assert.equal(s.pointValue, 1);
});

test('specFromSymbolInfo gives 0.25 for minmov 1 and pricescale 4', () => {
  assert.equal(specFromSymbolInfo({ minmov: 1, pricescale: 4, pointvalue: 1 }).tick, 0.25);
});

test('specFromSymbolInfo gives 0.01 for minmov 1 and pricescale 100', () => {
  assert.equal(specFromSymbolInfo({ minmov: 1, pricescale: 100, pointvalue: 1 }).tick, 0.01);
});

test('specFromSymbolInfo gives tick 1 for minmov 1 and pricescale 1', () => {
  assert.equal(specFromSymbolInfo({ minmov: 1, pricescale: 1, pointvalue: 1 }).tick, 1);
});

test('specFromSymbolInfo gives 0.25 for MES style minmov 25 and pricescale 100', () => {
  assert.equal(specFromSymbolInfo({ minmov: 25, pricescale: 100, pointvalue: 5 }).tick, 0.25);
});

test('specFromSymbolInfo rounds the tick to 10 decimals', () => {
  assert.equal(specFromSymbolInfo({ minmov: 1, pricescale: 3, pointvalue: 1 }).tick, 0.3333333333);
});

test('specFromSymbolInfo passes pointvalue through unchanged', () => {
  assert.equal(specFromSymbolInfo({ minmov: 1, pricescale: 100, pointvalue: 50 }).pointValue, 50);
});

test('specFromSymbolInfo throws when a field is missing, not finite, or not above zero', () => {
  const bad = [
    { minmov: undefined, pricescale: 10, pointvalue: 1 },
    { minmov: 1, pricescale: null, pointvalue: 1 },
    { minmov: 1, pricescale: 10, pointvalue: undefined },
    { minmov: NaN, pricescale: 10, pointvalue: 1 },
    { minmov: 1, pricescale: Infinity, pointvalue: 1 },
    { minmov: 0, pricescale: 10, pointvalue: 1 },
    { minmov: 1, pricescale: -10, pointvalue: 1 },
    { minmov: 1, pricescale: 10, pointvalue: 0 },
    { minmov: 1, pricescale: 10, pointvalue: '50' },
  ];
  for (const info of bad) {
    assert.throws(() => specFromSymbolInfo(info), /must be a finite number above 0/, JSON.stringify(info));
  }
});

test('specFromSymbolInfo throws when the rounded tick would be zero', () => {
  assert.throws(() => specFromSymbolInfo({ minmov: 1, pricescale: 1e11, pointvalue: 1 }), /tick/);
});

// ---- nextReplayPoint ---------------------------------------------------------

test('nextReplayPoint moves overlap bars past the first bar and returns milliseconds', () => {
  // 400 bars of 60 s each is 24000 s.
  assert.equal(nextReplayPoint(1000000000, 400), (1000000000 + 24000) * 1000);
});

test('nextReplayPoint with zero overlap returns the first bar time in milliseconds', () => {
  assert.equal(nextReplayPoint(1700000000, 0), 1700000000000);
});

test('nextReplayPoint throws on a non-finite first bar time or overlap', () => {
  assert.throws(() => nextReplayPoint(NaN, 400), /finite/);
  assert.throws(() => nextReplayPoint(null, 400), /finite/);
  assert.throws(() => nextReplayPoint(1700000000, NaN), /finite/);
  assert.throws(() => nextReplayPoint(1700000000, -1), /finite/);
});

// Review round 3, finding 1. Clock-minute overlap across a weekend shares fewer bars than asked,
// and grid then refuses the symbol. The replay point must be the time of bar overlapBars.
test('replayPointFromBars counts the overlap in bars across a weekend close', () => {
  const fri = utc(2026, 9, 25, 20, 50);
  const sun = utc(2026, 9, 27, 22, 0);
  const bars = [
    ...Array.from({ length: 10 }, (_, k) => [fri + k * 60, 1, 1, 1, 1, 0]),
    ...Array.from({ length: 30 }, (_, k) => [sun + k * 60, 1, 1, 1, 1, 0]),
  ];
  assert.equal(replayPointFromBars(bars, 15), (sun + 5 * 60) * 1000);
  assert.equal(replayPointFromBars(bars, 0), fri * 1000);
});

test('replayPointFromBars goes one bar past the end when the overlap covers the whole window', () => {
  const bars = [[600, 1, 1, 1, 1, 0], [660, 1, 1, 1, 1, 0]];
  assert.equal(replayPointFromBars(bars, 5), 720 * 1000);
});

test('replayPointFromBars refuses no bars, a bad bar time or an overlap that is not a whole number 0 or more', () => {
  assert.throws(() => replayPointFromBars([], 10), /no bars/);
  assert.throws(() => replayPointFromBars([[NaN, 1, 1, 1, 1, 0]], 0), /finite/);
  assert.throws(() => replayPointFromBars([[600, 1, 1, 1, 1, 0]], -1), /overlap/);
  assert.throws(() => replayPointFromBars([[600, 1, 1, 1, 1, 0]], 1.5), /overlap/);
});

// ---- windowName --------------------------------------------------------------

test('windowName matches the MES example from the spec', () => {
  assert.equal(
    windowName('CME_MINI:MES1!', utc(2026, 10, 11, 22, 0), utc(2026, 10, 26, 19, 39)),
    'CME_MINI_MES1__20261011T2200_20261026T1939',
  );
});

test('windowName replaces every non-alphanumeric character of the symbol', () => {
  assert.equal(
    windowName('NYMEX:CL1!', utc(2026, 10, 11, 22, 0), utc(2026, 10, 26, 19, 39)),
    'NYMEX_CL1__20261011T2200_20261026T1939',
  );
});

test('windowName pads month, day, hour and minute to two digits', () => {
  assert.equal(
    windowName('X', utc(2026, 1, 2, 3, 4), utc(2026, 1, 2, 5, 6)),
    'X_20260102T0304_20260102T0506',
  );
});

test('windowName uses UTC even when the local zone differs', () => {
  // 2026-07-01T00:30Z is still June 30 in some zones; the name must say 0701 0030.
  assert.equal(windowName('X', utc(2026, 7, 1, 0, 30), utc(2026, 7, 1, 0, 31)), 'X_20260701T0030_20260701T0031');
});

test('windowName throws on non-finite times', () => {
  assert.throws(() => windowName('X', NaN, utc(2026, 1, 1, 0, 0)), /finite/);
  assert.throws(() => windowName('X', utc(2026, 1, 1, 0, 0), null), /finite/);
});

// ---- shouldStop --------------------------------------------------------------

test('shouldStop stops when firstT is null, even on the first window', () => {
  assert.equal(shouldStop({ prevFirstT: null, firstT: null, windows: 1, maxWindows: 12 }), true);
  assert.equal(shouldStop({ prevFirstT: 500, firstT: null, windows: 3, maxWindows: 12 }), true);
});

test('shouldStop continues on the first replay window when firstT is set', () => {
  assert.equal(shouldStop({ prevFirstT: null, firstT: 500, windows: 1, maxWindows: 12 }), false);
});

test('shouldStop stops when firstT equals prevFirstT (no older data came back)', () => {
  assert.equal(shouldStop({ prevFirstT: 500, firstT: 500, windows: 2, maxWindows: 12 }), true);
});

test('shouldStop stops when firstT is newer than prevFirstT', () => {
  assert.equal(shouldStop({ prevFirstT: 500, firstT: 520, windows: 2, maxWindows: 12 }), true);
});

test('shouldStop continues when firstT is older than prevFirstT by one second', () => {
  assert.equal(shouldStop({ prevFirstT: 500, firstT: 499, windows: 2, maxWindows: 12 }), false);
});

test('shouldStop stops when windows reaches maxWindows', () => {
  assert.equal(shouldStop({ prevFirstT: 500, firstT: 400, windows: 12, maxWindows: 12 }), true);
});

test('shouldStop continues one window below maxWindows', () => {
  assert.equal(shouldStop({ prevFirstT: 500, firstT: 400, windows: 11, maxWindows: 12 }), false);
});
