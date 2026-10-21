/**
 * Tests for drawTradesFromCsv(): CSV export → TradingView position drawings.
 * Pure unit (mocked CDP and chart functions). Fixtures are synthetic.
 *
 * Run: node --test tests/trade_drawings.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drawTradesFromCsv } from '../src/core/drawing.js';
import { localToUnix } from '../src/core/trades.js';

const T = localToUnix;
const bar = (t) => Math.floor(t / 60) * 60;

// ── Fixtures ─────────────────────────────────────────────────────────────

const ORDER_HEADER = 'Symbol,Side,Type,Quantity,Limit price,Stop price,Fill price,Status,Commission,Placing time,Closing time,Order ID,Level ID,Leverage,Margin';
const BALANCE_HEADER = 'Time,Balance before,Balance after,Realized PnL (value),Realized PnL (currency),Action';
const closeAction = (sym, pv) =>
  `"Close long position for symbol ${sym} at price 5010.00 for 1 units. Position AVG Price was 5000.000000, currency: USD, rate: 1.000000, point value: ${pv}"`;

const ID = '2026-03-06T23_00_00';

// Newest first, as TradingView exports.
const MES_ORDERS = [
  // unbracketed entry + manual exit → parse skip
  'CME_MINI:MES1!,Sell,Market,1,,,5006.00,Filled,,2026-03-02 12:05:00,2026-03-02 12:05:00,3002,,,',
  'CME_MINI:MES1!,Buy,Market,1,,,5005.00,Filled,,2026-03-02 12:00:00,2026-03-02 12:00:00,3001,,20x,"500.00 USD"',
  // B: short, target fills
  'CME_MINI:MES1!,Buy,Limit,1,5000.25,,5000.25,Filled,,2026-03-02 11:00:30,2026-03-02 11:30:00,2003,,,',
  'CME_MINI:MES1!,Buy,Stop,1,,5015.25,,Cancelled,,2026-03-02 11:00:30,2026-03-02 11:30:00,2002,,,',
  'CME_MINI:MES1!,Sell,Market,1,,,5010.25,Filled,,2026-03-02 11:00:30,2026-03-02 11:00:30,2001,,20x,"500.00 USD"',
  // A: long, stop fills
  'CME_MINI:MES1!,Sell,Limit,2,5020.00,,,Cancelled,,2026-03-02 10:00:00,2026-03-02 10:20:00,1003,,,',
  'CME_MINI:MES1!,Sell,Stop,2,,4990.00,4990.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:20:00,1002,,,',
  'CME_MINI:MES1!,Buy,Market,2,,,5000.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:00:00,1001,,20x,"1,000.00 USD"',
];
const MNQ_ORDERS = [
  'CME_MINI:MNQ1!,Sell,Limit,1,18100.00,,18100.00,Filled,,2026-03-03 09:00:00,2026-03-03 09:10:00,4003,,,',
  'CME_MINI:MNQ1!,Sell,Stop,1,,17950.00,,Cancelled,,2026-03-03 09:00:00,2026-03-03 09:10:00,4002,,,',
  'CME_MINI:MNQ1!,Buy,Market,1,,,18000.00,Filled,,2026-03-03 09:00:00,2026-03-03 09:00:00,4001,,20x,"500.00 USD"',
];
const BALANCES = [
  `2026-03-01 09:00:00,100000,100000,0,USD,${closeAction('CME_MINI:MES1!', '5.000000')}`,
];

function writeExport(dir, { orders, balances, id = ID }) {
  writeFileSync(join(dir, `paper-trading-order-history-all-${id}.205Z_290d6.csv`), [ORDER_HEADER, ...orders].join('\n') + '\n');
  writeFileSync(join(dir, `paper-trading-balance-history-${id}.208Z_d5537.csv`), [BALANCE_HEADER, ...balances].join('\n') + '\n');
}

// ── Fake chart ───────────────────────────────────────────────────────────

/**
 * In-memory stand-in for the TradingView chart. Dispatches on the evaluate()
 * expression text and keeps a list of shapes with their points.
 */
function fakeChart({
  dir,
  symbol = 'CME_MINI:MES1!',
  resolution = '5',
  shapes = [],
  tick = { minmov: 25, pricescale: 100 },
  createThrows = () => false,
  snap = bar,
} = {}) {
  const state = { symbol, resolution, shapes: shapes.map(s => ({ ...s })), next: 1 };
  const calls = { evaluate: [], creates: [], removes: [], setSymbol: [], setTimeframe: [], setVisibleRange: [], setView: [], getChartApi: 0, getState: 0 };

  const evaluate = async (expr) => {
    calls.evaluate.push(expr);
    let m;
    if ((m = /createMultipointShape\((\[.*?\]), (\{.*\})\)/s.exec(expr))) {
      const points = JSON.parse(m[1]);
      const opts = JSON.parse(m[2]);
      calls.creates.push({ points, opts });
      if (createThrows(opts, calls.creates.length)) throw new Error('JS evaluation error: create failed');
      state.shapes.push({
        id: `pos${state.next++}`,
        name: opts.shape,
        points: [{ time: snap(points[0].time), price: points[0].price }, { time: snap(points[1].time), price: points[1].price }],
      });
      return undefined;
    }
    if ((m = /removeEntity\(("[^"]*")\)/.exec(expr))) {
      const id = JSON.parse(m[1]);
      calls.removes.push(id);
      state.shapes = state.shapes.filter(s => s.id !== id);
      return undefined;
    }
    if ((m = /setBarSpacing\(([^)]*)\);\s*ts\.setRightOffset\(([^)]*)\)/.exec(expr))) {
      calls.setView.push({ spacing: Number(m[1]), offset: Number(m[2]) });
      return undefined;
    }
    if (expr.includes('barSpacing()')) return { spacing: 4.5, offset: 120 };
    if (expr.includes('symbolInfo()')) return tick;
    if (expr.includes('getAllShapes') && expr.includes('long_position')) {
      return state.shapes
        .filter(s => s.name === 'long_position' || s.name === 'short_position')
        .map(s => ({ shape: s.name, time: s.points[0].time, price: s.points[0].price }));
    }
    if ((m = /getShapeById\(("[^"]*")\)/.exec(expr))) {
      const s = state.shapes.find(x => x.id === JSON.parse(m[1]));
      return s ? s.points : null;
    }
    if (expr.includes('getAllShapes')) return state.shapes.map(s => s.id);
    throw new Error(`unexpected evaluate: ${expr.slice(0, 80)}`);
  };

  const _deps = {
    dir,
    evaluate,
    getChartApi: async () => { calls.getChartApi++; return 'window.__api'; },
    getState: async () => { calls.getState++; return { success: true, symbol: state.symbol, resolution: state.resolution }; },
    setSymbol: async ({ symbol: s }) => { calls.setSymbol.push(s); state.symbol = s; return { success: true }; },
    setTimeframe: async ({ timeframe }) => { calls.setTimeframe.push(timeframe); state.resolution = timeframe; return { success: true }; },
    setVisibleRange: async ({ from, to }) => { calls.setVisibleRange.push({ from, to }); return { success: true }; },
    sleep: async () => {},
  };
  return { _deps, state, calls };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('drawTradesFromCsv()', () => {
  let root;
  let n = 0;
  const exportDir = (spec) => {
    const dir = join(root, String(n++));
    mkdirSync(dir);
    writeExport(dir, spec);
    return dir;
  };
  let mesDir, twoSymDir, noPvDir, repeatDir;

  before(() => {
    root = mkdtempSync(join(tmpdir(), 'tv-trade-drawings-'));
    mesDir = exportDir({ orders: MES_ORDERS, balances: BALANCES });
    twoSymDir = exportDir({ orders: [...MNQ_ORDERS, ...MES_ORDERS], balances: BALANCES });
    noPvDir = exportDir({ orders: MES_ORDERS, balances: [] });
    // The 1001 long bracket again under new order IDs: same side, bar and price.
    // Placed one second after 1001 so the two entries do not share a Placing time.
    const repeatCopy = [
      'CME_MINI:MES1!,Sell,Stop,2,,4990.00,4990.00,Filled,,2026-03-02 10:00:01,2026-03-02 10:20:00,1012,,,',
      'CME_MINI:MES1!,Sell,Limit,2,5020.00,,,Cancelled,,2026-03-02 10:00:01,2026-03-02 10:20:00,1013,,,',
      'CME_MINI:MES1!,Buy,Market,2,,,5000.00,Filled,,2026-03-02 10:00:01,2026-03-02 10:00:00,1011,,20x,"1,000.00 USD"',
    ];
    repeatDir = exportDir({ orders: [...repeatCopy, ...MES_ORDERS], balances: BALANCES });
  });
  after(() => rmSync(root, { recursive: true, force: true }));

  it('dry_run returns plans and makes no CDP or chart calls', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir });
    const r = await drawTradesFromCsv({ dry_run: true, _deps });
    assert.equal(r.success, true);
    assert.equal(r.dry_run, true);
    assert.equal(r.export, ID);
    assert.equal(r.fills, 2);
    assert.deepEqual(r.plans.map(p => [p.order_id, p.side, p.qty, p.entry_price, p.stop, p.target, p.entry_time, p.risk_amount]), [
      ['1001', 'long', 2, 5000, 4990, 5020, '2026-03-02 10:00:00', 100],
      ['2001', 'short', 1, 5010.25, 5015.25, 5000.25, '2026-03-02 11:00:30', 25],
    ]);
    assert.deepEqual(r.skipped, [{ order_id: '3001', reason: 'no bracket' }]);
    assert.equal(calls.evaluate.length, 0);
    assert.equal(calls.getChartApi, 0);
    assert.equal(calls.getState, 0);
    assert.deepEqual(calls.setSymbol, []);
    assert.deepEqual(calls.setTimeframe, []);
    assert.deepEqual(calls.setVisibleRange, []);
  });

  it('rejects a malformed export_timestamp before touching the chart', async () => {
    for (const bad of ['../x', '2026-03-06 23:00:00', '2026-03-06T23_00_00.205Z']) {
      const { _deps, calls } = fakeChart({ dir: mesDir });
      await assert.rejects(() => drawTradesFromCsv({ export_timestamp: bad, _deps }), /Invalid export timestamp/);
      assert.equal(calls.evaluate.length, 0);
      assert.equal(calls.getState, 0);
    }
  });

  it('draws each fill with stop/profit ticks and money risk overrides', async () => {
    const { _deps, calls, state } = fakeChart({ dir: mesDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.export, ID);
    assert.equal(r.fills, 2);
    assert.equal(r.fallback_sizing, false);
    assert.deepEqual(r.skipped, [{ order_id: '3001', reason: 'no bracket' }]);

    assert.equal(calls.creates.length, 2);
    const [a, b] = calls.creates;
    assert.equal(a.opts.shape, 'long_position');
    assert.deepEqual(a.opts.overrides, { stopLevel: 40, profitLevel: 80, riskDisplayMode: 'money', risk: 100, accountSize: 100000 });
    assert.deepEqual(a.points, [
      { time: T('2026-03-02 10:00:00'), price: 5000 },
      { time: T('2026-03-02 10:20:00'), price: 5000 },
    ]);
    assert.equal(b.opts.shape, 'short_position');
    assert.deepEqual(b.opts.overrides, { stopLevel: 20, profitLevel: 40, riskDisplayMode: 'money', risk: 25, accountSize: 100000 });

    assert.deepEqual(r.drawn, [
      { order_id: '1001', entity_id: 'pos1', side: 'long', qty: 2, entry_price: 5000, entry_time: '2026-03-02 10:00:00' },
      { order_id: '2001', entity_id: 'pos2', side: 'short', qty: 1, entry_price: 5010.25, entry_time: '2026-03-02 11:00:30' },
    ]);
    assert.equal(state.shapes.length, 2);
  });

  it('switches to 1 minute, loads the range, and restores symbol and timeframe', async () => {
    const { _deps, calls, state } = fakeChart({ dir: mesDir, resolution: '15' });
    const r = await drawTradesFromCsv({ _deps });
    assert.deepEqual(calls.setSymbol, [], 'already on the symbol: no switch');
    assert.deepEqual(calls.setTimeframe, ['1', '15']);
    assert.deepEqual(calls.setVisibleRange, [{ from: T('2026-03-02 10:00:00') - 3600, to: T('2026-03-02 11:30:00') + 3600 }]);
    assert.deepEqual(r.restored, { symbol: 'CME_MINI:MES1!', timeframe: '15' });
    assert.equal(state.resolution, '15');
    assert.deepEqual(calls.setView, [{ spacing: 4.5, offset: 120 }], 'view restored after the range moved');
  });

  it('restores the view even when drawing throws', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir, resolution: '1', createThrows: () => true });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /create failed/);
    assert.deepEqual(calls.setView, [{ spacing: 4.5, offset: 120 }]);
  });

  it('does not touch the timeframe when it is already 1 minute', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir, resolution: '1' });
    await drawTradesFromCsv({ _deps });
    assert.deepEqual(calls.setTimeframe, []);
  });

  it('switches symbol only when needed, once per symbol, then restores', async () => {
    const { _deps, calls, state } = fakeChart({ dir: twoSymDir, symbol: 'CME_MINI:MES1!' });
    const r = await drawTradesFromCsv({ _deps });
    // MES fills come first (earlier), chart is already on MES; then MNQ; then back.
    assert.deepEqual(calls.setSymbol, ['CME_MINI:MNQ1!', 'CME_MINI:MES1!']);
    assert.equal(state.symbol, 'CME_MINI:MES1!');
    assert.equal(calls.setVisibleRange.length, 2);
    assert.deepEqual(r.drawn.map(d => d.order_id), ['1001', '2001', '4001']);
  });

  it('skips fills already drawn at the same bar and price', async () => {
    const existing = [{
      id: 'old1', name: 'long_position',
      points: [{ time: bar(T('2026-03-02 10:00:00')), price: 5000 }, { time: T('2026-03-02 10:20:00'), price: 5000 }],
    }];
    const { _deps, calls } = fakeChart({ dir: mesDir, shapes: existing });
    const r = await drawTradesFromCsv({ _deps });
    assert.deepEqual(r.skipped, [
      { order_id: '3001', reason: 'no bracket' },
      { order_id: '1001', reason: 'already drawn' },
    ]);
    assert.deepEqual(r.drawn.map(d => d.order_id), ['2001']);
    assert.equal(calls.creates.length, 1);
  });

  it('two identical trades in one run: one draw and one skip', async () => {
    const { _deps, calls, state } = fakeChart({ dir: repeatDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(calls.creates.length, 2, 'one long and one short; the repeat is not drawn');
    assert.equal(r.drawn.filter(d => d.side === 'long').length, 1);
    assert.deepEqual(r.skipped.filter(s => s.reason === 'already drawn'), [{ order_id: '1011', reason: 'already drawn' }]);
    assert.equal(state.shapes.filter(s => s.name === 'long_position').length, 1);
  });

  it('a second run draws nothing new', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir });
    await drawTradesFromCsv({ _deps });
    const r2 = await drawTradesFromCsv({ _deps });
    assert.deepEqual(r2.drawn, []);
    assert.deepEqual(r2.skipped.map(s => s.reason), ['no bracket', 'already drawn', 'already drawn']);
    assert.equal(calls.creates.length, 2);
  });

  it('retries once with only stop/profit levels when full overrides throw', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir, createThrows: (opts) => 'risk' in opts.overrides });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.fallback_sizing, true);
    assert.equal(r.drawn.length, 2);
    assert.equal(calls.creates.length, 4);
    assert.deepEqual(calls.creates[1].opts.overrides, { stopLevel: 40, profitLevel: 80 });
    assert.deepEqual(calls.creates[3].opts.overrides, { stopLevel: 20, profitLevel: 40 });
  });

  it('omits risk and account size and flags fallback sizing when point value is unknown', async () => {
    const { _deps, calls } = fakeChart({ dir: noPvDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.fallback_sizing, true);
    assert.deepEqual(calls.creates[0].opts.overrides, { stopLevel: 40, profitLevel: 80 });
    assert.equal(r.drawn.length, 2);
  });

  it('removes a drawing whose entry did not land on the expected bar and price', async () => {
    // Fake snaps entries one bar late.
    const { _deps, calls, state } = fakeChart({ dir: mesDir, snap: (t) => bar(t) + 60 });
    const r = await drawTradesFromCsv({ _deps });
    assert.deepEqual(r.drawn, []);
    assert.deepEqual(r.skipped, [
      { order_id: '3001', reason: 'no bracket' },
      { order_id: '1001', reason: 'placement mismatch' },
      { order_id: '2001', reason: 'placement mismatch' },
    ]);
    assert.deepEqual(calls.removes, ['pos1', 'pos2']);
    assert.equal(state.shapes.length, 0);
  });

  it('restores symbol and timeframe even when drawing throws', async () => {
    const { _deps, calls, state } = fakeChart({ dir: twoSymDir, symbol: 'NYMEX:CL1!', resolution: 'D', createThrows: () => true });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /create failed/);
    assert.deepEqual(calls.setSymbol, ['CME_MINI:MES1!', 'NYMEX:CL1!']);
    assert.deepEqual(calls.setTimeframe, ['1', 'D']);
    assert.equal(state.symbol, 'NYMEX:CL1!');
    assert.equal(state.resolution, 'D');
  });

  it('throws on an unreadable tick size and still restores', async () => {
    const { _deps, calls, state } = fakeChart({ dir: mesDir, resolution: '60', tick: { minmov: 0, pricescale: 100 } });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /tick size/i);
    assert.equal(state.resolution, '60');
    assert.deepEqual(calls.setView, [], 'the range never moved, so the view is left alone');
  });

  it('sends every interpolated value through JSON encoding', async () => {
    const { _deps, calls } = fakeChart({ dir: mesDir });
    await drawTradesFromCsv({ _deps });
    const readbacks = calls.evaluate.filter(e => e.includes('getShapeById') && !e.includes('getAllShapes'));
    assert.ok(readbacks.length >= 2);
    for (const e of readbacks) assert.match(e, /getShapeById\("pos\d+"\)/);
  });
});
