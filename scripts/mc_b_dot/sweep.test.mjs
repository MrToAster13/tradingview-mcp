// Tests for the MC B dot exit sweep. Run: node --test scripts/mc_b_dot/sweep.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { prepare, signals, levelsAfter, simulate, summarize, sweep } from './sweep.mjs';

// One row per bar: [open, high, low, close, extra plot values]. Bars are one minute apart.
function mk(rows) {
  return rows.map(([o, h, l, c, extra = {}], i) => ({
    t: i * 60, o, h, l, c,
    mf: null, wave: null, up: null, dn: null, ph: null, pl: null, res: null, sup: null,
    ...extra,
  }));
}
const flat = (n, p = 100) => Array.from({ length: n }, () => [p, p + 1, p - 1, p]);
const LONG = { mf: 30, wave: -20, up: -20 };
const SHORT = { mf: -30, wave: 20, dn: 20 };

// ---- prepare -----------------------------------------------------------------

test('prepare joins MC B and MC SR rows to bars by time and nulls missing or non-finite values', () => {
  const B = (t, mf, wave, up, dn) => [t, 0, wave, 0, mf, 0, 0, up, dn];
  const S = (t, ph, pl, res, sup) => [t, ph, pl, 0, res, sup, 0];
  const s = prepare({
    bars: [[0, 1, 2, 0.5, 1.5, 10], [60, 2, 3, 1.5, 2.5, 10], [120, 3, 4, 2.5, 3.5, 10]],
    b: [B(60, 30, -20, -20, null), B(120, NaN, 5, null, 5)],
    sr: [S(0, 9, 1, 8, 2), S(120, 9, 1, 7, null)],
  });
  assert.equal(s.length, 3);
  assert.deepEqual(s[0], { t: 0, o: 1, h: 2, l: 0.5, c: 1.5, mf: null, wave: null, up: null, dn: null, ph: 9, pl: 1, res: 8, sup: 2 });
  assert.deepEqual(s[1], { t: 60, o: 2, h: 3, l: 1.5, c: 2.5, mf: 30, wave: -20, up: -20, dn: null, ph: null, pl: null, res: null, sup: null });
  assert.equal(s[2].mf, null);
  assert.equal(s[2].dn, 5);
  assert.equal(s[2].res, 7);
  assert.equal(s[2].sup, null);
});

// ---- signals -----------------------------------------------------------------

test('a green dot inside -45..0 with money flow beyond 25 either way is a long', () => {
  const s = mk([
    [100, 101, 99, 100, LONG],
    [100, 101, 99, 100, { ...LONG, mf: -30 }],
    [100, 101, 99, 100, { mf: 30, wave: -45, up: -45 }],
  ]);
  assert.deepEqual(signals(s), [{ i: 0, side: 1 }, { i: 1, side: 1 }, { i: 2, side: 1 }]);
});

test('no long when money flow is exactly 25, the dot is past -45, or the dot is above zero', () => {
  const s = mk([
    [100, 101, 99, 100, { ...LONG, mf: 25 }],
    [100, 101, 99, 100, { mf: 30, wave: -45.01, up: -45.01 }],
    [100, 101, 99, 100, { mf: 30, wave: 10, up: 10 }],
    [100, 101, 99, 100, { mf: 30, wave: -20, up: null }],
  ]);
  assert.deepEqual(signals(s), []);
});

test('a red dot inside 0..45 with money flow beyond 25 is a short', () => {
  const s = mk([
    [100, 101, 99, 100, SHORT],
    [100, 101, 99, 100, { mf: 30, wave: 45, dn: 45 }],
    [100, 101, 99, 100, { mf: 30, wave: 46, dn: 46 }],
    [100, 101, 99, 100, { mf: 30, wave: -5, dn: -5 }],
  ]);
  assert.deepEqual(signals(s), [{ i: 0, side: -1 }, { i: 1, side: -1 }]);
});

test('money flow mode "with" needs flow in the trade direction, "against" the opposite', () => {
  const s = mk([
    [100, 101, 99, 100, { ...LONG, mf: 30 }],
    [100, 101, 99, 100, { ...LONG, mf: -30 }],
    [100, 101, 99, 100, { ...SHORT, mf: -30 }],
    [100, 101, 99, 100, { ...SHORT, mf: 30 }],
  ]);
  assert.deepEqual(signals(s, { mfMode: 'with' }), [{ i: 0, side: 1 }, { i: 2, side: -1 }]);
  assert.deepEqual(signals(s, { mfMode: 'against' }), [{ i: 1, side: 1 }, { i: 3, side: -1 }]);
});

// ---- free levels -------------------------------------------------------------

test('a level is free from the bar it is plotted until a later bar trades through it', () => {
  const s = mk([
    [100, 101, 99, 100, { res: 110, sup: 90 }],
    [100, 111, 100, 105, { res: 110, sup: 90 }],
    [100, 101, 99, 100, { res: 110, sup: 90 }],
    [100, 101, 99, 100, { res: null, sup: 90 }],
    [100, 101, 99, 100, { res: 110, sup: 90 }],
  ]);
  assert.deepEqual(levelsAfter(s, 0), [90, 110]);
  assert.deepEqual(levelsAfter(s, 1), [90]);
  assert.deepEqual(levelsAfter(s, 2), [90], 'an unchanged plot is not re-added');
  assert.deepEqual(levelsAfter(s, 4), [90, 110], 'a level plotted again after a gap is re-added');
});

test('the bar that plots a level does not use it up, even if its range covers the level', () => {
  const s = mk([
    [100, 101, 99, 100, { res: 100 }],
    [100, 101, 99, 100, { res: 100 }],
    [100, 101, 99, 100, { res: 100.5 }],
  ]);
  assert.deepEqual(levelsAfter(s, 0), [100]);
  assert.deepEqual(levelsAfter(s, 1), []);
  assert.deepEqual(levelsAfter(s, 2), [100.5]);
});

// ---- targets and stops ---------------------------------------------------------

// Bars 0-3 plot resistance at 105, 110, 120, then 110 again; bar 3 is a long signal at 100.
const ladder = () => [
  [100, 101, 99, 100, { res: 105, sup: 95 }],
  [100, 101, 99, 100, { res: 110, sup: 90 }],
  [100, 101, 99, 100, { res: 120, sup: 85 }],
  [100, 101, 99, 100, { res: 110, sup: 90, ...LONG, ph: 112, pl: 97 }],
];

test('target freeN is the Nth distinct free level beyond the signal close', () => {
  const s = mk([...ladder(), [100, 101, 99.5, 100]]);
  const tgt = (tp) => simulate(s, { tp, sl: 'swing10' }).trades[0].target;
  assert.equal(tgt('free1'), 105);
  assert.equal(tgt('free2'), 110);
  assert.equal(tgt('free3'), 120);
});

test('target live is the plotted Cipher level on the signal bar, pivot is the pivot high', () => {
  const s = mk([...ladder(), [100, 101, 99.5, 100]]);
  assert.equal(simulate(s, { tp: 'live', sl: 'swing10' }).trades[0].target, 110);
  assert.equal(simulate(s, { tp: 'pivot', sl: 'swing10' }).trades[0].target, 112);
});

test('a target level on the wrong side of the close skips the signal as no_target', () => {
  const s = mk([[100, 101, 99, 100, { ...LONG, res: 99, ph: 100 }], [100, 101, 99, 100]]);
  for (const tp of ['free1', 'live', 'pivot']) {
    const r = simulate(s, { tp, sl: 'swing10' });
    assert.equal(r.trades.length, 0, tp);
    assert.equal(r.skipped.no_target, 1, tp);
  }
});

test('target rK sits K times the risk from the close, rounded to a tick toward the entry', () => {
  // Lows of 99, so the swing stop is 98.75 and the risk is 1.25.
  const s = mk([[100, 101, 99, 100, LONG], [100, 101, 99.5, 100]]);
  assert.equal(simulate(s, { tp: 'r2', sl: 'swing10' }).trades[0].target, 102.5);
  assert.equal(simulate(s, { tp: 'r1.5', sl: 'swing10' }).trades[0].target, 101.75);
  const sh = mk([[100, 101, 99, 100, SHORT], [100, 100.5, 99, 100]]);
  assert.equal(simulate(sh, { tp: 'r1.5', sl: 'swing10' }).trades[0].target, 98.25);
});

test('stop swingN is one tick past the extreme of the last N bars including the signal bar', () => {
  const rows = [[100, 101, 95, 100], ...flat(3), [100, 101, 99, 100, { ...LONG, res: 110 }], [100, 101, 99.5, 100]];
  const s = mk(rows);
  assert.equal(simulate(s, { tp: 'live', sl: 'swing10' }).trades[0].stop, 94.75);
  assert.equal(simulate(s, { tp: 'live', sl: 'swing2' }).trades[0].stop, 98.75);
  const sh = mk([[100, 104, 99, 100], [100, 101, 99, 100, { ...SHORT, sup: 90 }], [100, 100.5, 99, 100]]);
  assert.equal(simulate(sh, { tp: 'live', sl: 'swing10' }).trades[0].stop, 104.25);
});

test('stops freeN, live and pivot sit one tick beyond the level behind the entry', () => {
  const s = mk([...ladder(), [100, 101, 99.5, 100]]);
  const stop = (sl) => simulate(s, { tp: 'free1', sl }).trades[0].stop;
  assert.equal(stop('free1'), 94.75);
  assert.equal(stop('free2'), 89.75);
  assert.equal(stop('live'), 89.75);
  assert.equal(stop('pivot'), 96.75);
});

test('no stop level behind the entry skips the signal as no_stop', () => {
  const s = mk([[100, 101, 99, 100, { ...LONG, res: 110, sup: 101, pl: 100 }], [100, 101, 99.5, 100]]);
  for (const sl of ['free1', 'live', 'pivot']) {
    const r = simulate(s, { tp: 'live', sl });
    assert.equal(r.trades.length, 0, sl);
    assert.equal(r.skipped.no_stop, 1, sl);
  }
});

// ---- fills ---------------------------------------------------------------------

// Long signal at bar 0, close 100, stop 98.75 (swing), target 105 (live). Entry at bar 1's open.
const longSetup = (...after) => mk([[100, 101, 99, 100, { ...LONG, res: 105 }], ...after]);

test('entry fills at the next bar open and a target touch exits at the target', () => {
  const t = simulate(longSetup([100.5, 101, 100, 101], [101, 105, 100.5, 104]), { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(t.side, 1);
  assert.equal(t.entryI, 1);
  assert.equal(t.entry, 100.5);
  assert.equal(t.exitI, 2);
  assert.equal(t.exit, 105);
  assert.equal(t.reason, 'target');
  assert.equal(t.net, (105 - 100.5) * 5 - 1);
});

test('when one bar touches both, the side nearer the open fills first', () => {
  const lowFirst = simulate(longSetup([100, 106, 98, 100]), { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(lowFirst.reason, 'stop');
  assert.equal(lowFirst.exit, 98.75);
  assert.equal(lowFirst.net, -1.25 * 5 - 1);
  const highFirst = simulate(longSetup([100, 105.5, 90, 100]), { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(highFirst.reason, 'target');
  assert.equal(highFirst.exit, 105);
});

test('a bar that opens past the stop or the target exits at that open', () => {
  const gapDown = simulate(longSetup([100, 101, 99.5, 100], [97, 98, 96, 97]), { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(gapDown.reason, 'stop');
  assert.equal(gapDown.exit, 97);
  assert.equal(gapDown.net, -3 * 5 - 1);
  const gapUp = simulate(longSetup([100, 101, 99.5, 100], [106, 107, 105.5, 106]), { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(gapUp.reason, 'target');
  assert.equal(gapUp.exit, 106);
});

test('a short exits at its target below and its stop above', () => {
  const s = mk([[100, 101, 99, 100, { ...SHORT, sup: 96 }], [100, 100.5, 99.5, 100], [100, 100.25, 95.5, 96]]);
  const t = simulate(s, { tp: 'live', sl: 'swing10' }).trades[0];
  assert.equal(t.side, -1);
  assert.equal(t.stop, 101.25);
  assert.equal(t.exit, 96);
  assert.equal(t.net, 4 * 5 - 1);
});

test('one position at a time; a signal on the exit bar opens the next trade', () => {
  const s = longSetup(
    [100, 101, 99.5, 100, LONG],            // bar 1: entry; this signal is busy
    [100, 105, 99.5, 104, { ...LONG, res: 110 }], // bar 2: target hit; new signal at close 104
    [104, 104.5, 103.5, 104],
  );
  const r = simulate(s, { tp: 'live', sl: 'swing10' });
  assert.equal(r.skipped.busy, 1);
  assert.equal(r.trades.length, 2);
  assert.equal(r.trades[1].entryI, 3);
  assert.equal(r.trades[1].reason, 'open');
});

test('a signal on the last bar has no fill and an unfinished trade is marked open at the last close', () => {
  const s = longSetup([100, 101, 99.5, 102]);
  const r = simulate(s, { tp: 'live', sl: 'swing10' });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].reason, 'open');
  assert.equal(r.trades[0].exit, 102);
  const last = simulate(mk([[100, 101, 99, 100, { ...LONG, res: 105 }]]), { tp: 'live', sl: 'swing10' });
  assert.equal(last.trades.length, 0);
});

// ---- summary and sweep -----------------------------------------------------------

const tr = (net, entryT = 0, reason = net > 0 ? 'target' : 'stop') => ({ net, entryT, reason });

test('summarize reports closed-trade stats and peak-to-trough drawdown', () => {
  const s = summarize([tr(24), tr(-7.25), tr(-16), tr(10), tr(50, 0, 'open')]);
  assert.equal(s.trades, 4);
  assert.equal(s.wins, 2);
  assert.equal(s.winRate, 0.5);
  assert.equal(s.net, 10.75);
  assert.equal(s.grossProfit, 34);
  assert.equal(s.grossLoss, 23.25);
  assert.equal(s.pf, 34 / 23.25);
  assert.equal(s.avgWin, 17);
  assert.equal(s.avgLoss, -11.625);
  assert.equal(s.maxDD, 23.25);
  assert.equal(s.open, 1);
  assert.equal(summarize([tr(-5), tr(10)]).maxDD, 5);
});

test('summarize with no trades or no losses has no win rate or profit factor', () => {
  assert.equal(summarize([]).winRate, null);
  assert.equal(summarize([]).net, 0);
  assert.equal(summarize([tr(5)]).pf, null);
});

test('sweep returns one row per combination with train and test split by entry time', () => {
  const s = longSetup([100, 101, 99.5, 100], [101, 105, 100.5, 104]);
  const rows = sweep(s, { mfModes: ['either', 'with'], tps: ['live', 'r2'], sls: ['swing10'], splitT: 60 });
  assert.equal(rows.length, 4);
  const r = rows.find((x) => x.mfMode === 'either' && x.tp === 'live');
  assert.equal(r.all.trades, 1);
  assert.equal(r.train.trades, 0);
  assert.equal(r.test.trades, 1);
  assert.deepEqual(Object.keys(r.skipped).sort(), ['busy', 'no_stop', 'no_target']);
});

// ---- reward:risk gates ---------------------------------------------------------

// Long signal at close 100 with the swing stop at 98.75 (risk 1.25) and free levels at 101, 102, 104.
const rrSetup = () => mk([
  [100, 100.5, 99.5, 100, { res: 101 }],
  [100, 100.5, 99.5, 100, { res: 102 }],
  [100, 100.5, 99, 100, { ...LONG, res: 104 }],
  [100, 100.5, 99.5, 100],
]);

test('minRR skips a signal whose target is nearer than minRR times the risk, as Pine rrOk does', () => {
  const s = rrSetup();
  assert.equal(simulate(s, { tp: 'free1', sl: 'swing10', minRR: 0.8 }).trades[0].target, 101);
  const r = simulate(s, { tp: 'free1', sl: 'swing10', minRR: 1 });
  assert.equal(r.trades.length, 0);
  assert.equal(r.skipped.no_target, 1);
  assert.equal(simulate(s, { tp: 'free2', sl: 'swing10', minRR: 1.6 }).trades[0].target, 102);
});

test('target freeR<K> is the first free level at least K times the risk beyond the close', () => {
  const s = rrSetup();
  assert.equal(simulate(s, { tp: 'freeR1', sl: 'swing10' }).trades[0].target, 102);
  assert.equal(simulate(s, { tp: 'freeR1.6', sl: 'swing10' }).trades[0].target, 102);
  assert.equal(simulate(s, { tp: 'freeR2', sl: 'swing10' }).trades[0].target, 104);
  const none = simulate(s, { tp: 'freeR4', sl: 'swing10' });
  assert.equal(none.trades.length, 0);
  assert.equal(none.skipped.no_target, 1);
});

// ---- adversarial review regressions --------------------------------------------

test('an unknown money-flow mode, target or stop mode throws instead of running', () => {
  const s = rrSetup();
  assert.throws(() => simulate(s, { mfMode: 'With', tp: 'r2', sl: 'swing10' }), /money-flow mode/);
  assert.throws(() => simulate(s, { tp: 'free0', sl: 'swing10' }), /free0/);
  assert.throws(() => simulate(s, { tp: 'r2', sl: 'swing0' }), /swing0/);
});

// The Pine script copies these three rules, so the simulator pins them.
test('minRR compares whole ticks, so a target at exactly minRR times the risk passes', () => {
  // Close 7000, 10-bar low 6987.75, stop 6987.5: risk 50 ticks. Level 7013.75 is 55 ticks, 1.1R.
  const s = mk([
    [7000, 7000.5, 6987.75, 7000, { res: 7013.75 }],
    [7000, 7000.5, 6999, 7000, LONG],
    [7000, 7000.5, 6999.5, 7000],
  ]);
  const r = simulate(s, { tp: 'free1', sl: 'swing10', minRR: 1.1 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].target, 7013.75);
});

test('an R target that rounds to the close itself is skipped as no target', () => {
  // The signal close is the 10-bar low, so the stop is one tick away and 0.5R rounds to 0 ticks.
  const s = mk([
    [100.5, 101, 100.25, 100.5],
    [100.5, 101, 100, 100, LONG],
    [100.25, 100.5, 100, 100.25],
  ]);
  const r = simulate(s, { tp: 'r0.5', sl: 'swing10' });
  assert.equal(r.trades.length, 0);
  assert.equal(r.skipped.no_target, 1);
});

test('a swing stop on a bar with fewer than N bars of history uses the bars there are', () => {
  const s = mk([
    [100, 101, 99, 100],
    [100, 100.5, 99.5, 100, LONG],
    [100, 100.5, 99.5, 100],
  ]);
  assert.equal(simulate(s, { tp: 'r2', sl: 'swing20' }).trades[0].stop, 98.75);
});

// ---- instruments, stop offset and data windows -----------------------------------

// M2K-like contract: 0.1 tick, $5 a point. Prices like 2795.3 - 0.1 do not come out exact in floats.
const M2K = { tick: 0.1, pointValue: 5, fee: 1 };

test('the instrument spec sets the tick, so a 0.1-tick stop lands on an exact price and fills on a touch', () => {
  const s = mk([
    [2795.5, 2795.8, 2795.3, 2795.6, { ...LONG, res: 2797.4 }],
    [2795.6, 2795.7, 2795.4, 2795.5],
    [2795.5, 2795.5, 2795.2, 2795.3],
  ]);
  const t = simulate(s, { tp: 'live', sl: 'swing10', spec: M2K }).trades[0];
  assert.equal(t.stop, 2795.2);
  assert.equal(t.reason, 'stop');
  assert.equal(t.exit, 2795.2);
  assert.equal(t.net, -4 * 0.1 * 5 - 1);
});

test('the instrument spec sets the point value and fee in the net', () => {
  const s = longSetup([100.5, 101, 100, 101], [101, 105, 100.5, 104]);
  const t = simulate(s, { tp: 'live', sl: 'swing10', spec: { tick: 0.25, pointValue: 2, fee: 1.5 } }).trades[0];
  assert.equal(t.net, (105 - 100.5) * 2 - 1.5);
});

test('an R target on a 0.1-tick contract is an exact multiple of the tick', () => {
  const s = mk([[2795.5, 2795.8, 2795.3, 2795.6, LONG], [2795.6, 2795.7, 2795.5, 2795.6]]);
  // Stop 2795.2, risk 4 ticks, 1.5R is 6 ticks above 2795.6.
  assert.equal(simulate(s, { tp: 'r1.5', sl: 'swing10', spec: M2K }).trades[0].target, 2796.2);
});

test('stopTicks 0 puts the stop on the swing extreme or the level itself', () => {
  const s = mk([...ladder(), [100, 101, 99.5, 100]]);
  assert.equal(simulate(s, { tp: 'free1', sl: 'swing10', stopTicks: 0 }).trades[0].stop, 99);
  assert.equal(simulate(s, { tp: 'free1', sl: 'free1', stopTicks: 0 }).trades[0].stop, 95);
  const sh = mk([[100, 104, 99, 100], [100, 101, 99, 100, { ...SHORT, sup: 90 }], [100, 100.5, 99, 100]]);
  assert.equal(simulate(sh, { tp: 'live', sl: 'swing10', stopTicks: 0 }).trades[0].stop, 104);
});

test('fromT and toT keep only signals inside the window, and a trade may exit after toT', () => {
  // Long signals on bars 0 and 3; the second one's target is hit on bar 5.
  const s = mk([
    [100, 101, 99, 100, { ...LONG, res: 105 }],
    [100, 100.5, 99.5, 100],
    [100, 100.5, 99.5, 100],
    [100, 101, 99, 100, { ...LONG, res: 105 }],
    [100, 100.5, 99.5, 100],
    [100, 105, 99.5, 104],
  ]);
  const r = simulate(s, { tp: 'live', sl: 'swing10', fromT: 60, toT: 240 });
  assert.equal(r.trades.length, 1);
  assert.equal(r.trades[0].signalI, 3);
  assert.equal(r.trades[0].exitI, 5);
  assert.equal(r.trades[0].reason, 'target');
});
