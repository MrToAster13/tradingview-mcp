/**
 * Tests for drawTradesFromCsv(): CSV export → TradingView position drawings.
 * Runs against the in-memory chart positions adapter. Fixtures are synthetic.
 *
 * Run: node --test tests/trade_drawings.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { drawTradesFromCsv } from '../src/core/paper_trades.js';
import { createMemoryChartPositions } from './helpers/memory_chart_positions.js';
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

// ── Chart ────────────────────────────────────────────────────────────────

function memChart({ dir, ...opts } = {}) {
  const m = createMemoryChartPositions(opts);
  return { ...m, _deps: { dir, chart: m.chart } };
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

  it('dry_run returns plans and makes no chart calls', async () => {
    const { _deps, chartCalls } = memChart({ dir: mesDir });
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
    assert.equal(chartCalls(), 0);
  });

  it('rejects a malformed export_timestamp before touching the chart', async () => {
    for (const bad of ['../x', '2026-03-06 23:00:00', '2026-03-06T23_00_00.205Z']) {
      const { _deps, chartCalls } = memChart({ dir: mesDir });
      await assert.rejects(() => drawTradesFromCsv({ export_timestamp: bad, _deps }), /Invalid export timestamp/);
      assert.equal(chartCalls(), 0);
    }
  });

  it('draws each fill with stop/profit ticks and money risk overrides', async () => {
    const { _deps, calls, state } = memChart({ dir: mesDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.success, true);
    assert.equal(r.export, ID);
    assert.equal(r.fills, 2);
    assert.equal(r.fallback_sizing, false);
    assert.deepEqual(r.skipped, [{ order_id: '3001', reason: 'no bracket' }]);

    assert.equal(calls.creates.length, 2);
    const [a, b] = calls.creates;
    assert.equal(a.shape, 'long_position');
    assert.deepEqual(a.overrides, { stopLevel: 40, profitLevel: 80, riskDisplayMode: 'money', risk: 100, accountSize: 100000 });
    assert.deepEqual([a.entry_time, a.end_time, a.entry_price], [T('2026-03-02 10:00:00'), T('2026-03-02 10:20:00'), 5000]);
    assert.equal(b.shape, 'short_position');
    assert.deepEqual(b.overrides, { stopLevel: 20, profitLevel: 40, riskDisplayMode: 'money', risk: 25, accountSize: 100000 });

    assert.deepEqual(r.drawn, [
      { order_id: '1001', entity_id: 'pos1', side: 'long', qty: 2, entry_price: 5000, entry_time: '2026-03-02 10:00:00' },
      { order_id: '2001', entity_id: 'pos2', side: 'short', qty: 1, entry_price: 5010.25, entry_time: '2026-03-02 11:00:30' },
    ]);
    assert.equal(state.shapes.length, 2);
  });

  it('switches to 1 minute, loads the range, and restores symbol and timeframe', async () => {
    const { _deps, calls, state } = memChart({ dir: mesDir, timeframe: '15' });
    const r = await drawTradesFromCsv({ _deps });
    assert.deepEqual(calls.setSymbol, [], 'already on the symbol: no switch');
    assert.deepEqual(calls.setTimeframe, ['1', '15']);
    assert.deepEqual(calls.setVisibleRange, [{ from: T('2026-03-02 10:00:00') - 3600, to: T('2026-03-02 11:30:00') + 3600 }]);
    assert.deepEqual(r.restored, { symbol: 'CME_MINI:MES1!', timeframe: '15' });
    assert.equal(state.timeframe, '15');
    assert.deepEqual(calls.setView, [{ spacing: 4.5, offset: 120 }], 'view restored after the range moved');
  });

  it('restores the view even when drawing throws', async () => {
    const { _deps, calls } = memChart({ dir: mesDir, timeframe: '1', createThrows: () => true });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /create failed/);
    assert.deepEqual(calls.setView, [{ spacing: 4.5, offset: 120 }]);
  });

  it('does not touch the timeframe when it is already 1 minute', async () => {
    const { _deps, calls } = memChart({ dir: mesDir, timeframe: '1' });
    await drawTradesFromCsv({ _deps });
    assert.deepEqual(calls.setTimeframe, []);
  });

  it('switches symbol only when needed, once per symbol, then restores', async () => {
    const { _deps, calls, state } = memChart({ dir: twoSymDir, symbol: 'CME_MINI:MES1!' });
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
    const { _deps, calls } = memChart({ dir: mesDir, shapes: existing });
    const r = await drawTradesFromCsv({ _deps });
    assert.deepEqual(r.skipped, [
      { order_id: '3001', reason: 'no bracket' },
      { order_id: '1001', reason: 'already drawn' },
    ]);
    assert.deepEqual(r.drawn.map(d => d.order_id), ['2001']);
    assert.equal(calls.creates.length, 1);
  });

  it('two identical trades in one run: one draw and one skip', async () => {
    const { _deps, calls, state } = memChart({ dir: repeatDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(calls.creates.length, 2, 'one long and one short; the repeat is not drawn');
    assert.equal(r.drawn.filter(d => d.side === 'long').length, 1);
    assert.deepEqual(r.skipped.filter(s => s.reason === 'already drawn'), [{ order_id: '1011', reason: 'already drawn' }]);
    assert.equal(state.shapes.filter(s => s.name === 'long_position').length, 1);
  });

  it('a second run draws nothing new', async () => {
    const { _deps, calls } = memChart({ dir: mesDir });
    await drawTradesFromCsv({ _deps });
    const r2 = await drawTradesFromCsv({ _deps });
    assert.deepEqual(r2.drawn, []);
    assert.deepEqual(r2.skipped.map(s => s.reason), ['no bracket', 'already drawn', 'already drawn']);
    assert.equal(calls.creates.length, 2);
  });

  it('retries once with only stop/profit levels when full overrides throw', async () => {
    const { _deps, calls } = memChart({ dir: mesDir, createThrows: (overrides) => 'risk' in overrides });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.fallback_sizing, true);
    assert.equal(r.drawn.length, 2);
    assert.equal(calls.creates.length, 4);
    assert.deepEqual(calls.creates[1].overrides, { stopLevel: 40, profitLevel: 80 });
    assert.deepEqual(calls.creates[3].overrides, { stopLevel: 20, profitLevel: 40 });
  });

  it('omits risk and account size and flags fallback sizing when point value is unknown', async () => {
    const { _deps, calls } = memChart({ dir: noPvDir });
    const r = await drawTradesFromCsv({ _deps });
    assert.equal(r.fallback_sizing, true);
    assert.deepEqual(calls.creates[0].overrides, { stopLevel: 40, profitLevel: 80 });
    assert.equal(r.drawn.length, 2);
  });

  it('removes a drawing whose entry did not land on the expected bar and price', async () => {
    // Fake snaps entries one bar late.
    const { _deps, calls, state } = memChart({ dir: mesDir, snap: (t) => bar(t) + 60 });
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
    const { _deps, calls, state } = memChart({ dir: twoSymDir, symbol: 'NYMEX:CL1!', timeframe: 'D', createThrows: () => true });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /create failed/);
    assert.deepEqual(calls.setSymbol, ['CME_MINI:MES1!', 'NYMEX:CL1!']);
    assert.deepEqual(calls.setTimeframe, ['1', 'D']);
    assert.equal(state.symbol, 'NYMEX:CL1!');
    assert.equal(state.timeframe, 'D');
  });

  it('throws on an unreadable tick size and still restores', async () => {
    const { _deps, calls, state } = memChart({ dir: mesDir, timeframe: '60', tick: { minmov: 0, pricescale: 100 } });
    await assert.rejects(() => drawTradesFromCsv({ _deps }), /tick size/i);
    assert.equal(state.timeframe, '60');
    assert.deepEqual(calls.setView, [], 'the range never moved, so the view is left alone');
  });
});
