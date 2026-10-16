/**
 * Tests for forward.mjs (forwardSimulate). Synthetic snapshots only; no CDP, no files.
 * Run: node --test scripts/mc_basic_1m/forward.test.mjs
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { FORMAT, sha256Rows, simulate } from './sim.mjs';
import { forwardSimulate, FORWARD_MIN_NEW_1M } from './forward.mjs';

// Row 0 of the plain world opens 05:00 ET on Wed 2026-10-14 (09:00 UTC). Times are whole minutes.
const T0 = Date.UTC(2026, 9, 14, 9, 0, 0) / 1000;
const ORIG_LAST = 499;   // original snapshot: rows 0..499
const FWD_LAST = 1499;   // forward snapshot: rows 0..1499, that is 1000 new 1m bars

const layout = () => Array.from({ length: 16 }, (_, i) => ({ id: `plot_${i}`, type: 'line' }));

/**
 * Snapshot covering rows startRow..lastRow (row k opens at T0 + 60 k). Setups repeat every 30 rows
 * from row 320 while the setup fits before lastRow; they are fixed by row number, so two worlds
 * built with different startRow agree on every row they share. Even setups win (target at 5010),
 * odd setups lose (stop). 15m plots are the bucket time over 900, so they rise with time.
 */
function snapshot({ startRow = 0, lastRow }) {
  const n = lastRow - startRow + 1;
  const t = Array.from({ length: n }, (_, i) => T0 + 60 * (startRow + i));
  const fill = (v) => new Array(n).fill(v);
  const m1 = {
    o: fill(5000), h: fill(5000), l: fill(5000), c: fill(5000),
    bw: fill(0), mf: fill(0), buy: fill(0), cross: fill(null), sto: fill(0), res: fill(null), sup: fill(null),
  };
  const setBar = (i, o, h, l, c) => { m1.o[i] = o; m1.h[i] = h; m1.l[i] = l; m1.c[i] = c; };

  for (let s = 0; ; s += 1) {
    const d = 320 + 30 * s;
    if (d + 6 > lastRow) break;
    // A setup that ends after ORIG_LAST must not write its candidate bar (d - 13) inside the original range.
    if (d + 6 > ORIG_LAST && d - 13 <= ORIG_LAST) continue;
    const win = s % 2 === 0;
    const D = d - startRow;   // trigger index in this world
    const K = D + 2;          // confirm index
    m1.buy[D] = 1;
    m1.bw[D] = -65;
    m1.bw[K] = m1.bw[K - 1] + 1;
    m1.mf[K] = m1.mf[K - 1] + 1;
    m1.sto[K] = m1.sto[K - 1] + 1;
    // Target candidate at j = D - 10: Resistance steps to 5010 and high[j - 3] = 5010.
    const j = D - 10;
    m1.h[j - 3] = 5010;
    m1.res[j - 1] = 5000;
    m1.res[j] = 5010;
    setBar(D + 1, 5000, 5000, 4996, 5000);          // setup low 4996, so D = 5.5 after the quarter grid
    setBar(K + 1, 5001, 5001, 5001, 5001);          // entry bar
    if (win) setBar(K + 4, 5005, 5012, 5005, 5010); // target hit
    else setBar(K + 4, 5001, 5001, 4990, 4992);     // stop hit
  }

  const tL = t[n - 1];
  const t15 = [];
  const first15 = t[0] - (t[0] % 900);
  for (let b = first15 - 100 * 900; b + 900 <= tL + 60; b += 900) t15.push(b);

  const bars = t.map((x, i) => [x, m1.o[i], m1.h[i], m1.l[i], m1.c[i], 100]);
  const b = t.map((x, i) => {
    const r = [x, ...new Array(16).fill(0)];
    r[2] = m1.bw[i]; r[4] = m1.mf[i]; r[6] = m1.buy[i]; r[8] = m1.cross[i]; r[16] = m1.sto[i];
    return r;
  });
  const sr = t.map((x, i) => [x, 0, 0, 0, m1.res[i], m1.sup[i]]);
  const bars15 = t15.map((S) => [S, 5000, 5000, 5000, 5000, 1000]);
  const b15 = t15.map((S) => {
    const r = [S, ...new Array(16).fill(0)];
    r[2] = S / 900; r[4] = S / 900; r[15] = S / 900;
    return r;
  });
  const rows = { m1: { bars, b, sr }, m15: { bars: bars15, b: b15 } };
  return {
    format: FORMAT,
    snapshot_time: tL + 60,
    symbol: 'CME_MINI:MES1!',
    first_1m: t[0], last_1m: tL, count_1m: n,
    first_15m: t15[0], last_15m: t15[t15.length - 1], count_15m: t15.length,
    plots_b_1m: layout(),
    plots_b_15m: layout(),
    inputs_b_1m: ['enc-1'],
    inputs_b_15m: ['enc-1'],
    sha256: sha256Rows(rows),
    rows,
  };
}

/** Recompute sha256 after a test edits rows, so the test reaches the check it targets. */
const reseal = (snap) => { snap.sha256 = sha256Rows(snap.rows); return snap; };

const origLastTime = T0 + 60 * ORIG_LAST;
const refused = (fn, code, re) => assert.throws(fn, (e) => e.code === code && re.test(e.message));

describe('forwardSimulate: identical world', () => {
  it('reports only triggers after the original last bar, with a reconciling funnel', () => {
    const orig = snapshot({ lastRow: ORIG_LAST });
    const fwd = snapshot({ lastRow: FWD_LAST });
    const res = forwardSimulate(orig, fwd);
    const base = simulate(orig);
    const full = simulate(fwd);

    assert.equal(res.forward.newBars1m, 1000);
    assert.equal(res.repaint, 'unverified');
    assert.equal(res.original.last1, origLastTime);
    assert.equal(res.runs.length, 3);
    for (let i = 0; i < 3; i += 1) {
      const run = res.runs[i];
      const excluded = base.runs[i].whole.funnel.triggers;
      assert.equal(run.runId, base.runs[i].runId);
      assert.equal(run.excluded, excluded, `${run.runId}: excluded count`);
      assert.equal(run.stats.funnel.triggers, full.runs[i].whole.funnel.triggers - excluded, `${run.runId}: included triggers`);
      assert.ok(run.stats.funnel.reconciles, `${run.runId}: funnel must reconcile`);
      assert.ok(run.trades.length > 0, `${run.runId}: expected trades after the original last bar`);
      for (const tr of run.trades) assert.ok(tr.triggerTime > origLastTime, `${run.runId}: trade triggered before the last bar`);
    }
  });

  it('matches every original trigger in the forward run with no differences', () => {
    const res = forwardSimulate(snapshot({ lastRow: ORIG_LAST }), snapshot({ lastRow: FWD_LAST }));
    const base = simulate(snapshot({ lastRow: ORIG_LAST }));
    for (let i = 0; i < 3; i += 1) {
      const c = res.runs[i].comparison;
      assert.equal(c.compared, base.runs[i].whole.funnel.triggers, `${res.runs[i].runId}: compared`);
      assert.equal(c.same, c.compared, `${res.runs[i].runId}: same`);
      assert.deepEqual(c.differences, [], `${res.runs[i].runId}: differences`);
    }
  });
});

describe('forwardSimulate: new-bar threshold', () => {
  it('uses the 1000-bar threshold from design line 106', () => {
    assert.equal(FORWARD_MIN_NEW_1M, 1000);
  });

  it('refuses 999 new closed 1m bars and accepts 1000', () => {
    const orig = snapshot({ lastRow: ORIG_LAST });
    refused(() => forwardSimulate(orig, snapshot({ lastRow: 1498 })), 'E_FORWARD_SHORT', /999 closed 1m bars/);
    assert.equal(forwardSimulate(orig, snapshot({ lastRow: 1499 })).forward.newBars1m, 1000);
  });
});

describe('forwardSimulate: overlap must match the original', () => {
  const orig = () => snapshot({ lastRow: ORIG_LAST });

  it('refuses a changed value inside the original range', () => {
    const fwd = reseal(snapshot({ lastRow: FWD_LAST }));
    fwd.rows.m1.bars[100][4] = 4999;
    refused(() => forwardSimulate(orig(), reseal(fwd)), 'E_FORWARD_MISMATCH', /1m bars/);
  });

  it('refuses a missing row inside the original range', () => {
    const fwd = snapshot({ lastRow: FWD_LAST });
    fwd.rows.m1.b.splice(200, 1);
    refused(() => forwardSimulate(orig(), reseal(fwd)), 'E_FORWARD_MISMATCH', /1m B rows/);
  });

  it('refuses a duplicate row inside the original range', () => {
    const fwd = snapshot({ lastRow: FWD_LAST });
    fwd.rows.m1.sr.splice(200, 0, fwd.rows.m1.sr[199]);
    refused(() => forwardSimulate(orig(), reseal(fwd)), 'E_FORWARD_MISMATCH', /1m SR rows/);
  });

  it('refuses a forward whose sr_period_s differs from the original', () => {
    for (const [o, f] of [[300, 60], [300, undefined], [undefined, 300], [300, 900]]) {
      const a = orig();
      const fwd = snapshot({ lastRow: FWD_LAST });
      if (o !== undefined) a.sr_period_s = o;
      if (f !== undefined) fwd.sr_period_s = f;
      refused(() => forwardSimulate(a, fwd), 'E_FORWARD_MISMATCH', /sr_period_s differs/);
    }
  });

  it('accepts matching sr_period_s, including 60 against an absent field', () => {
    for (const [o, f] of [[300, 300], [60, undefined]]) {
      const a = orig();
      const fwd = snapshot({ lastRow: FWD_LAST });
      a.sr_period_s = o;
      if (f !== undefined) fwd.sr_period_s = f;
      assert.equal(forwardSimulate(a, fwd).runs.length, 3);
    }
  });

  it('refuses a forward snapshot with no rows.m15', () => {
    const fwd = snapshot({ lastRow: FWD_LAST });
    delete fwd.rows.m15;
    refused(() => forwardSimulate(orig(), fwd), 'E_FORWARD_MISMATCH', /rows\.m1 and rows\.m15/);
  });

  it('refuses a forward sha256 that does not match its rows', () => {
    const fwd = snapshot({ lastRow: FWD_LAST });
    fwd.sha256 = '0'.repeat(64);
    refused(() => forwardSimulate(orig(), fwd), 'E_FORWARD_MISMATCH', /sha256 does not match/);
  });

  it('refuses a forward that starts after the original first row', () => {
    const fwd = snapshot({ startRow: 20, lastRow: FWD_LAST });
    refused(() => forwardSimulate(orig(), reseal(fwd)), 'E_FORWARD_MISMATCH', /1m bars/);
  });

  it('drops extra rows before the original first row and gives the same report', () => {
    const plain = forwardSimulate(orig(), snapshot({ lastRow: FWD_LAST }));
    const prefixed = forwardSimulate(orig(), snapshot({ startRow: -20, lastRow: FWD_LAST }));
    assert.equal(prefixed.forward.newBars1m, 1000);
    assert.deepEqual(prefixed.runs, plain.runs);
  });

  it('passes the sim.mjs abort through for a bad original snapshot', () => {
    const bad = orig();
    bad.sha256 = '0'.repeat(64);
    refused(() => forwardSimulate(bad, snapshot({ lastRow: FWD_LAST })), 'E_SNAPSHOT_ABORT', /sha256 mismatch/);
  });
});
