// Tests for the MC B dot per-instrument grid runner. Run: node --test scripts/mc_b_dot/grid.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  windowRanges, runWindows, splitByTime, splitTimeOf, splitAt, combos, pickBest, specFor, DEFAULT_GRID,
} from './grid.mjs';
import { prepare, simulate, summarize } from './sweep.mjs';

const CLI = fileURLToPath(new URL('./grid.mjs', import.meta.url));

// Bars one minute apart from t0. Rows are [open, high, low, close, extra plot values].
function win(t0, rows) {
  return rows.map(([o, h, l, c, extra = {}], i) => ({
    t: t0 + i * 60, o, h, l, c,
    mf: null, wave: null, up: null, dn: null, ph: null, pl: null, res: null, sup: null,
    ...extra,
  }));
}
const LONG = { mf: 30, wave: -20, up: -20 };

// ---- windowRanges ----------------------------------------------------------------

test('windowRanges sorts oldest first, starts each window after warm-up and ends it at the next window', () => {
  const metas = [
    { symbol: 'X', firstT: 1000 },
    { symbol: 'X', firstT: 0 },
    { symbol: 'X', firstT: 500 },
  ];
  const r = windowRanges(metas, 10); // 10 bars is 600 seconds
  assert.deepEqual(r.map((w) => w.firstT), [0, 500, 1000]);
  assert.deepEqual(r.map((w) => w.fromT), [600, 1100, 1600]);
  assert.deepEqual(r.map((w) => w.toT), [1100, 1600, Infinity]);
  assert.equal(r[0].symbol, 'X', 'meta fields are kept');
});

test('windowRanges gives one window to a single meta and rejects two metas with the same firstT', () => {
  assert.deepEqual(windowRanges([{ firstT: 60 }], 0), [{ firstT: 60, fromT: 60, toT: Infinity }]);
  assert.deepEqual(windowRanges([], 300), []);
  assert.throws(() => windowRanges([{ firstT: 60 }, { firstT: 60 }], 0), /firstT/);
});

// ---- runWindows ------------------------------------------------------------------

// Window A starts at t=0. Its signals are at t=60 (no target level, skipped) and t=120 (trade).
// Window B starts at t=60 and shares t=120, so the same signal sits in both windows' bars.
// Ranges split at t=180: A keeps signals before 180, B keeps signals from 180 on.
// A's trade enters at 180 and exits at 240. B's signal at t=300 enters at 360 and exits at 420.
function twoWindows() {
  const A = {
    s: win(0, [
      [100, 101, 99, 100],
      [100, 101, 99, 100, LONG],
      [100, 101, 99, 100, { ...LONG, res: 105 }],
      [100, 101, 99.5, 100],
      [100, 105, 99.5, 104],
      [100, 101, 99, 100],
    ]),
    fromT: 0, toT: 180,
  };
  const B = {
    s: win(60, [
      [100, 101, 99, 100],
      [100, 101, 99, 100, { ...LONG, res: 105 }],
      [100, 101, 99.5, 100],
      [100, 105, 99.5, 104],
      [100, 101, 99, 100, { ...LONG, res: 105 }],
      [100, 101, 99.5, 100],
      [100, 105, 99.5, 104],
    ]),
    fromT: 180, toT: Infinity,
  };
  return { A, B };
}

test('runWindows counts a signal present in two overlapping windows once, in the window that owns its time', () => {
  const { A, B } = twoWindows();
  const { trades, skipped } = runWindows([A, B], { tp: 'live', sl: 'swing10' });
  assert.deepEqual(trades.map((t) => [t.entryT, t.exitT, t.reason, t.net]), [
    [180, 240, 'target', 24],
    [360, 420, 'target', 24],
  ]);
  assert.deepEqual(skipped, { busy: 0, no_stop: 0, no_target: 1 });
});

test('runWindows returns trades oldest first even when the windows arrive newest first', () => {
  const { A, B } = twoWindows();
  const { trades } = runWindows([B, A], { tp: 'live', sl: 'swing10' });
  assert.deepEqual(trades.map((t) => t.entryT), [180, 360]);
});

test('runWindows drops a trade still open at the end of the data', () => {
  const s = win(0, [
    [100, 101, 99, 100],
    [100, 101, 99, 100, { ...LONG, res: 105 }],
    [100, 101, 99.5, 100],
  ]);
  const r = runWindows([{ s, fromT: -Infinity, toT: Infinity }], { tp: 'live', sl: 'swing10' });
  assert.deepEqual(r.trades, []);
  assert.deepEqual(r.skipped, { busy: 0, no_stop: 0, no_target: 0 });
});

// ---- splitByTime -----------------------------------------------------------------

test('splitByTime puts the first 60 percent of 10 trades by entry time in train and the rest in test', () => {
  const trades = [9, 3, 7, 1, 5, 10, 2, 8, 4, 6].map((n) => ({ entryT: n * 60, net: n }));
  const r = splitByTime(trades, 0.6);
  assert.deepEqual(r.train.map((t) => t.entryT), [60, 120, 180, 240, 300, 360]);
  assert.deepEqual(r.test.map((t) => t.entryT), [420, 480, 540, 600]);
  assert.equal(r.splitT, 420);
});

test('splitByTime has a null splitT when test is empty, and rejects a fraction outside 0..1', () => {
  assert.deepEqual(splitByTime([], 0.6), { train: [], test: [], splitT: null });
  const one = splitByTime([{ entryT: 60 }, { entryT: 120 }], 1);
  assert.equal(one.train.length, 2);
  assert.equal(one.test.length, 0);
  assert.equal(one.splitT, null);
  assert.throws(() => splitByTime([], 1.5));
});

// ---- combos ----------------------------------------------------------------------

test('combos is the cartesian product in grid key order, first key slowest', () => {
  const c = combos({ mfMode: ['with', 'either'], mfLevel: [23, 25], tp: ['free1', 'r2'], sl: ['swing5'], stopTicks: [0, 1] });
  assert.equal(c.length, 16);
  assert.deepEqual(Object.keys(c[0]), ['mfMode', 'mfLevel', 'tp', 'sl', 'stopTicks']);
  assert.deepEqual(c[0], { mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing5', stopTicks: 0 });
  assert.deepEqual(c[1], { mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing5', stopTicks: 1 });
  assert.deepEqual(c[2], { mfMode: 'with', mfLevel: 23, tp: 'r2', sl: 'swing5', stopTicks: 0 });
  assert.deepEqual(c[4], { mfMode: 'with', mfLevel: 25, tp: 'free1', sl: 'swing5', stopTicks: 0 });
  assert.deepEqual(c[8], { mfMode: 'either', mfLevel: 23, tp: 'free1', sl: 'swing5', stopTicks: 0 });
  assert.deepEqual(c[15], { mfMode: 'either', mfLevel: 25, tp: 'r2', sl: 'swing5', stopTicks: 1 });
});

test('combos of the default grid is 2 x 3 x 1 x 8 x 4 x 2 x 1 = 384, and an empty axis gives none', () => {
  assert.equal(combos(DEFAULT_GRID).length, 384);
  assert.deepEqual(combos({ mfMode: ['with'], tp: [] }), []);
});

// ---- pickBest --------------------------------------------------------------------

const row = (name, train = {}, test = {}) => ({
  params: { name },
  train: { trades: 40, pf: 1, net: 0, ...train },
  test: { trades: 40, pf: 1, net: 0, ...test },
});

test('pickBest ranks by train only, so the test numbers cannot change the pick', () => {
  const a = row('a', { pf: 2, net: 100 }, { pf: 0.1, net: -500 });
  const b = row('b', { pf: 1.5, net: 300 }, { pf: 9, net: 9000 });
  assert.equal(pickBest([a, b], { minTrades: 30 }).params.name, 'a');
  const swapped = pickBest([row('a', { pf: 2, net: 100 }, { pf: 9, net: 9000 }), row('b', { pf: 1.5, net: 300 }, { pf: 0.1, net: -500 })], { minTrades: 30 });
  assert.equal(swapped.params.name, 'a');
});

test('pickBest respects minTrades on train (inclusive) and skips rows with no train profit factor', () => {
  const few = row('few', { trades: 29, pf: 9 });
  const enough = row('enough', { trades: 30, pf: 1.2 });
  const noLoss = row('noloss', { trades: 50, pf: null, net: 900 });
  assert.equal(pickBest([few, enough], { minTrades: 30 }).params.name, 'enough');
  assert.equal(pickBest([few, noLoss], { minTrades: 30 }), null);
});

test('pickBest breaks a profit factor tie on higher train net, and ranks by another field when asked', () => {
  const p = row('p', { pf: 2, net: 100 });
  const q = row('q', { pf: 2, net: 300 });
  assert.equal(pickBest([p, q], { minTrades: 1 }).params.name, 'q');
  const r1 = row('r1', { pf: 2, net: 100 });
  const r2 = row('r2', { pf: 1.5, net: 300 });
  assert.equal(pickBest([r1, r2], { minTrades: 1, by: 'net' }).params.name, 'r2');
  assert.equal(pickBest([], { minTrades: 1 }), null);
});

// ---- specFor ---------------------------------------------------------------------

test('specFor takes the tick from minmov over pricescale, so pricescale 10 gives a 0.1 tick', () => {
  assert.deepEqual(specFor({ minmov: 1, pricescale: 10, pointvalue: 50 }, 1), { tick: 0.1, pointValue: 50, fee: 1 });
  assert.deepEqual(specFor({ minmov: 1, pricescale: 4, pointvalue: 5 }, 1.5), { tick: 0.25, pointValue: 5, fee: 1.5 });
});

test('specFor rounds the tick to 10 decimals and throws when minmov, pricescale, pointvalue or fee is missing', () => {
  assert.equal(specFor({ minmov: 1, pricescale: 3, pointvalue: 5 }, 1).tick, 0.3333333333);
  assert.throws(() => specFor({ pricescale: 10, pointvalue: 5 }, 1), /minmov/);
  assert.throws(() => specFor({ minmov: 1, pointvalue: 5 }, 1), /pricescale/);
  assert.throws(() => specFor({ minmov: 1, pricescale: 10 }, 1), /pointvalue/);
  assert.throws(() => specFor({ minmov: 1, pricescale: 10, pointvalue: 5 }), /fee/);
});

// ---- CLI -------------------------------------------------------------------------

// One price path shared by both files, so the overlap holds identical bars and signals.
function globalSeries(count) {
  let seed = 7;
  const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
  const q = (x) => Math.round(x * 4) / 4;
  const out = { bars: [], b: [], sr: [] };
  let c = 5000;
  for (let k = 0; k < count; k++) {
    const t = k * 60;
    const o = c;
    c = q(o + (rnd() - 0.5) * 4);
    const h = q(Math.max(o, c) + rnd() * 2);
    const l = q(Math.min(o, c) - rnd() * 2);
    const longDot = k % 15 === 5;
    const shortDot = k % 15 === 10;
    out.bars.push([t, o, h, l, c, 1000]);
    out.b.push([t, 0, longDot ? -20 : shortDot ? 20 : 0, 0, shortDot ? -30 : 30, 0, 0, longDot ? -20 : 0, shortDot ? 20 : 0]);
    out.sr.push([t, 0, 0, 0, q(c + 3), q(c - 3), 0]);
  }
  return out;
}

test('the CLI writes a per-symbol report with spec, windows, best or null, reference and rows', () => {
  const g = globalSeries(900);
  const slice = (from, n) => ({
    meta: {
      symbol: 'TESTMES', resolution: '1', minmov: 1, pricescale: 4, pointvalue: 5,
      currency: 'USD', replay: true, firstT: g.bars[from][0], lastT: g.bars[from + n - 1][0],
    },
    bars: g.bars.slice(from, from + n), b: g.b.slice(from, from + n), sr: g.sr.slice(from, from + n),
  });
  const A = slice(0, 600);
  const B = slice(300, 600);
  const dir = mkdtempSync(join(tmpdir(), 'grid-test-'));
  const out = join(dir, '..', `grid-out-${process.pid}.json`);
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(A));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(B));
    const run = spawnSync(process.execPath, [CLI, dir, out, '--warmup', '300', '--min-trades', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /TESTMES/);

    const report = JSON.parse(readFileSync(out, 'utf8'));
    assert.equal(typeof report.generatedAt, 'string');
    const sym = report.symbols.TESTMES;
    assert.ok(sym, 'symbol present');
    assert.deepEqual(sym.spec, { tick: 0.25, pointValue: 5, fee: 1 });
    assert.equal(sym.windows.length, 2);
    assert.equal(sym.windows[0].fromT, A.meta.firstT + 300 * 60);
    assert.equal(sym.windows[0].toT, B.meta.firstT + 300 * 60);
    assert.equal(sym.windows[1].toT, null, 'newest window has no upper bound');
    assert.equal(sym.rows.length, 384);
    assert.ok(sym.best === null || (sym.best.train.trades >= 1 && typeof sym.best.train.pf === 'number'));
    assert.deepEqual(sym.reference.params, { mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing10', stopTicks: 0 });
    assert.equal(sym.reference.train.trades + sym.reference.test.trades, sym.reference.all.trades);

    // The reference row must match the library run over the same windows.
    const metas = [A, B].map((w, k) => ({ ...w.meta, file: ['a.json', 'b.json'][k] }));
    const ranges = windowRanges(metas, 300);
    const wins = ranges.map((r) => ({ s: prepare([A, B][r.file === 'a.json' ? 0 : 1]), fromT: r.fromT, toT: r.toT }));
    const expected = summarize(runWindows(wins, {
      mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing10', stopTicks: 0, spec: { tick: 0.25, pointValue: 5, fee: 1 },
    }).trades);
    assert.equal(sym.reference.all.trades, expected.trades);
    assert.equal(sym.reference.all.net, expected.net);

    const strict = spawnSync(process.execPath, [CLI, dir, out, '--min-trades', '100000'], { encoding: 'utf8' });
    assert.equal(strict.status, 0, strict.stderr);
    assert.equal(JSON.parse(readFileSync(out, 'utf8')).symbols.TESTMES.best, null, '--min-trades is honoured');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});

// ---- one account across windows, one split per symbol ----------------------------

// One series in two ranges. The signal at t=120 belongs to the first range and trades from 180
// to 420. The signal at t=240 belongs to the second range, so its own simulation takes it at 300,
// while the first trade is still open. One account can hold only one of them.
test('runWindows drops a trade that enters before the previous window\'s trade exits, and counts it busy', () => {
  const s = win(0, [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100, { ...LONG, res: 110 }],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100, { ...LONG, res: 110 }],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100],
    [100, 111, 99.5, 110],
  ]);
  const r = runWindows([{ s, fromT: 0, toT: 240 }, { s, fromT: 240, toT: Infinity }], { tp: 'live', sl: 'swing10' });
  assert.deepEqual(r.trades.map((t) => [t.entryT, t.exitT, t.reason, t.net]), [[180, 420, 'target', 49]]);
  assert.equal(r.skipped.busy, 1);
});

test('splitTimeOf is the bar time at the train fraction of the bars each window counts', () => {
  const { A, B } = twoWindows();
  // A counts t = 0, 60, 120 (toT 180). B counts t = 180 .. 420. Eight bars in all.
  assert.equal(splitTimeOf([A, B], 0.5), 240);
  assert.equal(splitTimeOf([B, A], 0.25), 120);
  assert.equal(splitTimeOf([A, B], 1), null);
  assert.equal(splitTimeOf([], 0.6), null);
  assert.throws(() => splitTimeOf([A, B], -0.1));
});

test('splitAt puts trades entering before splitT in train and the rest in test', () => {
  const trades = [300, 60, 240, 180].map((entryT) => ({ entryT }));
  const r = splitAt(trades, 240);
  assert.deepEqual(r.train.map((t) => t.entryT), [60, 180]);
  assert.deepEqual(r.test.map((t) => t.entryT), [240, 300]);
  assert.equal(r.splitT, 240);
  assert.deepEqual(splitAt(trades, null).test, [], 'no split time means everything is train');
});

test('the CLI splits every row of a symbol at the same time, so test numbers cover one span', () => {
  const g = globalSeries(900);
  const meta = { symbol: 'TESTMES', resolution: '1', minmov: 1, pricescale: 4, pointvalue: 5, currency: 'USD', replay: true };
  const slice = (from, n) => ({
    meta: { ...meta, firstT: g.bars[from][0], lastT: g.bars[from + n - 1][0] },
    bars: g.bars.slice(from, from + n), b: g.b.slice(from, from + n), sr: g.sr.slice(from, from + n),
  });
  const dir = mkdtempSync(join(tmpdir(), 'grid-split-'));
  const out = join(dir, '..', `grid-split-${process.pid}.json`);
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(slice(0, 600)));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(slice(300, 600)));
    const run = spawnSync(process.execPath, [CLI, dir, out, '--warmup', '300', '--min-trades', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const sym = JSON.parse(readFileSync(out, 'utf8')).symbols.TESTMES;
    // Counted bars run from 300*60 to the end of b.json: 600 bars, so 0.6 splits at bar 300 + 360.
    assert.equal(sym.splitT, (300 + 360) * 60);
    assert.ok(sym.rows.every((r) => r.splitT === sym.splitT));
    assert.equal(sym.reference.splitT, sym.splitT);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});

// ---- review findings: one stitched series per symbol ------------------------------

// Finding 1. B's own run takes the t=240 signal at 300, which blocks its t=480 signal. One account
// is free again after 420, so it takes the 480 signal at 540.
test('runWindows keeps a later trade that one account takes after a cross-window overlap', () => {
  const s = win(0, [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100, { ...LONG, res: 110 }],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100, { ...LONG, res: 120 }],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100],
    [100, 111, 99.5, 110],
    [110, 110.5, 109.5, 110, { ...LONG, res: 115 }],
    [110, 110.5, 109.5, 110],
    [110, 115, 109.5, 114],
    [114, 114.5, 113.5, 114],
  ]);
  const r = runWindows([{ s, fromT: 0, toT: 240 }, { s, fromT: 240, toT: Infinity }], { tp: 'live', sl: 'swing10' });
  assert.deepEqual(r.trades.map((t) => [t.entryT, t.exitT, t.reason]), [[180, 420, 'target'], [540, 600, 'target']]);
  assert.equal(r.skipped.busy, 1);
});

// Finding 2. A's data ends at 180 with the trade open. B's bars carry it to its target at 300.
test('runWindows finishes a trade that is still open when an older window\'s data ends', () => {
  const full = win(0, [
    [100, 101, 99, 100],
    [100, 101, 99, 100, { ...LONG, res: 110 }],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100],
    [100, 101, 99.5, 100],
    [100, 111, 99.5, 110],
    [110, 110.5, 109.5, 110],
  ]);
  const r = runWindows([{ s: full.slice(0, 4), fromT: 0, toT: 180 }, { s: full.slice(2), fromT: 180, toT: Infinity }],
    { tp: 'live', sl: 'swing10' });
  assert.deepEqual(r.trades.map((t) => [t.entryT, t.exitT, t.reason]), [[120, 300, 'target']]);
});

// Finding 3. Res 103 is plotted at t=0 in the older window and never traded through, so it is still
// the nearest free level when the newer window's long fires at t=660.
test('runWindows keeps free Cipher levels plotted in an older window', () => {
  const full = [];
  for (let k = 0; k < 14; k++) {
    full.push(...win(k * 60, [[100, 101, 99, 100, k === 0 ? { res: 103 } : k === 10 ? { res: 108 } : k === 11 ? LONG : {}]]));
  }
  full.push(...win(14 * 60, [[100, 109, 99.5, 108]]));
  const r = runWindows([{ s: full.slice(0, 8), fromT: 0, toT: 600 }, { s: full.slice(5), fromT: 600, toT: Infinity }],
    { tp: 'free1', sl: 'swing10' });
  assert.equal(r.trades[0]?.target, 103);
});

// Finding 4. CME closes Friday 21:00 UTC and reopens Sunday 22:00. A 300-bar warm-up must hold 300 bars.
test('windowRanges counts the warm-up in bars when the window carries its bar times', () => {
  const fri = Date.UTC(2026, 9, 23, 20, 30) / 1000;
  const sun = Date.UTC(2026, 9, 25, 22, 0) / 1000;
  const times = [];
  for (let k = 0; k < 30; k++) times.push(fri + k * 60);
  for (let k = 0; k < 600; k++) times.push(sun + k * 60);
  const [w] = windowRanges([{ firstT: times[0], times }], 300);
  assert.equal(w.fromT, times[300]);
  const [short] = windowRanges([{ firstT: times[0], times: times.slice(0, 300) }], 300);
  assert.equal(short.fromT, Infinity, 'a window no longer than its warm-up counts nothing');
});

// Finding 5. The older window ends at t=300 but owns up to 480, so t=360 and 420 sit only in the
// newer window's warm-up. They are still bars of the instrument and must count.
test('runWindows and splitTimeOf count bars that only a newer window\'s warm-up holds', () => {
  const full = win(0, [
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100],
    [100, 101, 99, 100, { ...LONG, res: 105 }],
    [100, 101, 99.5, 100],
    [100, 105, 99.5, 104],
    [104, 104.5, 103.5, 104],
    [104, 104.5, 103.5, 104],
    [104, 104.5, 103.5, 104],
  ]);
  const windows = [{ s: full.slice(0, 6), fromT: 0, toT: 480 }, { s: full.slice(3), fromT: 480, toT: Infinity }];
  const r = runWindows(windows, { tp: 'live', sl: 'swing10' });
  assert.deepEqual(r.trades.map((t) => [t.entryT, t.exitT, t.reason]), [[420, 480, 'target']]);
  assert.equal(splitTimeOf(windows, 0.5), 360, '12 counted bars, so half is bar 6');
});

// Finding 6. The expected numbers come from one simulate over the whole series, not from runWindows.
test('the CLI reference row matches one simulate over the whole series after the first warm-up', () => {
  const g = globalSeries(900);
  const meta = { symbol: 'TESTMES', resolution: '1', minmov: 1, pricescale: 4, pointvalue: 5, currency: 'USD', replay: true };
  const slice = (from, n) => ({
    meta: { ...meta, firstT: g.bars[from][0], lastT: g.bars[from + n - 1][0] },
    bars: g.bars.slice(from, from + n), b: g.b.slice(from, from + n), sr: g.sr.slice(from, from + n),
  });
  const dir = mkdtempSync(join(tmpdir(), 'grid-ref-'));
  const out = join(dir, '..', `grid-ref-${process.pid}.json`);
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(slice(0, 600)));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(slice(300, 600)));
    const run = spawnSync(process.execPath, [CLI, dir, out, '--warmup', '300', '--min-trades', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const sym = JSON.parse(readFileSync(out, 'utf8')).symbols.TESTMES;
    const one = simulate(prepare(g), {
      mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing10', stopTicks: 0,
      spec: { tick: 0.25, pointValue: 5, fee: 1 }, fromT: 300 * 60,
    }).trades.filter((t) => t.reason !== 'open');
    assert.ok(one.length > 0, 'the fixture produces trades');
    assert.equal(sym.reference.all.trades, one.length);
    assert.equal(sym.reference.all.net, one.reduce((n, t) => n + t.net, 0));
    assert.notEqual(sym.best, null, 'some row has train trades and a profit factor');
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});

// ---- review round 2 ---------------------------------------------------------------

// Round 2, finding 1. The older window ends at t=300 and the newer one warms up until 480, so
// t=360 and 420 come only from the newer window's warm-up. coldTimes names them.
test('coldTimes lists counted bars that only a window\'s warm-up holds', async () => {
  const { coldTimes } = await import('./grid.mjs');
  const full = win(0, Array.from({ length: 12 }, () => [100, 101, 99, 100]));
  const gap = [{ s: full.slice(0, 6), fromT: 0, toT: 480 }, { s: full.slice(3), fromT: 480, toT: Infinity }];
  assert.deepEqual(coldTimes(gap), [360, 420]);
  const covered = [{ s: full.slice(0, 9), fromT: 0, toT: 480 }, { s: full.slice(3), fromT: 480, toT: Infinity }];
  assert.deepEqual(coldTimes(covered), []);
});

// Round 2, finding 1, CLI side. Window b starts 100 bars after window a ends, so with a 300-bar
// warm-up bars 500..799 sit only in b's warm-up. The CLI refuses instead of trading them.
test('the CLI refuses windows whose overlap is shorter than the warm-up', () => {
  const g = globalSeries(1000);
  const meta = { symbol: 'TESTMES', resolution: '1', minmov: 1, pricescale: 4, pointvalue: 5, currency: 'USD', replay: true };
  const slice = (from, n) => ({
    meta: { ...meta, firstT: g.bars[from][0], lastT: g.bars[from + n - 1][0] },
    bars: g.bars.slice(from, from + n), b: g.b.slice(from, from + n), sr: g.sr.slice(from, from + n),
  });
  const dir = mkdtempSync(join(tmpdir(), 'grid-cold-'));
  const out = join(dir, '..', `grid-cold-${process.pid}.json`);
  try {
    writeFileSync(join(dir, 'a.json'), JSON.stringify(slice(0, 400)));
    writeFileSync(join(dir, 'b.json'), JSON.stringify(slice(500, 500)));
    const run = spawnSync(process.execPath, [CLI, dir, out, '--warmup', '300', '--min-trades', '1'], { encoding: 'utf8' });
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stderr, /warm-up/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(out, { force: true });
  }
});

// Round 2, finding 2. A fractional or negative warm-up used to give fromT undefined and zero trades.
test('windowRanges and the CLI reject a warm-up that is not a whole number of bars', () => {
  const metas = [{ firstT: 0, times: [0, 60, 120, 180, 240, 300, 360, 420] }];
  assert.throws(() => windowRanges(metas, 5.5), /warm-up/);
  assert.throws(() => windowRanges(metas, -1), /warm-up/);
  assert.equal(windowRanges(metas, 0)[0].fromT, 0);
  const run = spawnSync(process.execPath, [CLI, tmpdir(), join(tmpdir(), 'x.json'), '--warmup', '5.5'], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.match(run.stderr, /--warmup/);
});

// Round 2, finding 3. The older window plots Res 110; the newer one has plotted 103 since t=120 and
// traded through it at t=240. At the seam (t=480) 103 is not newly plotted, so it must not come
// back as a free level.
test('a seam does not bring back a Cipher level the newer window already used up', async () => {
  const { stitch } = await import('./grid.mjs');
  const { levelsAfter } = await import('./sweep.mjs');
  const A = win(0, Array.from({ length: 8 }, (_, k) => [100, k === 4 ? 103.5 : 101, 99, 100, { res: 110 }]));
  const B = win(120, Array.from({ length: 12 }, (_, j) => [100, j === 2 ? 103.5 : 101, 99, 100, { res: 103 }]));
  const st = stitch([{ s: A, fromT: 0, toT: 480 }, { s: B, fromT: 480, toT: Infinity }]);
  const i = st.s.findIndex((r) => r.t === 480);
  assert.equal(st.s[i].res, 103, 'the seam bar comes from the newer window');
  assert.deepEqual(levelsAfter(st.s, i), [110]);
});

// Round 2, finding 4. Changing a window after a run must not reuse the old stitch.
test('stitch notices a window whose range changed after an earlier run', () => {
  const s = win(0, Array.from({ length: 20 }, (_, k) => [100, 101, 99, 100, k === 10 ? { ...LONG, res: 105 } : {}]));
  s.push(...win(20 * 60, [[100, 106, 99.5, 105]]));
  const ws = [{ s, fromT: 0, toT: Infinity }];
  assert.equal(runWindows(ws, { tp: 'live', sl: 'swing10' }).trades.length, 1);
  ws[0].fromT = 900;
  assert.equal(runWindows(ws, { tp: 'live', sl: 'swing10' }).trades.length, 0);
});

// Review round 3, finding 2. Both windows hold Res 105 as free, but the newer one plotted it a bar
// earlier than the older one. The stitched series must still list 105 after the seam (t=480).
test('a seam keeps a Cipher level the newer window plotted before the seam and still holds free', async () => {
  const { stitch } = await import('./grid.mjs');
  const { levelsAfter } = await import('./sweep.mjs');
  const A = win(0, Array.from({ length: 10 }, (_, k) => [100, 101, 99, 100, { res: k >= 8 ? 105 : 100 }]));
  const B = win(120, Array.from({ length: 16 }, (_, j) => {
    const res = j >= 5 ? 105 : 90;
    if (j === 8) return [100, 101, 99, 100, { res, ...LONG }];
    if (j === 10) return [100, 106, 99.5, 105.5, { res }];
    return [100, 101, 99, 100, { res }];
  }));
  const windows = [{ s: A, fromT: 0, toT: 480 }, { s: B, fromT: 480, toT: Infinity }];
  const st = stitch(windows);
  assert.ok(levelsAfter(st.s, st.s.findIndex((r) => r.t === 480)).includes(105));
  const r = runWindows(windows, { tp: 'free1', sl: 'swing10', stopTicks: 0, mfMode: 'with', mfLevel: 23 });
  assert.equal(r.trades[0]?.target, 105);
});

// Review round 3, finding 3. Number("") is 0, so an empty value used to pass as a warm-up of 0.
test('the CLI rejects an empty or blank --warmup and --train', () => {
  for (const [flag, v] of [['--warmup', ''], ['--warmup', '  '], ['--train', '']]) {
    const run = spawnSync(process.execPath, [CLI, tmpdir(), join(tmpdir(), 'x.json'), flag, v], { encoding: 'utf8' });
    assert.equal(run.status, 1, `${flag} ${JSON.stringify(v)}`);
    assert.match(run.stderr, new RegExp(flag));
  }
});
