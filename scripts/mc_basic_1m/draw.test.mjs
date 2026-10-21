/**
 * Tests for the draw command through its main(argv, deps) interface. The chart is the shared
 * in-memory fake from fake_chart.mjs, and the state folder is a temp folder, so no test reaches
 * TradingView or the real state folder.
 * Run: node --test scripts/mc_basic_1m/draw.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as store from './store.mjs';
import { FORMAT, sha256Rows, simulate } from './sim.mjs';
import { RUN_COLOURS, TEMPLATES, PLACEHOLDERS, CALLER_KEYS, prepareValues, fillTemplate, fillPlaceholders, buildLabel } from './templates.mjs';
import { main, tradeListSha, tradePlan, arithmeticOk } from './draw.mjs';
import { fakeChart, chartError } from './fake_chart.mjs';

const T0 = Date.UTC(2026, 9, 14, 9, 0, 0) / 1000;
const RUN = 'HTF-a';
const WRITE = 'draw_trade';

const layout = () => Array.from({ length: 16 }, (_, i) => ({ id: `plot_${i}`, type: 'line' }));

/**
 * Synthetic snapshot of rows 0..lastRow, built as in report_write.test.mjs: setups every 30 rows
 * from row 320, even setups win, odd setups lose. Every run's first trade is a drawable long.
 */
function snapshot(lastRow = 499) {
  const n = lastRow + 1;
  const t = Array.from({ length: n }, (_, i) => T0 + 60 * i);
  const fill = (v) => new Array(n).fill(v);
  const m1 = {
    o: fill(5000), h: fill(5000), l: fill(5000), c: fill(5000),
    bw: fill(0), mf: fill(0), buy: fill(0), cross: fill(null), sto: fill(0), res: fill(null), sup: fill(null),
  };
  const setBar = (i, o, h, l, c) => { m1.o[i] = o; m1.h[i] = h; m1.l[i] = l; m1.c[i] = c; };
  for (let s = 0; ; s += 1) {
    const d = 320 + 30 * s;
    if (d + 6 > lastRow) break;
    const win = s % 2 === 0;
    const k = d + 2;
    m1.buy[d] = 1;
    m1.bw[d] = -65;
    m1.bw[k] = m1.bw[k - 1] + 1;
    m1.mf[k] = m1.mf[k - 1] + 1;
    m1.sto[k] = m1.sto[k - 1] + 1;
    const j = d - 10;
    m1.h[j - 3] = 5010;
    m1.res[j - 1] = 5000;
    m1.res[j] = 5010;
    setBar(d + 1, 5000, 5000, 4996, 5000);
    setBar(k + 1, 5001, 5001, 5001, 5001);
    if (win) setBar(k + 4, 5005, 5012, 5005, 5010);
    else setBar(k + 4, 5001, 5001, 4990, 4992);
  }
  const tL = t[n - 1];
  const t15 = [];
  for (let b = t[0] - (t[0] % 900) - 100 * 900; b + 900 <= tL + 60; b += 900) t15.push(b);
  const bars = t.map((x, i) => [x, m1.o[i], m1.h[i], m1.l[i], m1.c[i], 100]);
  const b = t.map((x, i) => {
    const r = [x, ...new Array(16).fill(0)];
    r[2] = m1.bw[i]; r[4] = m1.mf[i]; r[6] = m1.buy[i]; r[8] = m1.cross[i]; r[16] = m1.sto[i];
    return r;
  });
  const sr = t.map((x, i) => [x, 0, 0, 0, m1.res[i], m1.sup[i]]);
  const bars15 = t15.map((x) => [x, 5000, 5000, 5000, 5000, 1000]);
  const b15 = t15.map((x) => {
    const r = [x, ...new Array(16).fill(0)];
    r[2] = x / 900; r[4] = x / 900; r[15] = x / 900;
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

const SNAP = snapshot();
const SIM = simulate(SNAP);
const TRADES = SIM.runs.find((r) => r.runId === RUN).trades;
const NOW_MS = (SNAP.snapshot_time + 60) * 1000;
const APPROVE = `${RUN}:${SNAP.sha256.slice(0, 8)}`;
const FIRST_DRAW = ['--expect-guard', 'missing+0', '--approve', APPROVE, '--broker-baseline', '5', '--ack-unverified', '--chart-empty-ok'];

let stateDir;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), 'mc_basic_1m_test-'));
  store.__testSetStateDir(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

/** A fresh state that holds the snapshot and a "last shown" report, the way a report leaves it, with no log.bak. */
function shownState() {
  store.writeSnapshot(SNAP, 'current');
  const log = { ...store.emptyLog(), last_shown: { snapshot_sha256: SNAP.sha256, runs: { [RUN]: tradeListSha(TRADES) } } };
  writeFileSync(join(stateDir, 'trade_log.json'), JSON.stringify(log));
}

const readJsonFile = (name) => JSON.parse(readFileSync(join(stateDir, name), 'utf8'));
const records = () => Object.values(readJsonFile('trade_log.json').records);
const flagFiles = () => readdirSync(stateDir).filter((f) => f.startsWith('broker_failed.'));
const digestOf = (lines) => {
  const line = [...lines].reverse().find((l) => l.startsWith('guard_digest = '));
  return line ? line.slice('guard_digest = '.length) : null;
};
const drawnReply = () => ({ id: 'P1', text: 'T1', linecolor: RUN_COLOURS[RUN] });

/** The chart replies for one draw: empty history on both tabs, an empty chart, and the given write reply. */
function chart(writeReply) {
  return fakeChart({
    now: NOW_MS,
    replies: {
      read_history: [[], [], null, [], null, null],
      read_shapes: [],
      [`${WRITE} tab1`]: writeReply,
    },
  });
}

describe('draw usage and refusals before the lock', () => {
  it('returns 2 with usage and no chart call when --expect-guard is missing', async () => {
    const deps = chart(drawnReply());
    assert.equal(await main([], deps), 2);
    assert.equal(deps.calls.length, 0);
    assert.ok(deps.stderr.some((l) => l.includes('usage: draw')));
  });

  it('returns 2 for a malformed digest', async () => {
    const deps = chart(drawnReply());
    assert.equal(await main(['--expect-guard', 'nothex', '--approve', APPROVE], deps), 2);
    assert.equal(deps.calls.length, 0);
  });

  it('returns 2 when --broker-failed comes with another flag', async () => {
    const deps = chart(drawnReply());
    assert.equal(await main(['--broker-failed', '--ack-unverified'], deps), 2);
    assert.equal(deps.calls.length, 0);
    assert.equal(flagFiles().length, 0);
  });

  it('--broker-failed creates one flag file, prints its digest and makes no chart call', async () => {
    const deps = chart(drawnReply());
    assert.equal(await main(['--broker-failed'], deps), 0);
    assert.equal(deps.calls.length, 0);
    assert.equal(flagFiles().length, 1);
    assert.ok(deps.stdout.includes('broker_check = failed'));
    assert.equal(digestOf(deps.stdout), 'missing+1');
  });

  it('refuses E_DIGEST on a fresh state when --expect-guard differs, with no chart call', async () => {
    shownState();
    const deps = chart(drawnReply());
    const argv = [...FIRST_DRAW];
    argv[1] = 'deadbeef+0';
    assert.equal(await main(argv, deps), 1);
    assert.equal(deps.calls.length, 0);
    assert.ok(deps.stderr.some((l) => l.startsWith('E_DIGEST:')));
    assert.equal(existsSync(join(stateDir, 'guard.json')), false);
  });

  it('refuses a first draw with no "last shown" report before any chart call', async () => {
    store.writeSnapshot(SNAP, 'current');
    const deps = chart(drawnReply());
    assert.equal(await main(FIRST_DRAW, deps), 1);
    assert.equal(deps.calls.length, 0);
    assert.ok(deps.stderr.some((l) => l.includes('no "last shown" report')));
  });
});

describe('draw on a fresh state', () => {
  it('draws the probe trade: two history reads, two shape reads, one write on tab1', async () => {
    shownState();
    const deps = chart(drawnReply());
    assert.equal(await main(FIRST_DRAW, deps), 0, deps.stderr.join('\n'));
    assert.deepEqual(
      deps.calls.map((c) => `${c.name} ${c.tab}`),
      ['read_history tab1', 'read_history tab2', 'read_shapes tab1', 'read_shapes tab1', `${WRITE} tab1`],
    );
    assert.deepEqual(deps.sleeps, [2000]);

    const args = deps.calls[4].args;
    const trade = TRADES[0];
    assert.equal(args.RUN_ID, RUN);
    assert.equal(args.UNVERIFIED, true);
    assert.equal(args.IS_LONG, true);
    assert.equal(args.P1_TIME, trade.entryTime);
    assert.equal(args.P1_PRICE, trade.eQ / 4);
    assert.equal(args.STOP_LEVEL, trade.dQ);
    assert.equal(args.PROFIT_LEVEL, trade.tQ - trade.eQ);
    assert.equal(args.DEADLINE, NOW_MS + 2000 + 30000);

    const recs = records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, 'drawn');
    assert.equal(recs[0].position_id, 'P1');
    assert.equal(recs[0].text_id, 'T1');
    assert.equal(recs[0].run, RUN);
    const guard = readJsonFile('guard.json');
    assert.equal(guard.broker_check, 'pending');
    assert.equal(guard.baseline_count, 5);
    assert.equal(guard.probe_key, recs[0].key);
    assert.match(digestOf(deps.stdout), /^[0-9a-f]{8}\+0$/);
  });

  it('refuses an unverified repaint status without --ack-unverified, before any shape read or write', async () => {
    shownState();
    const deps = chart(drawnReply());
    const argv = FIRST_DRAW.filter((a) => a !== '--ack-unverified');
    assert.equal(await main(argv, deps), 1);
    assert.deepEqual(deps.calls.map((c) => c.name), ['read_history', 'read_history']);
    assert.ok(deps.stderr.some((l) => l.includes('drawing needs --ack-unverified')));
    assert.equal(records().length, 0);
    assert.equal(existsSync(join(stateDir, 'guard.json')), false);
  });

  it('refuses an empty chart without --chart-empty-ok and never writes', async () => {
    shownState();
    const deps = chart(drawnReply());
    const argv = FIRST_DRAW.filter((a) => a !== '--chart-empty-ok');
    assert.equal(await main(argv, deps), 1);
    assert.equal(deps.calls.some((c) => c.name === WRITE), false);
    assert.ok(deps.stderr.some((l) => l.includes('loading test failed')));
  });

  it('refuses when the two shape reads differ', async () => {
    shownState();
    const deps = fakeChart({
      now: NOW_MS,
      replies: {
        read_history: [[], [], null, [], null, null],
        read_shapes: (args, tab, n) => (n === 0 ? [] : [{ id: 'X1', name: 'horizontal_line' }]),
        [`${WRITE} tab1`]: drawnReply(),
      },
    });
    assert.equal(await main(FIRST_DRAW, deps), 1);
    assert.equal(deps.calls.some((c) => c.name === WRITE), false);
    assert.ok(deps.stderr.some((l) => l.includes('two reads differ')));
  });

  it('keeps the record pending on an E_GUARD reply and stores the returned IDs', async () => {
    shownState();
    const deps = chart(['E_GUARD', 'T9', 'P9']);
    assert.equal(await main(FIRST_DRAW, deps), 1);
    assert.ok(deps.stderr.some((l) => l.startsWith('E_GUARD:')));
    const recs = records();
    assert.equal(recs.length, 1);
    assert.equal(recs[0].state, 'pending');
    assert.equal(recs[0].text_id, 'T9');
    assert.equal(recs[0].position_id, 'P9');
  });

  it('marks the record drawn with a mismatch when the position comes back in another colour', async () => {
    shownState();
    const deps = chart({ id: 'P1', text: 'T1', linecolor: '#000000' });
    assert.equal(await main(FIRST_DRAW, deps), 1);
    assert.ok(deps.stderr.some((l) => l.startsWith('E_SHAPE_MISMATCH:')));
    const recs = records();
    assert.equal(recs[0].state, 'drawn');
    assert.equal(recs[0].mismatch, true);
  });

  it('after a lost connection the record stays pending and the next draw refuses with no chart call', async () => {
    shownState();
    const first = chart(chartError('E_CDP_LOST', 'connection closed'));
    assert.equal(await main(FIRST_DRAW, first), 1);
    assert.equal(records()[0].state, 'pending');
    const digest = digestOf(first.stdout);
    assert.match(digest, /^[0-9a-f]{8}\+0$/);

    const second = chart(drawnReply());
    assert.equal(await main(['--expect-guard', digest, '--approve', APPROVE, '--ack-unverified', '--chart-empty-ok'], second), 1);
    assert.equal(second.calls.length, 0);
    assert.ok(second.stderr.some((l) => l.includes('is pending; resolve settles it first')));
  });
});

/* ---------- placeholder fills (design line 127; api_v1 PLACEHOLDERS, prepareValues and fillTemplate) ---------- */

const TAB1_CTX = { guardPath: '/chart/HCCCDVCt/', expectedRes: '1' };
const TAB2_CTX = { guardPath: '/chart/FAKETAB2/', expectedRes: '15' };
// Placeholder names and caller keys: none may be left in a filled text as a bare word.
const ALL_PLACEHOLDERS = [...new Set([...Object.values(PLACEHOLDERS).flat(), ...Object.values(CALLER_KEYS).flat()])];
const tokensOf = (text) => [...new Set([...text.matchAll(/@@([A-Z_]+)@@/g)].map((m) => m[1]))].sort();
const stripStrings = (text) => text.replace(/"(?:[^"\\]|\\.)*"/g, '""');

/** The draw_trade args, key for key as draw.mjs builds them from a trade plan. */
const drawArgs = (runId, unverified, plan, deadline) => ({
  RUN_ID: runId,
  UNVERIFIED: unverified,
  DEADLINE: deadline,
  IS_LONG: plan.long,
  P1_TIME: plan.p1.time,
  P1_PRICE: plan.p1.price,
  P2_TIME: plan.p2.time,
  P2_PRICE: plan.p2.price,
  TEXT_TIME: plan.textTime,
  TEXT_PRICE: plan.textPrice,
  STOP_LEVEL: plan.stopLevel,
  PROFIT_LEVEL: plan.profitLevel,
});

/** No @@ left, no placeholder name left as a bare word outside a string, and equal to a split-and-join fill of the template. */
function assertFilled(name, expression, values) {
  assert.equal(typeof expression, 'string', `${name} has no filled expression`);
  assert.equal(expression.includes('@@'), false, `${name} still contains @@`);
  const code = stripStrings(expression);
  for (const k of ALL_PLACEHOLDERS) {
    assert.equal(new RegExp(`\\b${k}\\b`).test(code), false, `${name}: ${k} is a bare name, not a placeholder`);
  }
  let expected = TEMPLATES[name];
  for (const k of PLACEHOLDERS[name]) expected = expected.split(`@@${k}@@`).join(JSON.stringify(values[k]));
  assert.equal(expression, expected, `${name} is not the template with every placeholder filled`);
}

/** The two shapes and the deadline carry the caller's values, the built label and the run colour. */
function assertDrawValues(expression, a) {
  const label = JSON.stringify(buildLabel(a.RUN_ID, a.UNVERIFIED));
  const colour = JSON.stringify(RUN_COLOURS[a.RUN_ID]);
  assert.ok(expression.includes(`chart.createShape({ time: ${a.TEXT_TIME}, price: ${a.TEXT_PRICE} }, { shape: "text", text: ${label} })`), 'text shape values');
  assert.ok(expression.includes(
    `chart.createMultipointShape([{ time: ${a.P1_TIME}, price: ${a.P1_PRICE} }, { time: ${a.P2_TIME}, price: ${a.P2_PRICE} }], `
    + `{ shape: ${a.IS_LONG} ? "long_position" : "short_position", overrides: { stopLevel: ${a.STOP_LEVEL}, profitLevel: ${a.PROFIT_LEVEL}, linecolor: ${colour} } })`,
  ), 'position shape values');
  assert.ok(expression.includes(`Date.now() < ${a.DEADLINE}`), 'deadline value');
}

describe('template placeholders are filled', () => {
  it('each placeholder list equals the set of @@NAME@@ tokens in its template', () => {
    for (const name of Object.keys(TEMPLATES)) {
      assert.deepEqual(tokensOf(TEMPLATES[name]), [...PLACEHOLDERS[name]].sort(), `${name} placeholder list and tokens differ`);
    }
  });

  it('main sends fully filled read and draw_trade text to the fake chart', async () => {
    shownState();
    const deps = chart(drawnReply());
    assert.equal(await main(FIRST_DRAW, deps), 0, deps.stderr.join('\n'));
    assert.equal(deps.calls.length, 5);
    for (const c of deps.calls) {
      const values = prepareValues(c.name, c.args, c.tab === 'tab2' ? TAB2_CTX : TAB1_CTX);
      assertFilled(c.name, c.expression, values);
    }
    const draw = deps.calls.find((c) => c.name === WRITE);
    assertDrawValues(draw.expression, draw.args);
    const tab2 = deps.calls.find((c) => c.tab === 'tab2');
    assert.ok(tab2.expression.includes('startsWith("/chart/FAKETAB2/")') && tab2.expression.includes('chart.resolution() !== "15"'));
  });

  it('every draw_trade argument shape draw.mjs builds fills the template', () => {
    const long = TRADES[0];
    const short = { ...long, side: 'short', sQ: long.eQ + long.dQ, tQ: long.eQ - (long.tQ - long.eQ), exitTime: null };
    const labels = new Set();
    let shapes = 0;
    for (const trade of [long, short]) {
      const plan = tradePlan(trade, SIM.info);
      assert.ok(plan.drawable && arithmeticOk(trade, plan), `${trade.side} trade is not drawable`);
      for (const runId of Object.keys(RUN_COLOURS)) {
        for (const unverified of [true, false]) {
          const args = drawArgs(runId, unverified, plan, NOW_MS + 32000);
          assert.deepEqual(Object.keys(args).sort(), [...CALLER_KEYS[WRITE]].sort());
          const values = prepareValues(WRITE, args, TAB1_CTX);
          const expression = fillPlaceholders(WRITE, TEMPLATES[WRITE], values);
          assertFilled(WRITE, expression, values);
          assertDrawValues(expression, args);
          labels.add(values.TEXT);
          shapes += 1;
        }
      }
    }
    assert.equal(shapes, 12);
    assert.equal(labels.size, 6);
  });

  it('every read template fills on tab 1, tab 2 and a discovery path', () => {
    const cases = [
      ['identity', TAB1_CTX], ['identity', TAB2_CTX], ['read_history', TAB1_CTX], ['read_history', TAB2_CTX],
      ['read_shapes', TAB1_CTX], ['read_shapes', TAB2_CTX], ['discover', { guardPath: '/chart/Cand1/', expectedRes: '15' }],
    ];
    for (const [name, ctx] of cases) {
      const values = prepareValues(name, {}, ctx);
      const expression = fillPlaceholders(name, TEMPLATES[name], values);
      assertFilled(name, expression, values);
      assert.ok(expression.includes(`startsWith(${JSON.stringify(ctx.guardPath)})`), `${name} guard path`);
    }
  });

  it('fillTemplate refuses a listed name the text lacks and value keys that differ from the list', () => {
    assert.equal(fillTemplate('f(@@A@@, @@A@@)', ['A'], { A: 'x' }), 'f("x", "x")');
    assert.throws(() => fillTemplate('f(@@A@@)', ['A', 'B'], { A: 1, B: 2 }), { code: 'E_ARGS' });
    assert.throws(() => fillTemplate('f(@@A@@)', ['A'], { A: 1, B: 2 }), { code: 'E_ARGS' });
    assert.throws(() => fillTemplate('f(@@A@@)', ['A'], {}), { code: 'E_ARGS' });
    assert.throws(() => fillTemplate('f(@@C@@)', ['A'], { A: 1 }), { code: 'E_ARGS' });
  });
});
