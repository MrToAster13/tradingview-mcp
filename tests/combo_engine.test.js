/**
 * Tests for scripts/combo/engine.js, the pure part of the combo tester.
 * Nothing here touches TradingView.
 *
 * Run: node --test tests/combo_engine.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseConfig, resolveSignals, extractBars, readProblem, evalSignal, combos,
  simulate, stats, tCrit, evaluate, renderMarkdown,
} from '../scripts/combo/engine.js';

const base = { symbol: 'CME_MINI:MES1!', resolution: '5' };
const sig = (o) => ({ side: 'bull', study: 'S', plot: 'P', op: 'fires', ...o });

// Store bar from a compact spec. seg defaults to 0, live to false.
const bar = (t, o, v = {}, extra = {}) => ({ t, o, h: o, l: o, c: o, seg: 0, live: false, v, ...extra });

describe('parseConfig', () => {
  it('fills defaults for horizon, costPoints and maxSize', () => {
    const c = parseConfig({ ...base, signals: [sig({ name: 'a' })] });
    assert.equal(c.horizon, 12);
    assert.equal(c.costPoints, 0);
    assert.equal(c.maxSize, 2);
  });

  it('rejects a bad op, a missing right side, maxSize 4, duplicate names and an unknown side', () => {
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a', op: '>=' })] }), /op/);
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a', op: '>' })] }), /value or ref/);
    assert.throws(() => parseConfig({ ...base, maxSize: 4, signals: [sig({ name: 'a' })] }), /maxSize/);
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a' }), sig({ name: 'a' })] }), /duplicate/);
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a', side: 'up' })] }), /side/);
    assert.throws(() => parseConfig({ ...base, signals: [] }), /signals/);
    assert.throws(() => parseConfig({ resolution: '5', signals: [sig({ name: 'a' })] }), /symbol/);
  });

  it('rejects a ref that is present but not a name or a study and plot pair', () => {
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a', op: '>', value: 0, ref: null })] }), /ref/);
    assert.throws(() => parseConfig({ ...base, signals: [sig({ name: 'a', op: '>', ref: { study: 'X' } })] }), /ref/);
  });
});

const studies = [
  { name: 'MarketCipher_B', short: 'MC B', title: 'MarketCipher_B', inputs: '{"in_0":1}', plots: ['Blue Wave', null, 'Buy'], lastT: 300, rows: [[100, 5, 1, 0], [200, -3, 1, 1], [300, 2, 1, 0]] },
  { name: 'Moving Average Exponential', short: 'EMA', title: 'EMA 9', inputs: '{"in_0":9}', plots: ['EMA'], lastT: 300, rows: [[100, 10], [200, 11], [300, 12]] },
  { name: 'Moving Average Exponential', short: 'EMA', title: 'EMA 21', inputs: '{"in_0":21}', plots: ['EMA'], lastT: 300, rows: [[100, 9], [300, 13]] },
];

describe('resolveSignals', () => {
  it('maps a plot title to its row column, counting colorer columns', () => {
    const r = resolveSignals([sig({ name: 'buy', study: 'MarketCipher_B', plot: 'Buy' })], studies);
    const op = r.operands.find((o) => o.key === r.signals[0].a);
    assert.equal(op.col, 3);
  });

  it('matches a study by short name or legend title, and a ref in another study', () => {
    const r = resolveSignals([sig({ name: 'x', study: 'EMA 9', plot: 'EMA', op: '>', ref: { study: 'EMA 21', plot: 'EMA' } })], studies);
    assert.equal(r.operands.length, 2);
    assert.notEqual(r.signals[0].a, r.signals[0].b);
    const r2 = resolveSignals([sig({ name: 'y', study: 'MC B', plot: 'Blue Wave', op: '<', ref: 'close' })], studies);
    assert.equal(r2.signals[0].b, 'close');
  });

  it('refuses a study name that matches two studies, and a missing study or plot', () => {
    assert.throws(() => resolveSignals([sig({ name: 'x', study: 'EMA', plot: 'EMA' })], studies), /matches 2 studies/);
    assert.throws(() => resolveSignals([sig({ name: 'x', study: 'RSI', plot: 'RSI' })], studies), /no study/);
    assert.throws(() => resolveSignals([sig({ name: 'x', study: 'EMA 9', plot: 'Signal' })], studies), /no plot/);
  });
});

describe('extractBars and readProblem', () => {
  const raw = {
    symbol: 'CME_MINI:MES1!', resolution: '5', replay: false,
    bars: [[100, 1, 2, 0, 1.5, 9], [200, 2, 3, 1, 2.5, 9], [300, 3, 4, 2, 3.5, 9]],
    studies,
  };
  const resolved = resolveSignals([
    sig({ name: 'buy', study: 'MarketCipher_B', plot: 'Buy' }),
    sig({ name: 'x', study: 'EMA 9', plot: 'EMA', op: '>', ref: { study: 'EMA 21', plot: 'EMA' } }),
  ], studies);

  it('drops the forming last bar and joins study values by time, null where a row is missing', () => {
    const { bars, inputs } = extractBars(raw, resolved);
    assert.deepEqual(bars.map((b) => b.t), [100, 200]);
    assert.equal(bars[1].c, 2.5);
    assert.equal(bars[1].v[resolved.signals[0].a], 1);
    assert.equal(bars[1].v[resolved.signals[1].b], null);
    assert.equal(inputs['EMA 21'], '{"in_0":21}');
  });

  it('reports a study that has not caught up with the main series', () => {
    assert.equal(readProblem(raw, resolved), null);
    const lagging = { ...raw, studies: studies.map((s) => (s.title === 'EMA 9' ? { ...s, lastT: 200 } : s)) };
    assert.match(readProblem(lagging, resolved), /EMA 9.*not loaded/);
  });
});

describe('evalSignal', () => {
  const bars = [bar(1, 10, { a: 29 }), bar(2, 10, { a: 31 }), bar(3, 10, { a: null }), bar(4, 10, { a: 35 }, { seg: 1 }), bar(5, 10, { a: 0 }, { seg: 1 })];

  it('treats a missing value as false for comparisons', () => {
    assert.equal(evalSignal({ op: '<', a: 'a', b: 30 }, bars, 2), false);
    assert.equal(evalSignal({ op: '<', a: 'a', b: 30 }, bars, 0), true);
  });

  it('detects a cross above a value and refuses a cross over a gap or segment change', () => {
    assert.equal(evalSignal({ op: 'crosses_above', a: 'a', b: 30 }, bars, 1), true);
    assert.equal(evalSignal({ op: 'crosses_above', a: 'a', b: 30 }, bars, 0), false);
    assert.equal(evalSignal({ op: 'crosses_above', a: 'a', b: 30 }, bars, 3), false);
  });

  it('compares against the close price', () => {
    assert.equal(evalSignal({ op: '>', a: 'a', b: 'close' }, bars, 1), true);
  });

  it('fires only on a nonzero value', () => {
    assert.equal(evalSignal({ op: 'fires', a: 'a', b: null }, bars, 3), true);
    assert.equal(evalSignal({ op: 'fires', a: 'a', b: null }, bars, 4), false);
    assert.equal(evalSignal({ op: 'fires', a: 'a', b: null }, bars, 2), false);
  });
});

describe('combos', () => {
  it('pairs bull only with bull and bear only with bear, up to maxSize', () => {
    const s = ['b1', 'b2', 'b3'].map((n) => ({ name: n, side: 'bull' })).concat(['s1', 's2'].map((n) => ({ name: n, side: 'bear' })));
    const c = combos(s, 2);
    assert.equal(c.length, 9);
    assert.ok(c.every((x) => x.signals.every((y) => y.side === x.side)));
    assert.equal(combos(s, 1).length, 5);
  });
});

describe('simulate', () => {
  // opens 100..109; the signal fires on bars 0, 1 and 6
  const fire = new Set([0, 1, 6]);
  const bars = Array.from({ length: 10 }, (_, i) => bar(i, 100 + i, { f: fire.has(i) ? 1 : 0 }));
  const combo = { side: 'bull', signals: [{ op: 'fires', a: 'f', b: null }] };

  it('enters at the next open, exits at the open horizon bars later, and skips signals while in a trade', () => {
    const tr = simulate(combo, bars, { horizon: 2, costPoints: 0.5, from: 0, to: 10 });
    assert.deepEqual(tr.map((x) => [x.i, x.r]), [[0, 1.5], [6, 1.5]]);
  });

  it('drops a trade whose exit is past the range end or across a segment', () => {
    assert.deepEqual(simulate(combo, bars, { horizon: 2, costPoints: 0, from: 0, to: 8 }).map((x) => x.i), [0]);
    const split = bars.map((b, i) => (i >= 8 ? { ...b, seg: 1 } : b));
    assert.deepEqual(simulate(combo, split, { horizon: 2, costPoints: 0, from: 0, to: 10 }).map((x) => x.i), [0]);
  });

  it('books a short as entry minus exit', () => {
    const tr = simulate({ ...combo, side: 'bear' }, bars, { horizon: 2, costPoints: 0, from: 0, to: 10 });
    assert.equal(tr[0].r, -2);
  });
});

describe('stats and tCrit', () => {
  it('computes average, win rate, profit factor and t-stat', () => {
    const s = stats([{ r: 1 }, { r: 2 }, { r: 3 }, { r: -2 }]);
    assert.equal(s.n, 4);
    assert.equal(s.winRate, 0.75);
    assert.equal(s.avg, 1);
    assert.equal(s.pf, 3);
    assert.ok(Math.abs(s.t - 0.9258) < 1e-3);
  });

  it('gives an infinite profit factor with no losses and no t-stat for n < 2 or equal results', () => {
    assert.equal(stats([{ r: 1 }, { r: 3 }]).pf, Infinity);
    assert.equal(stats([{ r: 1 }]).t, null);
    assert.equal(stats([{ r: 1 }, { r: 1 }]).t, null);
    assert.equal(stats([]).n, 0);
  });

  it('raises the t bar with the number of combinations tested', () => {
    assert.ok(Math.abs(tCrit(2) - 1.95996) < 1e-3);
    assert.ok(Math.abs(tCrit(50) - 3.09023) < 1e-3);
  });

  it('uses the t distribution bar for a given number of trades', () => {
    assert.ok(Math.abs(tCrit(2, 29) - 2.0452) < 2e-3);
    assert.ok(Math.abs(tCrit(50, 29) - 3.3963) < 2e-2);
  });
});

// 500 bars. A fires on every bar index 0 mod 5 and wins 1 or 2 points two bars later. B fires on
// every bar, so A+B trades exactly like A. C fires on index 2 mod 5 and loses.
function syntheticStore(n = 500, live = false) {
  const o = Array(n).fill(100);
  for (let i = 0; i + 3 < n; i += 5) o[i + 3] = 101 + ((i / 5) % 2);
  const bars = o.map((p, i) => bar(1000 + i * 300, p, { A: i % 5 === 0 ? 1 : 0, B: 1, C: i % 5 === 2 ? 1 : 0 }, { live }));
  return { version: 1, symbol: base.symbol, resolution: base.resolution, keys: ['A', 'B', 'C'], inputs: {}, bars };
}
const cfg = {
  ...base, horizon: 2, costPoints: 0, maxSize: 2,
  signals: ['A', 'B', 'C'].map((k) => ({ name: k, side: 'bull', op: 'fires', a: k, b: null })),
};

describe('evaluate', () => {
  it('ranks the winning signal, drops the pair that adds nothing, and rejects the loser', () => {
    const { board } = evaluate(cfg, syntheticStore(), {});
    assert.equal(board.combosTested, 6);
    assert.deepEqual(board.survivors.map((s) => s.id), ['bull: A']);
    assert.ok(board.survivors[0].test.n >= 30);
  });

  it('needs at least 30 test trades', () => {
    const { board } = evaluate(cfg, syntheticStore(150), {});
    assert.deepEqual(board.survivors, []);
  });

  it('lists the closest combinations that do not pass yet', () => {
    const { board } = evaluate(cfg, syntheticStore(150), {});
    assert.equal(board.closest[0].id, 'bull: A');
    assert.ok(board.closest.length <= 5);
    assert.match(renderMarkdown(board), /Closest, not passing yet/);
  });

  it('keeps the first-survived time and counts forward trades on live bars added after it', () => {
    const first = evaluate(cfg, syntheticStore(), {});
    const t0 = first.state.firstSurvived['bull: A'];
    assert.equal(t0, 1000 + 499 * 300);
    assert.equal(first.board.survivors[0].forward.n, 0);
    const grown = syntheticStore(515);
    grown.bars = grown.bars.map((b, i) => (i >= 500 ? { ...b, live: true } : b));
    const second = evaluate(cfg, grown, first.state);
    assert.equal(second.state.firstSurvived['bull: A'], t0);
    assert.equal(second.board.survivors[0].forward.n, 3);
  });

  it('renders a markdown leaderboard that names the survivor and writes inf for profit factor', () => {
    const { board } = evaluate(cfg, syntheticStore(), {});
    const md = renderMarkdown(board);
    assert.match(md, /bull: A/);
    assert.match(md, /Combinations tested: 6/);
    assert.match(md, /inf/);
  });
});
