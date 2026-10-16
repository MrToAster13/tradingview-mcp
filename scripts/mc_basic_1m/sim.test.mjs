/**
 * Tests for the mc_basic_1m simulator (design v14). Pure: synthetic snapshots only,
 * no CDP, no TradingView. The only file writes go under the OS temp folder.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  FORMAT, RUN_IDS, prepare, simulate, simulateRun, summarize, filter15, lastClosed15Index, sha256Rows,
  rHundredths, averageRHundredths, roundHundredths, wilson, segmentOf, fmtRate, fmtDollarsNq, fmtR,
  isScheduledClose, etLabel, mfTrend,
} from './sim.mjs';
import { readSnapshot } from './store.mjs';
import { renderReport } from './report.mjs';

// ── Synthetic snapshot builder ───────────────────────────────────────────

const BASE = Date.UTC(2026, 9, 14, 14, 0, 0) / 1000; // Wed 2026-10-14 10:00 ET (EDT)
const F0 = 300;                                       // first eligible row with the default layout
const T0 = BASE - F0 * 60;                            // row 0 opens 05:00 ET
const Q = (p) => p * 4;
const at = (hh, mm) => BASE + ((hh - 10) * 60 + mm) * 60; // ET clock time on the base day

/**
 * Build a mutable model. 1m rows are flat at 5000 with every signal idle. The 15m
 * series has `hist15` rows before the first 1m bucket, then one row per bucket that
 * holds a 1m row (all buckets with `all15`), up to the last bucket closed by the
 * last 1m close. 15m Mny Flow, Blue Wave and RSI rise row by row.
 */
function build({ n = 360, start = T0, hist15 = 100, gaps = {}, all15 = false } = {}) {
  const t = [];
  let x = start;
  for (let i = 0; i < n; i++) {
    if (i > 0) x += 60 + (gaps[i] ?? 0);
    t.push(x);
  }
  const fill = (v) => new Array(n).fill(v);
  const m1 = {
    t, o: fill(5000), h: fill(5000), l: fill(5000), c: fill(5000),
    bw: fill(0), mf: fill(0), buy: fill(0), cross: fill(null), sto: fill(0), res: fill(null), sup: fill(null),
  };
  const tL = t[n - 1];
  const first = start - (start % 900);
  const t15 = [];
  for (let i = hist15; i > 0; i--) t15.push(first - i * 900);
  if (all15) {
    for (let b = first; b + 900 <= tL + 60; b += 900) t15.push(b);
  } else {
    for (const b of new Set(t.map((v) => v - (v % 900)))) if (b + 900 <= tL + 60) t15.push(b);
  }
  const m15 = { t: t15, bw: t15.map((_, j) => j), mf: t15.map((_, j) => j), rsi: t15.map((_, j) => j) };
  return { m1, m15, drop15: new Set(), snapshotTime: tL + 60 };
}

const layout = () => Array.from({ length: 16 }, (_, i) => ({ id: `plot_${i}`, type: 'line' }));

function toSnapshot(m) {
  const { m1, m15 } = m;
  const bars = m1.t.map((t, i) => [t, m1.o[i], m1.h[i], m1.l[i], m1.c[i], 100]);
  const b = m1.t.map((t, i) => {
    const r = [t, ...new Array(16).fill(0)];
    r[2] = m1.bw[i]; r[4] = m1.mf[i]; r[6] = m1.buy[i]; r[8] = m1.cross[i]; r[16] = m1.sto[i];
    return r;
  });
  const sr = m1.t.map((t, i) => [t, 0, 0, 0, m1.res[i], m1.sup[i]]);
  const keep = m15.t.map((_, j) => j).filter((j) => !m.drop15.has(m15.t[j]));
  const bars15 = keep.map((j) => [m15.t[j], 5000, 5000, 5000, 5000, 1000]);
  const b15 = keep.map((j) => {
    const r = [m15.t[j], ...new Array(16).fill(0)];
    r[2] = m15.bw[j]; r[4] = m15.mf[j]; r[15] = m15.rsi[j];
    return r;
  });
  const rows = { m1: { bars, b, sr }, m15: { bars: bars15, b: b15 } };
  return {
    format: FORMAT,
    snapshot_time: m.snapshotTime,
    symbol: 'CME_MINI:MES1!',
    first_1m: bars[0][0], last_1m: bars[bars.length - 1][0], count_1m: bars.length,
    first_15m: bars15[0][0], last_15m: bars15[bars15.length - 1][0], count_15m: bars15.length,
    plots_b_1m: layout(),
    plots_b_15m: layout(),
    inputs_b_1m: ['enc-1'],
    inputs_b_15m: ['enc-1'],
    ...(m.srPeriodS === undefined ? {} : { sr_period_s: m.srPeriodS }),
    sha256: sha256Rows(rows),
    rows,
  };
}

const reseal = (snap) => { snap.sha256 = sha256Rows(snap.rows); return snap; };

function setBar(m, i, o, h, l, c) {
  m.m1.o[i] = o; m.m1.h[i] = h; m.m1.l[i] = l; m.m1.c[i] = c;
}
function longTrigger(m, d) { m.m1.buy[d] = 1; m.m1.bw[d] = -65; }
function shortTrigger(m, d) { m.m1.cross[d] = 65; m.m1.bw[d] = 65; }
/** Long target candidate at row j with value p: Resistance steps to p and p equals high[j-3]. */
function resCandidate(m, j, p) {
  const i = j - 3;
  m.m1.h[i] = Math.max(m.m1.h[i], p);
  if (m.m1.h[i] !== p) setBar(m, i, p, p, p, p);
  m.m1.res[j - 1] = p - 10; m.m1.res[j] = p;
}
/** Short target candidate at row j with value p: Support steps to p and p equals low[j-3]. */
function supCandidate(m, j, p) {
  const i = j - 3;
  m.m1.l[i] = Math.min(m.m1.l[i], p);
  if (m.m1.l[i] !== p) setBar(m, i, p, p, p, p);
  m.m1.sup[j - 1] = p + 10; m.m1.sup[j] = p;
}
function fall15(m) {
  for (const key of ['bw', 'mf', 'rsi']) m.m15[key] = m.m15[key].map((v) => -v);
}
const idx15 = (m, S) => m.m15.t.indexOf(S);
function set15(m, S, vals) {
  const j = idx15(m, S);
  assert.ok(j >= 0, `no 15m row at ${S}`);
  for (const [key, v] of Object.entries(vals)) m.m15[key][j] = v;
}
/** Index of the last closed 15m row at 1m row k, computed independently of sim.mjs. */
function q15(m, k) {
  const tk = m.m1.t[k];
  let best = -1;
  m.m15.t.forEach((S, j) => { if (!m.drop15.has(S) && S + 900 <= tk + 60) best = j; });
  return best;
}

function run(m, runId = 'HTF-a') {
  const res = simulate(toSnapshot(m));
  for (const r of res.runs) {
    for (const s of [r.whole, r.first, r.second]) {
      assert.ok(s.funnel.reconciles, `${r.runId} funnel does not reconcile`);
    }
    assert.equal(r.whole.funnel.triggers, r.first.funnel.triggers + r.second.funnel.triggers);
  }
  return { res, r: res.runs.find((x) => x.runId === runId) };
}
const aborts = (m, re) => assert.throws(() => simulate(typeof m.format === 'string' ? m : toSnapshot(m)),
  (e) => e.code === 'E_SNAPSHOT_ABORT' && re.test(e.message));

/**
 * Canonical long: trigger d = F+20 (bar 5000/5000/4996/5000), entry bar d+1 opens 5001.
 * T 5010, R = close(d) 5000, E 5001.25, setup low 4996 → raw stop 4995.75, D 5.5, S 4995.75.
 * k is the decision row, which is d itself under the trigger-row entry rule.
 */
function canonicalLong(opts) {
  const m = build(opts);
  const d = F0 + 20;
  longTrigger(m, d);
  resCandidate(m, F0 + 10, 5010);
  setBar(m, d, 5000, 5000, 4996, 5000);
  setBar(m, d + 1, 5001, 5001, 5001, 5001);
  return { m, d, k: d };
}

/**
 * Canonical short: trigger d = F+20 (bar 5000/5004/5000/5000), entry bar d+1 opens 5000.
 * T 4990, E 4999.75, setup high 5004 → raw stop 5004.25, D 4.5, S 5004.25.
 */
function canonicalShort() {
  const m = build();
  fall15(m);
  const d = F0 + 20;
  shortTrigger(m, d);
  supCandidate(m, F0 + 10, 4990);
  setBar(m, d, 5000, 5004, 5000, 5000);
  return { m, d, k: d };
}

/** Long with E = open + 0.25 (5000.25 by default) and a chosen trigger-bar low (sets D) and target. */
function longWith({ setupLow = 5000, target = 5010, open = 5000 } = {}) {
  const m = build();
  const d = F0 + 20;
  longTrigger(m, d);
  resCandidate(m, F0 + 10, target);
  setBar(m, d, 5000, 5000, setupLow, 5000);
  setBar(m, d + 1, open, open, open, open);
  return { m, d, k: d };
}

// ── Triggers ─────────────────────────────────────────────────────────────

describe('triggers', () => {
  it('a Buy decides on its own row and fills at the next open, with no 1m rising check', () => {
    const { m, d } = canonicalLong();
    // 1m Blue Wave (-65 from 0), Mny Flow and Sto RSI all fall on the trigger row.
    m.m1.mf[d] = -1; m.m1.sto[d] = -1;
    const { r } = run(m);
    assert.equal(r.triggers.length, 1);
    assert.equal(r.triggers[0].outcome, 'trade');
    assert.deepEqual(r.triggers[0].attempts.map((a) => [a.row, a.pass]), [[d, true]]);
    const t = r.trades[0];
    assert.equal(t.side, 'long');
    assert.equal(t.triggerRow, d);
    assert.equal(t.confirmRow, d);
    assert.equal(t.entryRow, d + 1);
    assert.equal(t.triggerTime, m.m1.t[d]);
    assert.equal(t.entryTime, m.m1.t[d + 1]);
    assert.equal(t.rawEntryQ, Q(5001));
    assert.equal(t.eQ, Q(5001.25));
    assert.equal(t.rQ, Q(5000));
    assert.equal(t.tQ, Q(5010));
    assert.equal(t.setupQ, Q(4996));
    assert.equal(t.rawStopQ, Q(4995.75));
    assert.equal(t.rawDistQ, Q(5.5));
    assert.equal(t.dQ, Q(5.5));
    assert.equal(t.sQ, Q(4995.75));
    assert.equal(t.floor, false);
    assert.equal(t.cap, false);
    assert.equal(t.gap, false);
    assert.equal(t.open, true);
  });

  it('a short trigger fills at the next open less a tick, setup from the trigger bar high', () => {
    const { m, d } = canonicalShort();
    const { r } = run(m);
    assert.equal(r.trades.length, 1);
    const t = r.trades[0];
    assert.equal(t.side, 'short');
    assert.equal(t.confirmRow, d);
    assert.equal(t.entryRow, d + 1);
    assert.equal(t.rawEntryQ, Q(5000));
    assert.equal(t.eQ, Q(4999.75));
    assert.equal(t.setupQ, Q(5004));
    assert.equal(t.rawStopQ, Q(5004.25));
    assert.equal(t.dQ, Q(4.5));
    assert.equal(t.sQ, Q(5004.25));
    assert.equal(t.tQ, Q(4990));
  });

  it('Blue Wave exactly 60 is a short trigger and trades; 59.75, null and an idle plot 8 are not', () => {
    const count = (bw, cross) => {
      const { m, d } = canonicalShort();
      m.m1.bw[d] = bw;
      m.m1.cross[d] = cross;
      const { res } = run(m);
      return res.runs.map((x) => [x.triggers.length, x.trades.length]);
    };
    const all = (n) => RUN_IDS.map(() => [n, n]);
    assert.deepEqual(count(60, 65), all(1));
    assert.deepEqual(count(59.75, 65), all(0));
    assert.deepEqual(count(-65, 65), all(0));
    assert.deepEqual(count(null, 65), all(0));
    assert.deepEqual(count(70, 0), all(0));
    assert.deepEqual(count(70, null), all(0));
  });

  it('Buy fires on any finite non-zero value, not on 0 or null', () => {
    for (const [v, want] of [[1, 1], [-3, 1], [0, 0], [null, 0]]) {
      const { m, d } = canonicalLong();
      m.m1.buy[d] = v;
      assert.equal(run(m).r.triggers.length, want, `buy ${v}`);
    }
  });

  it('a Buy with Blue Wave > -60 still triggers a long (no Blue Wave rule on longs)', () => {
    const { m, d } = canonicalLong();
    m.m1.bw[d] = 10;
    assert.equal(run(m).r.trades.length, 1);
  });

  it('the setup uses only the trigger bar: lower lows before it and on later bars are ignored', () => {
    const { m, d } = canonicalLong();
    setBar(m, d - 1, 5000, 5000, 4990, 5000);
    setBar(m, d - 4, 5000, 5000, 4980, 5000);
    setBar(m, d + 2, 5000, 5000, 4997, 5000); // above S 4995.75, so no exit
    const t = run(m).r.trades[0];
    assert.equal(t.setupQ, Q(4996));
    assert.equal(t.dQ, Q(5.5));
    assert.equal(t.open, true);

    const s = canonicalShort();
    setBar(s.m, s.d - 1, 5000, 5010, 5000, 5000);
    setBar(s.m, s.d + 2, 5000, 5003, 5000, 5000); // below S 5004.25
    const ts = run(s.m).r.trades[0];
    assert.equal(ts.setupQ, Q(5004));
    assert.equal(ts.dQ, Q(4.5));
  });
});

// ── Entry on the trigger row ─────────────────────────────────────────────

describe('entry on the trigger row', () => {
  it('a 15m fail on the trigger row is filtered and is not retried on later rows', () => {
    const { m, d } = canonicalLong();
    const j = q15(m, d);
    assert.equal(m.m15.t[j], at(10, 0)); // 10:20 reads the 10:00 row
    // 10:00 row falls below 09:45 on all three plots; 10:15 (read from 10:29) rises again.
    set15(m, m.m15.t[j], { mf: -1, bw: -1, rsi: -1 });
    const { res } = run(m);
    for (const r of res.runs) {
      assert.equal(r.triggers.length, 1, r.runId);
      const rec = r.triggers[0];
      assert.equal(rec.outcome, 'filtered', r.runId);
      assert.equal(rec.filterFailInWindow, true, r.runId);
      assert.deepEqual(rec.attempts.map((a) => [a.row, a.pass]), [[d, false]], r.runId);
      assert.equal(r.trades.length, 0, r.runId);
      assert.equal(r.whole.funnel.filtered, 1, r.runId);
      assert.equal(r.whole.expiredWithFilterFail, 0, r.runId);
    }
  });

  it('a trigger while a position is open is ignored, on the entry row, later rows and either side', () => {
    const { m, d } = canonicalLong();
    longTrigger(m, d + 1);  // the entry bar
    shortTrigger(m, d + 3); // opposite side: no cancel, just ignored
    longTrigger(m, d + 5);
    const { r } = run(m);
    assert.deepEqual(r.triggers.map((x) => x.outcome), ['trade', 'ignored_position', 'ignored_position', 'ignored_position']);
    assert.deepEqual(r.triggers.map((x) => x.attempts.length), [1, 0, 0, 0]);
    assert.equal(r.trades.length, 1);
    assert.equal(r.whole.funnel.ignored_position, 3);
  });

  it('exits on a row are checked first, so a trigger on the exit row trades', () => {
    const { m, d } = canonicalLong();
    const x = d + 3;
    setBar(m, x, 5000, 5000, 4995, 4995); // low 4995 <= S 4995.75: stop
    longTrigger(m, x);
    const { r } = run(m);
    assert.equal(r.trades.length, 2);
    assert.equal(r.trades[0].exitRow, x);
    assert.equal(r.trades[0].reason, 'stop');
    assert.deepEqual(r.triggers.map((t) => t.outcome), ['trade', 'trade']);
    // Second trade: R = close(x) 4995, T = lowest candidate above it = 5010, entry open 5000 at x+1.
    const t = r.trades[1];
    assert.equal(t.triggerRow, x);
    assert.equal(t.entryRow, x + 1);
    assert.equal(t.rQ, Q(4995));
    assert.equal(t.tQ, Q(5010));
    assert.equal(t.eQ, Q(5000.25));
    assert.equal(t.setupQ, Q(4995));
    assert.equal(t.rawStopQ, Q(4994.75));
    assert.equal(t.dQ, Q(5.5));
    assert.equal(t.sQ, Q(4994.75));
    assert.equal(t.open, true);
  });

  it('a trigger on the last row with a 15m pass is insufficient data', () => {
    const m = build({ n: 330 });
    longTrigger(m, 329);
    resCandidate(m, F0 + 10, 5010); // a target exists, so this is not no_target
    const { res } = run(m);
    for (const r of res.runs) {
      assert.equal(r.triggers[0].outcome, 'insufficient', r.runId);
      assert.deepEqual(r.triggers[0].attempts.map((a) => a.pass), [true], r.runId);
      assert.equal(r.trades.length, 0, r.runId);
      assert.equal(r.whole.funnel.insufficient, 1, r.runId);
    }
  });

  it('a trigger on the last row with a 15m fail is filtered, not insufficient', () => {
    const m = build({ n: 330 });
    longTrigger(m, 329);
    resCandidate(m, F0 + 10, 5010);
    set15(m, m.m15.t[q15(m, 329)], { mf: -1, bw: -1, rsi: -1 });
    for (const r of run(m).res.runs) assert.equal(r.triggers[0].outcome, 'filtered', r.runId);
  });

  it('a trigger on the second-to-last row enters on the last row and stays open', () => {
    const m = build({ n: 330 });
    longTrigger(m, 328);
    resCandidate(m, F0 + 10, 5010);
    const { r, res } = run(m);
    const t = r.trades[0];
    assert.equal(t.entryRow, 329);
    assert.equal(t.eQ, Q(5000.25));
    assert.equal(t.open, true);
    assert.equal(res.lastCloseQ, Q(5000));
    // (5000 - 5000.25) * 4 * 5 - 12 = -17 quarter dollars.
    assert.equal(fmtDollarsNq(t.markNq), '-4.25');
  });

  it('expired, cancelled and ignored_window stay in the funnel with zero counts', () => {
    const { m, d } = canonicalLong();
    longTrigger(m, d + 1);
    shortTrigger(m, d + 2);
    const { res } = run(m);
    for (const r of res.runs) {
      for (const s of [r.whole, r.first, r.second]) {
        for (const k of ['expired', 'cancelled', 'ignored_window']) assert.equal(s.funnel[k], 0, `${r.runId} ${k}`);
      }
      assert.equal(r.whole.funnel.ignored_position, 2, r.runId);
    }
  });
});

// ── F and warm-up ────────────────────────────────────────────────────────

describe('first eligible row F', () => {
  it('F is 1m row 300 when the 15m history is long enough, never row 0', () => {
    const d = prepare(toSnapshot(build({ hist15: 200 })));
    assert.equal(d.q[0] >= 100, true, 'row 0 already has 15m history');
    assert.equal(d.F, 300);
    assert.equal(d.info.rowsBeforeF, 300);
  });

  it('F moves later when the 15m warm-up binds: q[F] >= 100', () => {
    const d = prepare(toSnapshot(build({ hist15: 80 })));
    assert.equal(d.q[313], 99);
    assert.equal(d.q[314], 100);
    assert.equal(d.F, 314);
  });

  it('aborts when no row reaches index 300', () => {
    aborts(build({ n: 300 }), /no row qualifies as F/);
    assert.equal(prepare(toSnapshot(build({ n: 301 }))).F, 300);
  });

  it('aborts when no row has a last closed 15m row at index >= 100', () => {
    aborts(build({ hist15: 50 }), /no row qualifies as F/);
  });

  it('a trigger before F is not counted and cannot trade', () => {
    for (const d of [F0 - 3, F0 - 1]) {
      const m = build();
      longTrigger(m, d);
      resCandidate(m, F0 - 10, 5010);
      for (const r of run(m).res.runs) {
        assert.equal(r.triggers.length, 0, `trigger at ${d}`);
        assert.equal(r.trades.length, 0, `trigger at ${d}`);
      }
    }
  });

  it('a trigger before a late F (15m warm-up) is not counted', () => {
    const m = build({ hist15: 80 });
    longTrigger(m, 310);
    resCandidate(m, 305, 5010);
    assert.equal(run(m).r.triggers.length, 0);
  });

  it('a trigger on F counts and may use lookbacks before F', () => {
    const m = build();
    longTrigger(m, F0);
    resCandidate(m, 200, 5010);
    setBar(m, F0 - 1, 5000, 5000, 4990, 5000); // before d: not part of the setup low
    const { r } = run(m);
    assert.equal(r.triggers.length, 1);
    assert.equal(r.trades[0].tQ, Q(5010));
    assert.equal(r.trades[0].setupQ, Q(5000));
    assert.equal(r.trades[0].entryRow, F0 + 1);
  });
});

// ── 15m filter ───────────────────────────────────────────────────────────

describe('15m filter', () => {
  it('uses the last closed 15m row: 10:13 reads 09:45, 10:14 reads 10:00 (no look-ahead)', () => {
    const m = build();
    const d = prepare(toSnapshot(m));
    assert.equal(m.m15.t[d.q[313]], at(9, 45));
    assert.equal(m.m15.t[d.q[314]], at(10, 0));
    assert.equal(lastClosed15Index(d.t15, at(10, 13)), idx15(m, at(9, 45)));
    assert.equal(lastClosed15Index(d.t15, at(10, 14)), idx15(m, at(10, 0)));
    assert.equal(d.t[313], at(10, 13));
  });

  for (const [k, want] of [[313, 0], [314, 1]]) {
    it(`a trigger at row ${k} ${want ? 'passes on the 10:00 row' : 'fails on the 09:45 row'}`, () => {
      const m = build();
      longTrigger(m, k);
      resCandidate(m, F0 + 5, 5010);
      for (const [S, v] of [[at(9, 30), 10], [at(9, 45), 5], [at(10, 0), 20]]) set15(m, S, { mf: v, bw: v, rsi: v });
      for (const r of run(m).res.runs) assert.equal(r.trades.length, want, r.runId);
    });
  }

  const variants = [
    ['Mny Flow up, Blue Wave and RSI down', { mf: [1, 2], bw: [2, 1], rsi: [2, 1] }, { 'HTF-a': 1, 'HTF-b': 0, 'HTF-c': 0 }],
    ['Mny Flow flat, Blue Wave and RSI up', { mf: [1, 1], bw: [1, 2], rsi: [1, 2] }, { 'HTF-a': 0, 'HTF-b': 1, 'HTF-c': 0 }],
    ['Mny Flow and Blue Wave up, RSI null', { mf: [1, 2], bw: [1, 2], rsi: [1, null] }, { 'HTF-a': 1, 'HTF-b': 1, 'HTF-c': 0 }],
    ['all three up', { mf: [1, 2], bw: [1, 2], rsi: [1, 2] }, { 'HTF-a': 1, 'HTF-b': 1, 'HTF-c': 1 }],
    ['Mny Flow null before, others up', { mf: [null, 2], bw: [1, 2], rsi: [1, 2] }, { 'HTF-a': 0, 'HTF-b': 1, 'HTF-c': 0 }],
  ];
  for (const [name, vals, want] of variants) {
    it(`long: ${name}`, () => {
      const { m, k } = canonicalLong();
      const j = q15(m, k);
      for (const [key, [prev, cur]] of Object.entries(vals)) { m.m15[key][j - 1] = prev; m.m15[key][j] = cur; }
      const { res } = run(m);
      for (const r of res.runs) assert.equal(r.trades.length, want[r.runId], r.runId);
    });
    it(`short (Falling): ${name}, mirrored`, () => {
      const { m, k } = canonicalShort();
      const j = q15(m, k);
      const neg = (v) => (v === null ? null : -v);
      for (const [key, [prev, cur]] of Object.entries(vals)) { m.m15[key][j - 1] = neg(prev); m.m15[key][j] = neg(cur); }
      const { res } = run(m);
      for (const r of res.runs) assert.equal(r.trades.length, want[r.runId], r.runId);
    });
  }

  it('filter15 rejects unknown runs', () => {
    const d = prepare(toSnapshot(build()));
    assert.throws(() => filter15(d, 'HTF-x', 'long', 320));
    assert.throws(() => simulateRun(d, 'HTF-x'));
  });
});

// ── Stop clamp ───────────────────────────────────────────────────────────

describe('stop clamp (2 to 8 points on the 0.25 grid)', () => {
  const cases = [
    // setup low, raw distance, D, floor, cap
    [5000, 0.5, 2, true, false],
    [4998.75, 1.75, 2, true, false],
    [4998.5, 2, 2, false, false],
    [4992.5, 8, 8, false, false],
    [4992.25, 8.25, 8, false, true],
  ];
  for (const [low, raw, D, floor, cap] of cases) {
    it(`setup low ${low}: raw ${raw} → D ${D}`, () => {
      const { m } = longWith({ setupLow: low });
      const t = run(m).r.trades[0];
      assert.equal(t.eQ, Q(5000.25));
      assert.equal(t.rawDistQ, Q(raw));
      assert.equal(t.dQ, Q(D));
      assert.equal(t.sQ, Q(5000.25 - D));
      assert.equal(t.floor, floor);
      assert.equal(t.cap, cap);
    });
  }

  it('an entry open at or below the raw stop clamps D to 2 (no skip)', () => {
    const { m } = longWith({ setupLow: 4999, open: 4998.5 });
    const t = run(m).r.trades[0];
    assert.equal(t.eQ, Q(4998.75));
    assert.equal(t.rawDistQ, Q(0));
    assert.equal(t.dQ, Q(2));
    assert.equal(t.sQ, Q(4996.75));
  });

  it('short clamp mirrors: raw stop above E', () => {
    const { m, d } = canonicalShort();
    setBar(m, d, 5000, 5009, 5000, 5000); // E 4999.75, raw stop 5009.25 → raw 9.5, D 8, S 5007.75
    const t = run(m).r.trades[0];
    assert.equal(t.rawDistQ, Q(9.5));
    assert.equal(t.dQ, Q(8));
    assert.equal(t.sQ, Q(5007.75));
    assert.equal(t.cap, true);
  });
});

// ── Targets ──────────────────────────────────────────────────────────────

describe('target selection', () => {
  it('long takes the lowest candidate above close(k); candidates before F count', () => {
    const { m } = longWith();
    m.m1.res.fill(null);
    resCandidate(m, 302, 5008);
    resCandidate(m, 200, 5003);
    resCandidate(m, 306, 4998);
    resCandidate(m, 310, 5000); // equal to R is not above it
    // non-candidates: off by a tick, no change, previous value missing
    resCandidate(m, 314, 5001); m.m1.h[311] = 5001.25; m.m1.o[311] = 5001.25; m.m1.c[311] = 5001.25; m.m1.l[311] = 5001.25;
    resCandidate(m, 318, 5002); m.m1.res[317] = 5002;
    m.m1.res[250] = 5001.5; setBar(m, 247, 5001.5, 5001.5, 5001.5, 5001.5);
    assert.equal(run(m).r.trades[0].tQ, Q(5003));
  });

  it('a candidate on row k counts; one on row k+1 does not', () => {
    const a = longWith();
    a.m.m1.res.fill(null);
    resCandidate(a.m, a.k, 5002);
    assert.equal(run(a.m).r.trades[0].tQ, Q(5002));

    const b = longWith();
    b.m.m1.res.fill(null);
    resCandidate(b.m, b.k + 1, 5002);
    const { r } = run(b.m);
    assert.equal(r.trades.length, 0);
    assert.equal(r.triggers[0].outcome, 'no_target');
  });

  it('no candidate above R closes the window "no target"', () => {
    const { m } = longWith({ target: 4999 });
    const { r } = run(m);
    assert.equal(r.triggers[0].outcome, 'no_target');
    assert.equal(r.whole.funnel.no_target, 1);
  });

  it('short takes the highest Support candidate below close(k)', () => {
    const { m } = canonicalShort();
    m.m1.sup.fill(null);
    supCandidate(m, 302, 4990);
    supCandidate(m, 306, 4996);
    supCandidate(m, 310, 5001);
    supCandidate(m, 314, 5000);
    assert.equal(run(m).r.trades[0].tQ, Q(4996));
  });
});

describe('target candidates with a coarser SR resolution (sr_period_s)', () => {
  // Row i opens at T0 + 60 i and T0 is on the 5m grid, so rows 5m..5m+4 share one 5m bar.
  it('long: a step equal to the high of the 5m bar 3 bars back counts; a 1m-style step does not', () => {
    const { m } = longWith();
    m.m1.res.fill(null);
    setBar(m, 302, 5000, 5006, 5000, 5000);         // 5m bar of rows 300-304 has high 5006
    m.m1.res[318] = 5000; m.m1.res[319] = 5006;     // row 319 sits in the 5m bar of rows 315-319
    setBar(m, 311, 5004, 5004, 5004, 5004);         // high[j-3] for j = 314, but its 5m bar (295-299) tops at 5000
    m.m1.res[313] = 5000; m.m1.res[314] = 5004;
    assert.equal(run(m).r.trades[0].tQ, Q(5004));   // default 1m rule: only the row 314 step counts
    m.srPeriodS = 300;
    const { res, r } = run(m);
    assert.equal(r.trades[0].tQ, Q(5006));
    assert.equal(res.info.srPeriodS, 300);
  });

  it('short mirrors with Support and the 5m bar low', () => {
    const { m } = canonicalShort();
    m.m1.sup.fill(null);
    setBar(m, 302, 5000, 5000, 4994, 5000);
    m.m1.sup[318] = 5000; m.m1.sup[319] = 4994;
    m.srPeriodS = 300;
    assert.equal(run(m).r.trades[0].tQ, Q(4994));
  });

  it('across a halt the pivot is 3 existing 5m bars back, not 15 minutes back', () => {
    const m = build({ gaps: { 310: 1800 } });       // 30 minutes with no rows before row 310
    const d = F0 + 20;
    longTrigger(m, d);
    setBar(m, d + 1, 5000, 5000, 5000, 5000);
    setBar(m, 302, 5000, 5006, 5000, 5000);         // 5m bars: 300-304, 305-309, (halt), 310-314, 315-319
    m.m1.res[318] = 5000; m.m1.res[319] = 5006;     // 15 minutes before row 315 falls inside the halt
    m.srPeriodS = 300;
    assert.equal(run(m).r.trades[0].tQ, Q(5006));
  });

  it('a row with fewer than 3 earlier 5m bars gives no candidate', () => {
    const { m } = longWith();
    m.m1.res.fill(null);
    m.m1.res[3] = 4990; m.m1.res[4] = 5001;         // row 4 sits in the first 5m bar of the data
    m.srPeriodS = 300;
    const { r } = run(m);
    assert.equal(r.triggers[0].outcome, 'no_target');
  });

  it('aborts on an sr_period_s that is not a whole number of minutes dividing an hour', () => {
    for (const bad of [0, 90, 420, 2400, 7200, 86400, '300', null, 300.5]) {
      const { m } = longWith();
      m.srPeriodS = bad;
      aborts(m, /sr_period_s/);
    }
    for (const ok of [60, 900, 3600]) {
      const { m } = longWith();
      m.srPeriodS = ok;
      assert.equal(run(m).res.info.srPeriodS, ok);
    }
  });
});

// ── Exits ────────────────────────────────────────────────────────────────

describe('exits', () => {
  it('case 3: stop and target inside the same bar is a stop', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 5000, 5010.25, 4995.75, 5000);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 3);
    assert.equal(t.reason, 'stop');
    assert.equal(t.exitQ, Q(4995.5));
    assert.equal(fmtDollarsNq(t.nq), '-31.75');
    assert.equal(fmtDollarsNq(t.grossNq), '-26.25');
    assert.equal(t.stopTargetAlso, true);
  });

  it('case 1: a gap open through the stop fills at the open less a tick', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 4990, 4990, 4989, 4990);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 1);
    assert.equal(t.exitQ, Q(4989.75));
    assert.equal(fmtDollarsNq(t.nq), '-60.50');
    assert.equal(fmtDollarsNq(t.grossNq), '-55.00');
    assert.equal(t.stopTargetAlso, false);
  });

  it('case 2: an open one tick through the target fills at the open', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 5012, 5012, 4990, 4990);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 2);
    assert.equal(t.reason, 'target');
    assert.equal(t.exitQ, Q(5012));
    assert.equal(fmtDollarsNq(t.nq), '50.75');
  });

  it('an open equal to the target is not case 2; the low then stops it', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 5010, 5010, 4995, 4995);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 4);
    assert.equal(t.reason, 'stop');
    assert.equal(t.touched, true);
  });

  it('case 4: the target needs one tick through and fills at max(T, open)', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 5000, 5010.25, 5000, 5010);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 4);
    assert.equal(t.exitQ, Q(5010));
    assert.equal(fmtDollarsNq(t.nq), '40.75');
  });

  it('an entry gap past the target exits on the entry bar by case 2', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 1, 5011, 5011, 5011, 5011);
    const t = run(m).r.trades[0];
    assert.equal(t.exitRow, k + 1);
    assert.equal(t.exitCase, 2);
    assert.equal(t.exitQ, Q(5011));
    assert.equal(fmtDollarsNq(t.nq), '-4.25');
    assert.equal(t.cap, true);
    assert.equal(t.under1R, true);
    assert.equal(t.behind, true);
  });

  it('touched but not filled, and stop taken with the target also reached', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 2, 5000, 5010, 5000, 5000);
    setBar(m, k + 3, 5000, 5000, 4995, 4995);
    const { r } = run(m);
    assert.equal(r.whole.touchedNotFilled, 1);
    assert.equal(r.whole.stopTakenTargetReached, 0);

    const b = canonicalLong();
    setBar(b.m, b.k + 3, 4995, 5011, 4995, 5000); // case 1, bar also meets the target rule
    const rb = run(b.m).r;
    assert.equal(rb.trades[0].exitCase, 1);
    assert.equal(rb.whole.stopTakenTargetReached, 1);
  });

  it('short exits mirror: target by low, stop by a gap above S', () => {
    const a = canonicalShort();
    setBar(a.m, a.k + 3, 5000, 5000, 4989.75, 4990);
    const ta = run(a.m).r.trades[0];
    assert.equal(ta.reason, 'target');
    assert.equal(ta.exitQ, Q(4990));
    assert.equal(fmtDollarsNq(ta.nq), '45.75');

    const b = canonicalShort();
    setBar(b.m, b.k + 3, 5006, 5006, 5006, 5006);
    const tb = run(b.m).r.trades[0];
    assert.equal(tb.exitCase, 1);
    assert.equal(tb.exitQ, Q(5006.25));
    assert.equal(fmtDollarsNq(tb.nq), '-35.50');

    const c = canonicalShort();
    setBar(c.m, c.k + 3, 5000, 5004.25, 4989.75, 5000);
    const tc = run(c.m).r.trades[0];
    assert.equal(tc.exitCase, 3);
    assert.equal(tc.exitQ, Q(5004.5));
  });

  it('an open trade at end of data gets a mark Net $ with no exit slippage', () => {
    const { m } = canonicalLong();
    const { r, res } = run(m);
    const t = r.trades[0];
    assert.equal(t.open, true);
    assert.equal(res.lastCloseQ, Q(5000));
    assert.equal(fmtDollarsNq(t.markNq), '-9.25');
    assert.equal(r.whole.closed.n, 0);
    assert.equal(r.whole.open.n, 1);
    assert.equal(r.whole.winRate, null);
    assert.equal(r.whole.wilson, null);
    assert.equal(r.whole.avgRHundredths, null);
    assert.equal(r.whole.netNq, 0);
    assert.equal(r.whole.maxDdNq, 0);
    assert.equal(r.whole.funnel.open, 1);
  });
});

// ── Worked examples ──────────────────────────────────────────────────────

describe('worked examples (design lines 80 and 91)', () => {
  const setup = () => longWith({ setupLow: 4993, target: 5004 });

  it('target fill 5004.00 with E 5000.25 and D 7.5: Net 15.75, R 0.42', () => {
    const { m, k } = setup();
    setBar(m, k + 3, 5000, 5004.25, 5000, 5004);
    const t = run(m).r.trades[0];
    assert.equal(t.dQ, Q(7.5));
    assert.equal(t.sQ, Q(4992.75));
    assert.equal(fmtDollarsNq(t.nq), '15.75');
    assert.equal(fmtR(rHundredths(t.nq, t.dQ)), '0.42');
  });

  it('stop fill 4992.50: Net -41.75, R -1.11', () => {
    const { m, k } = setup();
    setBar(m, k + 3, 5000, 5000, 4992.75, 4995);
    const t = run(m).r.trades[0];
    assert.equal(t.exitQ, Q(4992.5));
    assert.equal(fmtDollarsNq(t.nq), '-41.75');
    assert.equal(fmtR(rHundredths(t.nq, t.dQ)), '-1.11');
  });

  it('a bar opening 5004.25 and trading down to 4992.00 exits at the target, 5004.25', () => {
    const { m, k } = setup();
    setBar(m, k + 3, 5004.25, 5004.25, 4992, 4993);
    const t = run(m).r.trades[0];
    assert.equal(t.exitCase, 2);
    assert.equal(t.exitQ, Q(5004.25));
  });

  it('a stop at the 2-point floor with no gap: Nq -57, Dq 8 → R -1.43', () => {
    const { m, k } = longWith();
    setBar(m, k + 3, 5000, 5000, 4998.25, 4999);
    const t = run(m).r.trades[0];
    assert.equal(t.nq, -57);
    assert.equal(t.dQ, 8);
    assert.equal(fmtDollarsNq(t.nq), '-14.25');
    assert.equal(rHundredths(-57, 8), -143);
    assert.equal(fmtR(rHundredths(t.nq, t.dQ)), '-1.43');
  });
});

// ── Accounting ───────────────────────────────────────────────────────────

describe('accounting', () => {
  it('R rounds half away from zero with integers', () => {
    assert.equal(rHundredths(63, 30), 42);
    assert.equal(rHundredths(-167, 30), -111);
    assert.equal(rHundredths(5, 8), 13);   // 0.125
    assert.equal(rHundredths(-5, 8), -13); // -0.125
    assert.equal(rHundredths(0, 8), 0);
    assert.equal(roundHundredths(-1n, 200n), -1n); // -0.005
  });

  it('average R over 25 trades with mixed Dq is exact (Lcm in BigInt)', () => {
    const list = [];
    for (const [nq, dq] of [[-57, 8], [63, 30], [100, 12], [-177, 32], [0, 20]]) {
      for (let i = 0; i < 5; i++) list.push({ nq, dq });
    }
    // Sum of R = 5 * (-57/40 + 63/150 + 100/60 - 177/160 + 0) = -5335/2400; mean = -1067/12000 = -0.0889...
    assert.equal(averageRHundredths(list), -9);
    assert.equal(averageRHundredths([{ nq: 5, dq: 8 }]), 13);
    assert.equal(averageRHundredths([{ nq: 1, dq: 8 }, { nq: 4, dq: 8 }]), 6); // 0.0625
    assert.equal(averageRHundredths([]), null);
  });

  it('Wilson interval for 5 of 10 is 23.7% to 76.3%', () => {
    const w = wilson(5, 10);
    assert.equal(fmtRate(w.lower), '23.7');
    assert.equal(fmtRate(w.upper), '76.3');
    assert.equal(wilson(0, 0), null);
    assert.equal(fmtRate(wilson(0, 3).lower), '0.0');
    assert.equal(fmtRate(wilson(3, 3).upper), '100.0');
  });

  it('rates print -0.0 as 0.0 and missing as n/a', () => {
    assert.equal(fmtRate(-1e-9), '0.0');
    assert.equal(fmtRate(null), 'n/a');
    assert.equal(fmtRate(0.5), '50.0');
    assert.equal(fmtR(null), 'n/a');
    assert.equal(fmtR(-110), '-1.10');
    assert.equal(fmtDollarsNq(-1), '-0.25');
    assert.equal(fmtDollarsNq(0), '0.00');
  });

  it('max drawdown runs over closed trades in exit order from a 0 peak', () => {
    const rec = (row, exitRow, nq, extra = {}) => ({
      row, outcome: 'trade', attempts: [], segment: 1,
      trade: { open: false, exitRow, nq, grossNq: nq, dQ: 8, side: 'long', reason: nq > 0 ? 'target' : 'stop', ...extra },
    });
    const s = summarize([rec(1, 30, -125), rec(2, 10, 203), rec(3, 20, -242)]);
    // exit order: +50.75, -60.50, -31.25 → cum 50.75, -9.75, -41.00; drawdown 91.75
    assert.equal(fmtDollarsNq(s.maxDdNq), '91.75');
    assert.equal(fmtDollarsNq(s.netNq), '-41.00');
    assert.equal(s.wins, 1);
    const neg = summarize([rec(1, 5, -20)]);
    assert.equal(fmtDollarsNq(neg.maxDdNq), '5.00');
  });

  it('the five counts of line 82 include open trades; the other stats exclude them', () => {
    const m = build({ gaps: { 341: 120 } });
    // Trade 1: trigger 320 (low 4996), entry open 5011 at 321: E 5011.25, raw stop 4995.75,
    // raw distance 15.5 → cap, D 8. T 5010 is behind E and the entry bar opens one tick
    // through it, so it exits on the entry bar by case 2 at 5011: (5011 - 5011.25) * 20 - 12 = -17 nq.
    longTrigger(m, 320);
    resCandidate(m, F0 + 10, 5010);
    setBar(m, 320, 5000, 5000, 4996, 5000);
    setBar(m, 321, 5011, 5011, 5011, 5011);
    // Trade 2: trigger 340 (flat 4999.75), a 120 s gap before entry row 341 (open 5000).
    // R 4999.75, so T = 5000 (row 330); E 5000.25, so T is behind entry; raw stop 4999.5,
    // raw distance 0.75 → floor, D 2, S 4998.25. Flat 5000 bars after: open to the end.
    longTrigger(m, 340);
    setBar(m, 340, 4999.75, 4999.75, 4999.75, 4999.75);
    resCandidate(m, 330, 5000);
    const { r } = run(m);
    assert.equal(r.trades.length, 2);
    const [a, b] = r.trades;
    assert.equal(a.open, false);
    assert.equal(a.cap, true);
    assert.equal(a.exitRow, 321);
    assert.equal(b.open, true);
    assert.equal(b.entryRow, 341);
    assert.equal(b.eQ, Q(5000.25));
    assert.equal(b.tQ, Q(5000));
    assert.equal(b.dQ, Q(2));
    assert.equal(b.floor, true);
    assert.equal(b.gap, true);
    assert.equal(a.gap, false);
    const s = r.whole;
    assert.equal(s.stopsOnFloor, 1);
    assert.equal(s.stopsOnCap, 1);
    assert.equal(s.targetsUnder1R, 2);
    assert.equal(s.targetAtOrBehindEntry, 2);
    assert.equal(s.gapTrades, 1);
    assert.equal(s.closed.n, 1);
    assert.equal(s.open.n, 1);
    assert.equal(fmtDollarsNq(s.netNq), '-4.25');
    assert.equal(s.targetHitRate, 1);
    assert.equal(s.targetExitsNonPositive, 1);
    assert.equal(s.touchedNotFilled, 0);
    assert.equal(fmtDollarsNq(b.markNq), '-4.25');
  });

  it('70/30 segments by trigger time use integer arithmetic', () => {
    assert.equal(segmentOf(360, 0, 600), 1);  // 3600 < 4200
    assert.equal(segmentOf(420, 0, 600), 2);  // 4200 is not < 4200
    assert.equal(segmentOf(480, 0, 660), 2);  // n = 12 rows, d = 8: 80 >= 77
    assert.equal(segmentOf(420, 0, 660), 1);
  });

  it('each segment has its own funnel and stats', () => {
    const m = build({ n: 400 });
    // F at row 300 (10:00), last row 399: boundary 10 * (d - 300) < 7 * 99 → d <= 369 in segment 1.
    // Trigger 320: E 5000.25, target exit at 5010 on row 325 → (5010 - 5000.25) * 20 - 12 = 183 nq, a win.
    // Trigger 370 (segment 2): flat bars, T 5010, enters at 371 and is still open at row 399.
    longTrigger(m, 320);
    resCandidate(m, F0 + 10, 5010);
    setBar(m, 325, 5000, 5010.25, 5000, 5010);
    longTrigger(m, 370);
    const { r } = run(m);
    assert.deepEqual(r.triggers.map((x) => x.segment), [1, 2]);
    assert.equal(r.first.funnel.triggers, 1);
    assert.equal(r.first.funnel.closed, 1);
    assert.equal(r.first.netNq, 183);
    assert.equal(r.second.funnel.triggers, 1);
    assert.equal(r.second.funnel.open, 1);
    assert.equal(r.second.closed.n, 0);
    assert.equal(r.second.open.n, 1);
    assert.equal(r.second.winRate, null);
    assert.equal(r.first.winRate, 1);
  });
});

// ── Staleness and gaps ───────────────────────────────────────────────────

describe('stale 15m attempts', () => {
  it('"across a break": a 1m jump from 10:29 to 11:00 leaves 10:15 as the last closed row', () => {
    const m = build({ gaps: { 330: 1800 } });
    assert.equal(m.m1.t[330], at(11, 0));
    // Trigger on 11:00 (row 330): 10:15 closed at 10:30, 31 min before 11:01 → stale, with a break inside.
    // The break comes before the trigger bar, so the trade (entry 331) is not a gap trade.
    longTrigger(m, 330);
    resCandidate(m, F0 + 10, 5010);
    const { r, res } = run(m);
    assert.equal(m.m15.t[q15(m, 330)], at(10, 15));
    assert.deepEqual(r.triggers[0].attempts.map((a) => [a.stale, a.pass]), [['break', true]]);
    assert.deepEqual(r.whole.stale, { break: { pass: 1, fail: 0 }, no_break: { pass: 0, fail: 0 } });
    assert.equal(r.trades[0].entryRow, 331);
    assert.equal(r.whole.gapTrades, 0);
    assert.deepEqual(res.info.gaps1m.map((g) => g.seconds), [1860]);
    assert.equal(res.info.emptyBuckets15m.length, 0);
  });

  it('a trigger on 10:29 just before the break is not stale, and its entry at 11:00 is a gap trade', () => {
    const m = build({ gaps: { 330: 1800 } });
    longTrigger(m, 329);
    resCandidate(m, F0 + 10, 5010);
    const { r } = run(m);
    assert.equal(m.m15.t[q15(m, 329)], at(10, 15));
    assert.deepEqual(r.triggers[0].attempts.map((a) => [a.stale, a.pass]), [[null, true]]);
    assert.deepEqual(r.whole.stale, { break: { pass: 0, fail: 0 }, no_break: { pass: 0, fail: 0 } });
    assert.equal(r.trades[0].entryRow, 330);
    assert.equal(r.trades[0].gap, true);
    assert.equal(r.whole.gapTrades, 1);
  });

  it('"no break": a missing 10:15 row; 10:28 is 14 min old (not stale), 10:29 is 15 min (stale)', () => {
    const m = build();
    m.drop15.add(at(10, 15));
    set15(m, at(10, 0), { mf: 0, bw: 0, rsi: 0 }); // falls from 09:45 → every run fails
    longTrigger(m, 328);
    longTrigger(m, 329);
    const { res } = run(m);
    for (const r of res.runs) {
      assert.deepEqual(r.triggers.map((x) => x.attempts.map((a) => a.stale)), [[null], ['no_break']], r.runId);
      assert.deepEqual(r.whole.stale, { break: { pass: 0, fail: 0 }, no_break: { pass: 0, fail: 1 } });
      assert.deepEqual(r.triggers.map((x) => x.outcome), ['filtered', 'filtered'], r.runId);
    }
    assert.deepEqual(res.info.gaps15m.map((g) => g.seconds), [1800]);
  });

  it('empty 15m buckets inside the 1m range are reported', () => {
    const m = build({ gaps: { 330: 1800 }, all15: true });
    const { res } = run(m);
    assert.deepEqual(res.info.emptyBuckets15m, [at(10, 30), at(10, 45)]);
    assert.equal(res.info.emptyBuckets15mOutside1mRange, 100);
  });

  it('the daily halt and weekend close are not reported as gaps', () => {
    const et = (day, hh, mm) => Date.UTC(2026, 9, day, hh + 4, mm) / 1000; // EDT
    assert.equal(isScheduledClose(et(14, 16, 59), et(14, 18, 0), 59), true);   // Wed
    assert.equal(isScheduledClose(et(14, 16, 58), et(14, 18, 0), 59), false);
    assert.equal(isScheduledClose(et(14, 16, 59), et(14, 18, 1), 59), false);
    assert.equal(isScheduledClose(et(16, 16, 59), et(18, 18, 0), 59), true);   // Fri → Sun
    assert.equal(isScheduledClose(et(16, 16, 59), et(16, 18, 0), 59), false);  // Fri same day
    assert.equal(isScheduledClose(et(16, 16, 59), et(19, 18, 0), 59), false);  // Fri → Mon
    assert.equal(isScheduledClose(et(14, 16, 45), et(14, 18, 0), 45), true);   // 15m
    assert.equal(etLabel(et(14, 16, 59)), '2026-10-14 16:59 ET');
  });
});

// ── Non-finite values ────────────────────────────────────────────────────

describe('non-finite plots', () => {
  it('1m nulls on the trigger row no longer block a long entry, and are counted per plot', () => {
    const { m, d } = canonicalLong();
    m.m1.bw[d] = null; m.m1.mf[d] = null; m.m1.sto[d] = null; m.m1.sto[d - 1] = null;
    const { res } = run(m);
    for (const r of res.runs) assert.equal(r.trades.length, 1, r.runId);
    assert.equal(res.info.nonFinite['1m B plot 2 Blue Wave'], 1);
    assert.equal(res.info.nonFinite['1m B plot 4 Mny Flow'], 1);
    assert.equal(res.info.nonFinite['1m B plot 16 Sto RSI'], 2);
    assert.equal(res.info.nonFinite['1m B plot 8 Blue Wave Crossing Down'], 360);
    assert.equal(res.info.nonFinite['15m B plot 15 RSI'], 0);
  });

  it('a null 15m Mny Flow on the read row fails HTF-a and HTF-c; HTF-b passes on the other two', () => {
    const { m, d } = canonicalLong();
    m.m15.mf[q15(m, d)] = null;
    const { res } = run(m);
    const want = { 'HTF-a': 'filtered', 'HTF-b': 'trade', 'HTF-c': 'filtered' };
    for (const r of res.runs) assert.equal(r.triggers[0].outcome, want[r.runId], r.runId);
    assert.equal(res.info.nonFinite['15m B plot 4 Mny Flow'], 1);
  });

  it('null 15m values on the row before the read row fail the filter for every run', () => {
    const { m, d } = canonicalLong();
    const j = q15(m, d);
    for (const key of ['mf', 'bw', 'rsi']) m.m15[key][j - 1] = null;
    const { res } = run(m);
    for (const r of res.runs) assert.equal(r.triggers[0].outcome, 'filtered', r.runId);
    assert.equal(res.info.nonFinite['15m B plot 2 Blue Wave'], 1);
    assert.equal(res.info.nonFinite['15m B plot 15 RSI'], 1);
  });
});

// ── Abort rules ──────────────────────────────────────────────────────────

describe('abort rules', () => {
  const snap = () => toSnapshot(canonicalLong().m);

  it('accepts the canonical snapshot without warnings', () => {
    const d = prepare(snap());
    assert.deepEqual(d.info.warnings, []);
    assert.equal(d.info.repaint, 'unverified');
  });

  it('format, sha256 and headers', () => {
    const a = snap(); a.format = 'x';
    aborts(a, /format/);
    const b = snap(); b.rows.m1.bars[5][4] = 5000.25; b.rows.m1.bars[5][2] = 5000.25;
    aborts(b, /sha256 mismatch/);
    const c = snap(); c.count_1m += 1;
    aborts(c, /count_1m/);
    const e = snap(); e.first_15m += 900;
    aborts(e, /first_15m/);
    assert.throws(() => prepare(null), /not an object/);
  });

  it('plot layouts must exist and match on id and type', () => {
    const a = snap(); delete a.plots_b_15m;
    aborts(a, /15m plot layout unverified/);
    const b = snap(); b.plots_b_15m[3].type = 'shape';
    aborts(b, /differs at plot 3/);
    const c = snap(); c.plots_b_15m.pop();
    aborts(c, /differs/);
    const e = snap(); e.plots_b_15m[3].color = '#fff'; e.plots_b_15m[3].title = 'other';
    assert.doesNotThrow(() => prepare(e));
  });

  it('row widths: B needs 16 plots, SR needs 5', () => {
    const a = snap(); a.rows.m1.b[3].pop(); reseal(a);
    aborts(a, /at least 16 needed/);
    const b = snap(); b.rows.m15.b[3].pop(); reseal(b);
    aborts(b, /at least 16 needed/);
    const c = snap(); c.rows.m1.sr[3].pop(); reseal(c);
    aborts(c, /at least 5 needed/);
    const e = snap(); e.rows.m1.b[3][4] = 'x'; reseal(e);
    aborts(e, /neither a number nor null/);
  });

  it('joins by time: missing, duplicate and extra study rows abort', () => {
    const a = snap(); a.rows.m1.sr.splice(10, 1); reseal(a);
    aborts(a, /no row at bar time/);
    const b = snap(); b.rows.m1.b[11] = [...b.rows.m1.b[10]]; reseal(b);
    aborts(b, /two rows/);
    const c = snap(); c.rows.m15.b.push([c.rows.m15.b.at(-1)[0] + 900, ...new Array(16).fill(0)]); reseal(c);
    aborts(c, /rows with no bar/);
  });

  it('a study row out of bar order still joins by time', () => {
    const a = snap(); a.rows.m1.sr.reverse(); reseal(a);
    assert.equal(simulate(a).runs[0].trades.length, 1);
  });

  it('bad bars', () => {
    const mut = (fn, re) => { const s = snap(); fn(s.rows.m1.bars); reseal(s); aborts(s, re); };
    mut((b) => { b[7][2] = 5000.1; }, /off the 0.25 grid/);
    mut((b) => { b[7][1] = null; }, /open is missing/);
    mut((b) => { b[7][3] = 5001; b[7][2] = 5000.5; }, /high < low/);
    mut((b) => { b[7][4] = 5001; }, /high < max/);
    mut((b) => { b[7][2] = 5000.5; b[7][3] = 5000.25; }, /low > min/);
    mut((b) => { b[7][0] += 0.5; }, /not an integer/);
    mut((b) => { b[7][0] += 30; }, /not a multiple of 60/);
    mut((b) => { [b[7], b[8]] = [b[8], b[7]]; }, /not after/);
    mut((b) => { b[8][0] = b[7][0]; }, /not after/);
    const s = snap(); s.rows.m15.bars[4][0] += 60; reseal(s);
    aborts(s, /not a multiple of 900/);
  });

  it('bars that had not closed at snapshot time', () => {
    const a = snap(); a.snapshot_time -= 1;
    aborts(a, /had not closed/);
  });

  it('roll window: the 5th to 20th of Mar, Jun, Sep or Dec (ET)', () => {
    aborts(build({ start: Date.UTC(2026, 11, 10, 10, 0) / 1000 }), /roll month/);
    aborts(build({ start: Date.UTC(2026, 8, 21, 10, 0) / 1000 }), /15m row .* roll month/); // only the 15m history reaches Sep 20
    assert.doesNotThrow(() => prepare(toSnapshot(build({ start: Date.UTC(2026, 8, 23, 10, 0) / 1000 }))));
  });

  it('a Buy and a short trigger on the same row, even before F', () => {
    const m = build();
    m.m1.buy[10] = 1; m.m1.cross[10] = 70; m.m1.bw[10] = 70;
    aborts(m, /both a Buy and a short trigger/);
    const ok = build();
    ok.m1.buy[10] = 1; ok.m1.cross[10] = 70; ok.m1.bw[10] = 59;
    assert.doesNotThrow(() => prepare(toSnapshot(ok)));
  });

  it('15m coverage: the latest closed bucket with a 1m row needs a 15m row', () => {
    const m = build();
    m.drop15.add(at(10, 45));
    aborts(m, /15m coverage/);
  });

  it('input comparison warns when inputs differ or are missing', () => {
    const a = snap(); a.inputs_b_15m = ['enc-2'];
    assert.match(prepare(a).info.warnings[0], /inputs differ/);
    const b = snap(); delete b.inputs_b_1m;
    assert.match(prepare(b).info.warnings[0], /not compared/);
  });
});

// ── Store and report ─────────────────────────────────────────────────────

describe('store and report', () => {
  it('reads a snapshot file and renders all three runs', () => {
    const dir = mkdtempSync(join(tmpdir(), 'mc_basic_1m-'));
    try {
      const { m, k } = canonicalLong();
      setBar(m, k + 3, 5000, 5010.25, 5000, 5010);
      const s = toSnapshot(m);
      const file = join(dir, 'snap.json');
      writeFileSync(file, JSON.stringify(s));
      const text = renderReport(simulate(readSnapshot(file)));
      assert.ok(text.startsWith('repaint unverified\n'));
      assert.match(text, /small, in-sample/i);
      assert.ok(text.includes(`snapshot ${s.sha256.slice(0, 8)}`));
      for (const id of RUN_IDS) assert.ok(text.includes(`== ${id}:`));
      assert.ok(text.includes('F = 1m row 300'));
      assert.ok(text.includes('Net $ 40.75'));
      assert.ok(!text.includes('ERROR'));

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{');
      assert.throws(() => readSnapshot(bad), (e) => e.code === 'E_SNAPSHOT_PARSE');
      assert.throws(() => readSnapshot(join(dir, 'none.json')), (e) => e.code === 'E_SNAPSHOT_READ');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('1R target mode (target E plus or minus D)', () => {
  const run1R = (m, runId = 'HTF-a') => {
    const res = simulate(toSnapshot(m), { target: '1R' });
    for (const r of res.runs) for (const s of [r.whole, r.first, r.second]) assert.ok(s.funnel.reconciles);
    return { res, r: res.runs.find((x) => x.runId === runId) };
  };

  it('long: T is E + D and needs no Resistance candidate', () => {
    const { m } = canonicalLong();
    m.m1.res.fill(null);
    const { res, r } = run1R(m);
    assert.equal(res.info.targetMode, '1R');
    const t = r.trades[0];
    assert.equal(t.eQ, Q(5001.25));
    assert.equal(t.dQ, Q(5.5));
    assert.equal(t.tQ, Q(5006.75));
    assert.equal(t.under1R, false);
    assert.equal(t.behind, false);
    assert.equal(r.whole.funnel.no_target, 0);
  });

  it('short: T is E - D', () => {
    const { m } = canonicalShort();
    m.m1.sup.fill(null);
    const t = run1R(m).r.trades[0];
    assert.equal(t.eQ, Q(4999.75));
    assert.equal(t.dQ, Q(4.5));
    assert.equal(t.tQ, Q(4995.25));
  });

  it('uses the clamped D: a 1-point raw stop floors to 2 points, so T is E + 2', () => {
    const { m } = longWith({ setupLow: 4999.5 });
    const t = run1R(m).r.trades[0];
    assert.equal(t.floor, true);
    assert.equal(t.dQ, Q(2));
    assert.equal(t.tQ, Q(5002.25));
  });

  it('a target fill at 1R nets 1R less fees', () => {
    const { m, k } = canonicalLong();
    setBar(m, k + 3, 5001, 5007, 5001, 5007);
    const t = run1R(m).r.trades[0];
    assert.equal(t.reason, 'target');
    assert.equal(t.exitQ, Q(5006.75));
    assert.equal(fmtDollarsNq(t.nq), '24.50');
    assert.equal(fmtR(rHundredths(t.nq, t.dQ)), '0.89');
  });

  it('the default stays the SR target, and an unknown mode throws', () => {
    const { m } = canonicalLong();
    const snap = toSnapshot(m);
    assert.equal(simulate(snap).runs[0].trades[0].tQ, Q(5010));
    assert.equal(simulate(snap).info.targetMode, 'sr');
    assert.deepEqual(simulate(snap, { target: 'sr' }).runs, simulate(snap).runs);
    assert.throws(() => simulate(snap, { target: '2R' }), /unknown target mode/);
    assert.throws(() => simulateRun(prepare(snap), 'HTF-a', { target: 'x' }), /unknown target mode/);
  });
});

describe('srsl mode (Cipher target, stop beyond the opposite Cipher level)', () => {
  const runS = (m, runId = 'HTF-a') => {
    const res = simulate(toSnapshot(m), { target: 'srsl' });
    for (const r of res.runs) for (const s of [r.whole, r.first, r.second]) assert.ok(s.funnel.reconciles);
    return { res, r: res.runs.find((x) => x.runId === runId) };
  };

  it('long: S is 1 tick under the Support level, D is E - S, T stays the Resistance target', () => {
    const { m } = canonicalLong();
    supCandidate(m, F0 + 12, 4997);
    const { res, r } = runS(m);
    assert.equal(res.info.targetMode, 'srsl');
    const t = r.trades[0];
    assert.equal(t.eQ, Q(5001.25));
    assert.equal(t.setupQ, Q(4997));
    assert.equal(t.sQ, Q(4996.75));
    assert.equal(t.dQ, Q(4.5));
    assert.equal(t.tQ, Q(5010));
    assert.equal(t.floor, false);
    assert.equal(t.cap, false);
  });

  it('short: S is 1 tick over the Resistance level, T stays the Support target', () => {
    const { m } = canonicalShort();
    resCandidate(m, F0 + 12, 5003);
    const t = runS(m).r.trades[0];
    assert.equal(t.eQ, Q(4999.75));
    assert.equal(t.sQ, Q(5003.25));
    assert.equal(t.dQ, Q(3.5));
    assert.equal(t.tQ, Q(4990));
  });

  it('takes the nearest level at least 2 points away and skips a closer one', () => {
    const { m } = canonicalLong();
    supCandidate(m, F0 + 12, 4997);
    supCandidate(m, F0 + 14, 4998);
    supCandidate(m, F0 + 16, 5000); // S 4999.75 is 1.5 points from E: too close
    const t = runS(m).r.trades[0];
    assert.equal(t.sQ, Q(4997.75));
    assert.equal(t.dQ, Q(3.5));
  });

  it('a stop exactly 2 points or exactly 8 points away is taken', () => {
    const near = canonicalLong();
    supCandidate(near.m, F0 + 12, 4999.5); // S 4999.25, D 2
    assert.equal(runS(near.m).r.trades[0].dQ, Q(2));
    const far = canonicalLong();
    supCandidate(far.m, F0 + 12, 4993.5); // S 4993.25, D 8
    assert.equal(runS(far.m).r.trades[0].dQ, Q(8));
  });

  it('short: a stop exactly 2 or 8 points away is taken; 1.75 or 8.25 points is no_stop', () => {
    const cases = [[5001.5, Q(2)], [5007.5, Q(8)], [5001.25, null], [5007.75, null]]; // E 4999.75, S = level + 0.25
    for (const [level, dQ] of cases) {
      const { m } = canonicalShort();
      resCandidate(m, F0 + 12, level);
      const r = runS(m).r;
      if (dQ === null) assert.equal(r.triggers[0].outcome, 'no_stop', String(level));
      else assert.equal(r.trades[0].dQ, dQ, String(level));
    }
  });

  it('short: a Resistance level under 2 points away is skipped for the next one', () => {
    const { m } = canonicalShort();
    resCandidate(m, F0 + 12, 5003);
    resCandidate(m, F0 + 14, 5001); // S 5001.25 is 1.5 points from E: too close
    const t = runS(m).r.trades[0];
    assert.equal(t.sQ, Q(5003.25));
  });

  it('no level, a level over 8 points away, or one confirmed after the decision row is no_stop', () => {
    const none = canonicalLong();
    assert.equal(runS(none.m).r.triggers[0].outcome, 'no_stop');
    const far = canonicalLong();
    supCandidate(far.m, F0 + 12, 4993.25); // S 4993, D 8.25
    const rf = runS(far.m).r;
    assert.equal(rf.triggers[0].outcome, 'no_stop');
    assert.equal(rf.whole.funnel.no_stop, 1);
    assert.equal(rf.trades.length, 0);
    const late = canonicalLong();
    supCandidate(late.m, late.k + 1, 4997);
    assert.equal(runS(late.m).r.triggers[0].outcome, 'no_stop');
  });

  it('no target is checked before no stop', () => {
    const { m } = canonicalLong();
    m.m1.res.fill(null);
    assert.equal(runS(m).r.triggers[0].outcome, 'no_target');
  });

  it('a stop exit fills 1 tick under the Cipher stop', () => {
    const { m, k } = canonicalLong();
    supCandidate(m, F0 + 12, 4997);
    setBar(m, k + 3, 5001, 5001, 4996, 4996);
    const t = runS(m).r.trades[0];
    assert.equal(t.reason, 'stop');
    assert.equal(t.exitQ, Q(4996.5));
    assert.equal(fmtDollarsNq(t.nq), '-26.75'); // 4.75 points x $5 = $23.75, plus $3 fees
  });

  it('sr and 1R never use no_stop', () => {
    const { m } = canonicalLong();
    const snap = toSnapshot(m);
    for (const target of ['sr', '1R']) {
      for (const r of simulate(snap, { target }).runs) assert.equal(r.whole.funnel.no_stop, 0, target);
    }
  });
});

describe('band mode (Cipher Resistance and Support on the trigger row)', () => {
  const runB = (m, runId = 'HTF-a') => {
    const res = simulate(toSnapshot(m), { target: 'band' });
    for (const r of res.runs) for (const s of [r.whole, r.first, r.second]) assert.ok(s.funnel.reconciles);
    return { res, r: res.runs.find((x) => x.runId === runId) };
  };
  const longBand = (res, sup) => {
    const c = canonicalLong();
    c.m.m1.res[c.k] = res; c.m.m1.sup[c.k] = sup;
    return c;
  };
  const shortBand = (res, sup) => {
    const c = canonicalShort();
    c.m.m1.res[c.k] = res; c.m.m1.sup[c.k] = sup;
    return c;
  };

  it('long: T is Resistance, S is 1 tick under Support, D is E - S', () => {
    const { m } = longBand(5010, 4997);
    const { res, r } = runB(m);
    assert.equal(res.info.targetMode, 'band');
    const t = r.trades[0];
    assert.equal(t.eQ, Q(5001.25));
    assert.equal(t.tQ, Q(5010));
    assert.equal(t.setupQ, Q(4997));
    assert.equal(t.sQ, Q(4996.75));
    assert.equal(t.dQ, Q(4.5));
    assert.equal(t.floor, false);
    assert.equal(t.cap, false);
  });

  it('short: T is Support, S is 1 tick over Resistance', () => {
    const { m } = shortBand(5003, 4990);
    const t = runB(m).r.trades[0];
    assert.equal(t.eQ, Q(4999.75));
    assert.equal(t.tQ, Q(4990));
    assert.equal(t.sQ, Q(5003.25));
    assert.equal(t.dQ, Q(3.5));
  });

  it('uses the levels on the trigger row, not those on the row before', () => {
    const { m, k } = longBand(5020, 4990);
    m.m1.res[k - 1] = 5010; m.m1.sup[k - 1] = 4995;
    const t = runB(m).r.trades[0];
    assert.equal(t.tQ, Q(5020));
    assert.equal(t.sQ, Q(4989.75));
  });

  it('does not clamp D: a 0.5-point stop and a 21.5-point stop are both taken as is', () => {
    const near = runB(longBand(5010, 5001).m).r.trades[0];
    assert.equal(near.dQ, Q(0.5));
    assert.equal(near.floor, false);
    const far = runB(longBand(5010, 4980).m).r.trades[0];
    assert.equal(far.dQ, Q(21.5));
    assert.equal(far.cap, false);
  });

  it('E on Support, on Resistance, outside the band, or a missing level is outside_band', () => {
    const cases = [
      ['long E = Support', longBand(5010, 5001.25)],
      ['long E = Resistance', longBand(5001.25, 4990)],
      ['long E above the band', longBand(5001, 4990)],
      ['long no Support', longBand(5010, null)],
      ['long no Resistance', longBand(null, 4990)],
      ['short E = Support', shortBand(5005, 4999.75)],
      ['short E = Resistance', shortBand(4999.75, 4990)],
      ['Resistance off the grid', longBand(5003.1, 4997)],
      ['Support off the grid', longBand(5010, 4997.1)],
      ['Resistance with float noise', longBand(5010.250000000001, 4997)],
      ['short Support off the grid', shortBand(5003, 4990.1)],
    ];
    for (const [name, { m }] of cases) {
      const r = runB(m).r;
      assert.equal(r.triggers[0].outcome, 'outside_band', name);
      assert.equal(r.whole.funnel.outside_band, 1, name);
      assert.equal(r.trades.length, 0, name);
    }
  });

  it('a stop exit fills 1 tick under the band stop', () => {
    const { m, k } = longBand(5010, 4997);
    setBar(m, k + 3, 5001, 5001, 4996, 4996);
    const t = runB(m).r.trades[0];
    assert.equal(t.reason, 'stop');
    assert.equal(t.exitQ, Q(4996.5));
    assert.equal(fmtDollarsNq(t.nq), '-26.75');
  });

  it('a target fill exits at Resistance', () => {
    const { m, k } = longBand(5004, 4997);
    setBar(m, k + 3, 5001, 5004.25, 5001, 5004);
    const t = runB(m).r.trades[0];
    assert.equal(t.reason, 'target');
    assert.equal(t.exitQ, Q(5004));
  });

  it('sr, 1R and srsl never use outside_band', () => {
    const { m } = longBand(5001.25, 4990);
    const snap = toSnapshot(m);
    for (const target of ['sr', '1R', 'srsl']) {
      for (const r of simulate(snap, { target }).runs) assert.equal(r.whole.funnel.outside_band, 0, target);
    }
  });
});

describe('next and next15 modes (Avg4 Mny Flow, past Cipher line target, 1.5R minimum)', () => {
  const runN = (m, target = 'next', runId = 'HTF-a') => {
    const res = simulate(toSnapshot(m), { target });
    for (const r of res.runs) for (const s of [r.whole, r.first, r.second]) assert.ok(s.funnel.reconciles);
    return { res, r: res.runs.find((x) => x.runId === runId) };
  };
  // Long: E 5001.25, lines 5000 (row F+9) and 5010 (row F+10). Band on row k sets S and adds k-row lines.
  const longN = (res, sup) => {
    const c = canonicalLong();
    c.m.m1.res[c.k] = res; c.m.m1.sup[c.k] = sup;
    return c;
  };
  // Short: E 4999.75, lines 5000 (row F+9) and 4990 (row F+10).
  const shortN = (res, sup) => {
    const c = canonicalShort();
    c.m.m1.res[c.k] = res; c.m.m1.sup[c.k] = sup;
    return c;
  };
  const setLastMf = (m, k, vals) => {
    const qi = q15(m, k);
    vals.forEach((v, j) => set15(m, m.m15.t[qi - vals.length + 1 + j], { mf: v }));
  };

  it('mfTrend is 1 or -1 only when the 4-bar average and the latest bar move the same way', () => {
    const t = (vals) => mfTrend({ mf15: vals }, vals.length - 1);
    assert.equal(t([5, 1, 2, 3, 6]), 1);
    assert.equal(t([10, 8, 6, 7, 5]), -1);
    assert.equal(t([-5, 0, 10, 9, 8]), 0);   // counter bar: average up, latest bar down
    assert.equal(t([12, 0, 2, 4, 6]), 0);    // counter bar: average down, latest bar up
    assert.equal(t([1, 2, 3, 4, 4]), 0);     // flat latest bar
    assert.equal(t([4, 9, 1, 2, 4]), 0);     // flat average
    assert.equal(t([null, 1, 2, 3, 6]), 0);  // the oldest value of the previous average is missing
    assert.equal(t([1, 2, 3, null, 6]), 0);
    assert.equal(t([1, 2, 3, 6]), 0);        // too few rows
    assert.equal(mfTrend({ mf15: [9, 5, 1, 2, 3, 6] }, 5), 1);  // uses only rows qi-4..qi
  });

  it('a one-bar rise against a falling 4-bar average is filtered in next mode but passes in band mode', () => {
    const { m, k } = longN(5010, 4997);
    setLastMf(m, k, [10, 10, 8, 6, 7]);
    assert.equal(runN(m).r.triggers[0].outcome, 'filtered');
    assert.equal(runN(m, 'band').r.triggers[0].outcome, 'trade');
  });

  it('a counter bar against a rising 4-bar average is filtered in next and next15 modes', () => {
    const { m, k } = longN(5010, 4997);
    setLastMf(m, k, [-5, 0, 10, 9, 8]);
    assert.equal(runN(m).r.triggers[0].outcome, 'filtered');
    assert.equal(runN(m, 'next15').r.triggers[0].outcome, 'filtered');
  });

  it('a rising 4-bar average with a rising latest bar trades in next mode', () => {
    const { m, k } = longN(5010, 4997);
    setLastMf(m, k, [5, 1, 2, 3, 6]);
    assert.equal(runN(m).r.triggers[0].outcome, 'trade');
  });

  it('a short needs a falling 4-bar average and a falling latest bar', () => {
    const pass = shortN(5003, 4990);
    setLastMf(pass.m, pass.k, [10, 8, 6, 7, 5]);
    const fail = shortN(5003, 4990);
    setLastMf(fail.m, fail.k, [10, 8, 6, 5, 6]);
    assert.equal(runN(pass.m).r.triggers[0].outcome, 'trade');
    assert.equal(runN(fail.m).r.triggers[0].outcome, 'filtered');
  });

  it('a null in the last 5 closed 15m Mny Flow values is filtered', () => {
    const { m, k } = longN(5010, 4997);
    setLastMf(m, k, [null, 300, 301, 302, 303]);
    assert.equal(runN(m).r.triggers[0].outcome, 'filtered');
  });

  it('long: T is the nearest past line beyond E, S is 1 tick under Support, D is not clamped', () => {
    const { m } = longN(5010, 4997);
    const t = runN(m).r.trades[0];
    assert.equal(t.eQ, Q(5001.25));
    assert.equal(t.tQ, Q(5010));
    assert.equal(t.sQ, Q(4996.75));
    assert.equal(t.dQ, Q(4.5));
    assert.equal(t.floor, false);
    assert.equal(t.cap, false);
  });

  it('an earlier line nearer than Resistance is the target; exactly 1.5R passes', () => {
    const { m } = longN(5010, 4997);
    m.m1.res[F0 + 5] = 5008;                   // reward 6.75 = 1.5 x 4.5
    for (const target of ['next', 'next15']) assert.equal(runN(m, target).r.trades[0].tQ, Q(5008), target);
  });

  it('the trigger row line counts; a line first plotted after the trigger row and an off-grid line do not', () => {
    const { m, k } = longN(5009, 4997);
    m.m1.res[k + 2] = 5003;
    m.m1.res[F0 + 5] = 5003.1;
    assert.equal(runN(m).r.trades[0].tQ, Q(5009));
  });

  it('next: a nearest line under 1.5R is under_rr; next15 skips it for the first line at 1.5R or more', () => {
    const { m } = longN(5010, 4996.75);       // risk 4.75, 1.5R 7.125
    m.m1.res[F0 + 5] = 5008;                   // reward 6.75
    const n = runN(m).r;
    assert.equal(n.triggers[0].outcome, 'under_rr');
    assert.equal(n.whole.funnel.under_rr, 1);
    assert.equal(n.trades.length, 0);
    assert.equal(runN(m, 'next15').r.trades[0].tQ, Q(5010));
  });

  it('next15: no line at 1.5R or more is under_rr', () => {
    const { m } = longN(5010, 4995);           // risk 6.5, 1.5R 9.75, best reward 8.75
    for (const target of ['next', 'next15']) {
      const r = runN(m, target).r;
      assert.equal(r.triggers[0].outcome, 'under_rr', target);
      assert.equal(r.whole.funnel.under_rr, 1, target);
    }
  });

  it('a near stop is not floored: a 0.5-point risk targets the nearest line', () => {
    const t = runN(longN(5010, 5001).m).r.trades[0];
    assert.equal(t.dQ, Q(0.5));
    assert.equal(t.floor, false);
    assert.equal(t.tQ, Q(5010));
  });

  it('E outside the trigger row band is outside_band before any line search', () => {
    for (const target of ['next', 'next15']) {
      const r = runN(longN(5001, 4990).m, target).r;
      assert.equal(r.triggers[0].outcome, 'outside_band', target);
      assert.equal(r.whole.funnel.under_rr, 0, target);
    }
  });

  it('short mirrors: nearest past Support below E, stop 1 tick over Resistance, 1.5R minimum', () => {
    const base = shortN(5003, 4990);           // risk 3.5, 1.5R 5.25
    const t = runN(base.m).r.trades[0];
    assert.equal(t.eQ, Q(4999.75));
    assert.equal(t.tQ, Q(4990));
    assert.equal(t.sQ, Q(5003.25));
    const exact = shortN(5003, 4990);
    exact.m.m1.sup[F0 + 5] = 4994.5;           // reward 5.25
    assert.equal(runN(exact.m).r.trades[0].tQ, Q(4994.5));
    const near = shortN(5003, 4990);
    near.m.m1.sup[F0 + 5] = 4995;              // reward 4.75
    assert.equal(runN(near.m).r.triggers[0].outcome, 'under_rr');
    assert.equal(runN(near.m, 'next15').r.trades[0].tQ, Q(4990));
  });

  it('sr, 1R, srsl and band never use under_rr', () => {
    const { m } = longN(5010, 4995);
    const snap = toSnapshot(m);
    for (const target of ['sr', '1R', 'srsl', 'band']) {
      for (const r of simulate(snap, { target }).runs) assert.equal(r.whole.funnel.under_rr, 0, target);
    }
  });
});
