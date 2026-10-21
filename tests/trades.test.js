/**
 * Tests for the paper-trading CSV parser and trade-to-drawing planner.
 * Pure functions only: no CDP, no network. Fixtures are synthetic.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  parseCsv, localToUnix, unixToLocal, EXPORT_TS_RE, findExport, netFromPositions, buildFills, planPosition, isDuplicate,
} from '../src/core/trades.js';

// ── Fixture helpers ──────────────────────────────────────────────────────

const ORDER_HEADER = 'Symbol,Side,Type,Quantity,Limit price,Stop price,Fill price,Status,Commission,Placing time,Closing time,Order ID,Level ID,Leverage,Margin';
const BALANCE_HEADER = 'Time,Balance before,Balance after,Realized PnL (value),Realized PnL (currency),Action';

// Rows are passed newest first, the way TradingView exports them.
const orders = (...rows) => parseCsv([ORDER_HEADER, ...rows].join('\n') + '\n');
const balances = (...rows) => parseCsv([BALANCE_HEADER, ...rows].join('\n') + '\n');
const closeAction = (sym, pv) =>
  `"Close long position for symbol ${sym} at price 5010.00 for 1 units. Position AVG Price was 5000.000000, currency: USD, rate: 1.000000, point value: ${pv}"`;

const T = localToUnix;
const EXPORT = T('2026-03-06 16:00:00');

// ── parseCsv() ───────────────────────────────────────────────────────────

describe('parseCsv()', () => {
  it('keys rows by header and keeps empty fields', () => {
    const rows = parseCsv('a,b,c\n1,,3\n');
    assert.deepEqual(rows, [{ a: '1', b: '', c: '3' }]);
  });

  it('handles quoted commas and escaped quotes', () => {
    const rows = parseCsv('x,y\n"5,823.94 USD","say ""hi"""\n');
    assert.equal(rows[0].x, '5,823.94 USD');
    assert.equal(rows[0].y, 'say "hi"');
  });

  it('handles BOM, CRLF and a missing trailing newline', () => {
    const rows = parseCsv('﻿a,b\r\n1,2\r\n3,4');
    assert.deepEqual(rows, [{ a: '1', b: '2' }, { a: '3', b: '4' }]);
  });

  it('keeps newlines inside quoted fields', () => {
    const rows = parseCsv('a,b\n"line1\nline2",2\n');
    assert.equal(rows[0].a, 'line1\nline2');
    assert.equal(rows[0].b, '2');
  });

  it('returns [] for empty input or header only', () => {
    assert.deepEqual(parseCsv(''), []);
    assert.deepEqual(parseCsv('a,b\n'), []);
  });
});

// ── localToUnix() ────────────────────────────────────────────────────────

describe('localToUnix()', () => {
  it('interprets the string in local time', () => {
    const expected = new Date(2026, 9, 14, 13, 34, 5).getTime() / 1000;
    assert.equal(localToUnix('2026-10-14 13:34:05'), expected);
  });

  it('round trips through Date local getters', () => {
    const d = new Date(localToUnix('2026-01-02 03:04:05') * 1000);
    assert.deepEqual(
      [d.getFullYear(), d.getMonth() + 1, d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds()],
      [2026, 1, 2, 3, 4, 5],
    );
  });

  it('is inverted by unixToLocal()', () => {
    for (const s of ['2026-10-14 13:34:05', '2026-01-02 03:04:05', '2026-12-31 23:59:59']) {
      assert.equal(unixToLocal(localToUnix(s)), s);
    }
  });

  it('throws on malformed input', () => {
    for (const bad of ['', '2026-10-14', '2026-10-14T13:34:00', '2026-13-01 00:00:00',
      '2026-02-30 00:00:00', '2026-10-14 24:00:00', '2026-10-14 13:60:00', ' 2026-10-14 13:34:00', null, undefined, 42]) {
      assert.throws(() => localToUnix(bad), `expected throw for ${JSON.stringify(bad)}`);
    }
  });
});

// ── findExport() ─────────────────────────────────────────────────────────

describe('findExport()', () => {
  let dir;
  const touch = (name) => writeFileSync(join(dir, name), 'x\n');

  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tv-trades-'));
    // Complete export, older
    touch('paper-trading-order-history-all-2026-01-05T10_00_00.101Z_ab12c.csv');
    touch('paper-trading-balance-history-2026-01-05T10_00_00.107Z_9z8y7.csv');
    // Complete export, newest valid
    touch('paper-trading-order-history-all-2026-01-06T09_00_00.205Z_290d6.csv');
    touch('paper-trading-balance-history-2026-01-06T09_00_00.208Z_d5537.csv');
    touch('paper-trading-activity-log-2026-01-06T09_00_00.216Z_77e9c.csv');
    // Order history with no balance file
    touch('paper-trading-order-history-all-2026-01-04T08_00_00.000Z_aaaaa.csv');
    // Newer names that do not match the strict pattern
    touch('paper-trading-order-history-all-2026-01-07T00_00_00.csv');
    touch('paper-trading-order-history-all-2026-01-08T00_00_00.000Z_ab12c (1).csv');
  });

  after(() => rmSync(dir, { recursive: true, force: true }));

  it('EXPORT_TS_RE accepts the id format only', () => {
    assert.ok(EXPORT_TS_RE.test('2026-10-14T22_32_05'));
    assert.ok(!EXPORT_TS_RE.test('2026-10-14T22:32:05'));
    assert.ok(!EXPORT_TS_RE.test('2026-10-14T22_32_05.205Z'));
  });

  it('picks the newest matching export by default', () => {
    const r = findExport({ dir });
    assert.equal(r.export_timestamp, '2026-01-06T09_00_00');
    assert.equal(r.order_history_path, join(dir, 'paper-trading-order-history-all-2026-01-06T09_00_00.205Z_290d6.csv'));
    assert.equal(r.balance_history_path, join(dir, 'paper-trading-balance-history-2026-01-06T09_00_00.208Z_d5537.csv'));
  });

  it('picks an explicit export id', () => {
    const r = findExport({ dir, exportTimestamp: '2026-01-05T10_00_00' });
    assert.equal(r.export_timestamp, '2026-01-05T10_00_00');
    assert.equal(r.balance_history_path, join(dir, 'paper-trading-balance-history-2026-01-05T10_00_00.107Z_9z8y7.csv'));
  });

  it('rejects path traversal and garbage ids', () => {
    for (const bad of ['../x', '..\\x', '2026-01-06T09_00_00/../..', '2026-01-06 09:00:00', '2026-01-06T09_00_00.205Z', '', 5]) {
      assert.throws(() => findExport({ dir, exportTimestamp: bad }), /export/i, `expected throw for ${JSON.stringify(bad)}`);
    }
  });

  it('throws for a well-formed id that does not exist', () => {
    assert.throws(() => findExport({ dir, exportTimestamp: '2026-01-01T00_00_00' }), /not found/i);
  });

  it('throws when the balance history for the id is missing', () => {
    assert.throws(() => findExport({ dir, exportTimestamp: '2026-01-04T08_00_00' }), /balance/i);
  });

  it('throws when the directory has no exports', () => {
    const empty = mkdtempSync(join(tmpdir(), 'tv-trades-empty-'));
    try {
      assert.throws(() => findExport({ dir: empty }), /no paper-trading/i);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

// ── netFromPositions() ───────────────────────────────────────────────────

describe('netFromPositions()', () => {
  it('treats an empty positions export as flat', () => {
    assert.deepEqual(netFromPositions([]), {});
  });

  it('nets signed quantities per symbol', () => {
    assert.deepEqual(netFromPositions([
      { Symbol: 'A', Side: 'Long', Qty: '3' },
      { Symbol: 'B', Side: 'Sell', Quantity: '2' },
    ]), { A: 3, B: -2 });
  });

  it('returns null for rows it cannot read', () => {
    assert.equal(netFromPositions([{ Symbol: 'A', Side: 'Long' }]), null);
    assert.equal(netFromPositions([{ Symbol: 'A', Side: 'flat', Qty: '1' }]), null);
    assert.equal(netFromPositions([{ Side: 'Long', Qty: '1' }]), null);
  });
});

// ── buildFills() ─────────────────────────────────────────────────────────

describe('buildFills()', () => {
  const PV = balances(`2026-03-06 15:00:00,100000,100000,0,USD,${closeAction('CME_MINI:MES1!', '5.000000')}`);

  it('builds a single long bracket fill', () => {
    const { fills, skipped } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Limit,2,5020.00,,,Cancelled,,2026-03-02 10:00:00,2026-03-02 10:20:00,1003,,,',
        'CME_MINI:MES1!,Sell,Stop,2,,4990.00,4990.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:20:00,1002,,,',
        'CME_MINI:MES1!,Buy,Market,2,,,5000.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:00:00,1001,,20x,"1,000.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(skipped, []);
    assert.deepEqual(fills, [{
      order_id: '1001', symbol: 'CME_MINI:MES1!', side: 'long', qty: 2,
      entry_price: 5000, entry_time: T('2026-03-02 10:00:00'),
      stop: 4990, target: 5020,
      exit_time: T('2026-03-02 10:20:00'), open_at_export: false,
      point_value: 5, account_size: 100000,
    }]);
  });

  it('closes every scaled short entry at the single exit, each with its own bracket', () => {
    const { fills, skipped } = buildFills({
      orders: orders(
        // third add, final bracket: target fills and closes all 4
        'CME_MINI:MES1!,Buy,Limit,4,5090.00,,5090.00,Filled,,2026-03-03 11:10:00,2026-03-03 11:30:00,2009,,,',
        'CME_MINI:MES1!,Buy,Stop,4,,5115.00,,Cancelled,,2026-03-03 11:10:00,2026-03-03 11:30:00,2008,,,',
        'CME_MINI:MES1!,Sell,Market,1,,,5108.00,Filled,,2026-03-03 11:10:00,2026-03-03 11:10:00,2007,,20x,"500.00 USD"',
        // second add, re-sized bracket cancelled by the third add
        'CME_MINI:MES1!,Buy,Limit,3,5085.00,,,Cancelled,,2026-03-03 11:05:00,2026-03-03 11:10:00,2006,,,',
        'CME_MINI:MES1!,Buy,Stop,3,,5112.00,,Cancelled,,2026-03-03 11:05:00,2026-03-03 11:10:00,2005,,,',
        'CME_MINI:MES1!,Sell,Market,2,,,5105.00,Filled,,2026-03-03 11:05:00,2026-03-03 11:05:00,2004,,20x,"1,000.00 USD"',
        // first entry, bracket cancelled by the second add
        'CME_MINI:MES1!,Buy,Limit,1,5080.00,,,Cancelled,,2026-03-03 11:00:00,2026-03-03 11:05:00,2003,,,',
        'CME_MINI:MES1!,Buy,Stop,1,,5110.00,,Cancelled,,2026-03-03 11:00:00,2026-03-03 11:05:00,2002,,,',
        'CME_MINI:MES1!,Sell,Market,1,,,5100.00,Filled,,2026-03-03 11:00:00,2026-03-03 11:00:00,2001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(skipped, []);
    assert.deepEqual(fills.map(f => [f.order_id, f.side, f.qty, f.entry_price, f.stop, f.target]), [
      ['2001', 'short', 1, 5100, 5110, 5080],
      ['2004', 'short', 2, 5105, 5112, 5085],
      ['2007', 'short', 1, 5108, 5115, 5090],
    ]);
    for (const f of fills) {
      assert.equal(f.exit_time, T('2026-03-03 11:30:00'));
      assert.equal(f.open_at_export, false);
    }
  });

  // History cut off mid-position: the long 8 that the 10:20 sell closes is
  // not in the export. The 10:30 bracketed buy only closes part of the short,
  // and 4007 (the stop of 4001's bracket, re-sized to 1) closes the rest.
  const TRUNCATED = orders(
    'CME_MINI:MES1!,Buy,Stop,1,,5050.00,5050.00,Filled,,2026-03-02 10:25:00,2026-03-02 10:50:00,4007,,,',
    'CME_MINI:MES1!,Sell,Limit,1,5060.00,,,Cancelled,,2026-03-02 10:30:00,2026-03-02 10:50:00,4006,,,',
    'CME_MINI:MES1!,Sell,Stop,1,,5025.00,,Cancelled,,2026-03-02 10:30:00,2026-03-02 10:50:00,4005,,,',
    'CME_MINI:MES1!,Buy,Market,1,,,5040.00,Filled,,2026-03-02 10:30:00,2026-03-02 10:30:00,4004,,20x,"500.00 USD"',
    'CME_MINI:MES1!,Buy,Limit,2,5030.00,,,Cancelled,,2026-03-02 10:25:00,2026-03-02 10:50:00,4003,,,',
    'CME_MINI:MES1!,Sell,Market,2,,,5040.00,Filled,,2026-03-02 10:25:00,2026-03-02 10:25:00,4001,,20x,"1,000.00 USD"',
    'CME_MINI:MES1!,Sell,Limit,8,5010.00,,5010.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:20:00,4000,,,',
  );

  it('starts the replay from the position held at export when given', () => {
    const { fills, skipped } = buildFills({ orders: TRUNCATED, balances: PV, exportTime: EXPORT, netAtExport: {} });
    assert.deepEqual(skipped, [{ order_id: '4004', reason: 'closes position' }]);
    assert.deepEqual(fills.map(f => [f.order_id, f.side, f.exit_time, f.open_at_export]), [
      ['4001', 'short', T('2026-03-02 10:50:00'), false],
    ]);
  });

  it('starts flat without netAtExport, as before', () => {
    // The unseen long 8 makes the replay think the short is still open.
    const { fills } = buildFills({ orders: TRUNCATED, balances: PV, exportTime: EXPORT });
    assert.equal(fills[0].order_id, '4001');
    assert.equal(fills[0].open_at_export, true);
  });

  it('closes fractional fills that sum to zero (0.1 + 0.2 - 0.3)', () => {
    const { fills } = buildFills({
      orders: orders(
        'BITSTAMP:BTCUSD,Sell,Market,0.3,,,60100.00,Filled,,2026-03-02 10:05:00,2026-03-02 10:05:00,5003,,,',
        'BITSTAMP:BTCUSD,Sell,Limit,0.2,60500.00,,,Cancelled,,2026-03-02 10:01:00,2026-03-02 10:05:00,5012,,,',
        'BITSTAMP:BTCUSD,Sell,Stop,0.2,,59500.00,,Cancelled,,2026-03-02 10:01:00,2026-03-02 10:05:00,5011,,,',
        'BITSTAMP:BTCUSD,Buy,Market,0.2,,,60050.00,Filled,,2026-03-02 10:01:00,2026-03-02 10:01:00,5002,,1x,"100.00 USD"',
        'BITSTAMP:BTCUSD,Sell,Limit,0.1,60500.00,,,Cancelled,,2026-03-02 10:00:00,2026-03-02 10:05:00,5022,,,',
        'BITSTAMP:BTCUSD,Sell,Stop,0.1,,59500.00,,Cancelled,,2026-03-02 10:00:00,2026-03-02 10:05:00,5021,,,',
        'BITSTAMP:BTCUSD,Buy,Market,0.1,,,60000.00,Filled,,2026-03-02 10:00:00,2026-03-02 10:00:00,5001,,1x,"100.00 USD"',
      ),
      balances: balances(`2026-03-06 15:00:00,100000,100000,0,USD,${closeAction('BITSTAMP:BTCUSD', '1.000000')}`),
      exportTime: EXPORT,
    });
    assert.deepEqual(fills.map(f => [f.order_id, f.exit_time, f.open_at_export]), [
      ['5001', T('2026-03-02 10:05:00'), false],
      ['5002', T('2026-03-02 10:05:00'), false],
    ]);
  });

  it('accounts for a position still open at export', () => {
    const { fills } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Buy,Limit,2,5030.00,,,Working,,2026-03-02 10:25:00,,4003,,,',
        'CME_MINI:MES1!,Buy,Stop,2,,5050.00,,Working,,2026-03-02 10:25:00,,4002,,,',
        'CME_MINI:MES1!,Sell,Market,2,,,5040.00,Filled,,2026-03-02 10:25:00,2026-03-02 10:25:00,4001,,20x,"1,000.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
      netAtExport: { 'CME_MINI:MES1!': -2 },
    });
    assert.equal(fills[0].open_at_export, true);
    assert.equal(fills[0].exit_time, EXPORT);
  });

  it('uses the Closing time as entry time for a limit entry that fills later', () => {
    const { fills } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Limit,1,4970.00,,,Cancelled,,2026-03-04 09:00:00,2026-03-04 10:15:00,3003,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4940.00,4940.00,Filled,,2026-03-04 09:00:00,2026-03-04 10:15:00,3002,,,',
        'CME_MINI:MES1!,Buy,Limit,1,4950.00,,4950.00,Filled,,2026-03-04 09:00:00,2026-03-04 09:45:00,3001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.equal(fills.length, 1);
    assert.equal(fills[0].entry_time, T('2026-03-04 09:45:00'));
    assert.equal(fills[0].exit_time, T('2026-03-04 10:15:00'));
  });

  it('closes a position still open at export at exportTime', () => {
    const { fills } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Limit,1,5050.00,,,Working,,2026-03-06 14:00:00,,4003,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,5030.00,,Working,,2026-03-06 14:00:00,,4002,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5040.00,Filled,,2026-03-06 14:00:00,2026-03-06 14:00:00,4001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.equal(fills.length, 1);
    assert.equal(fills[0].exit_time, EXPORT);
    assert.equal(fills[0].open_at_export, true);
  });

  it('skips an entry with no bracket but still tracks its position', () => {
    const { fills, skipped } = buildFills({
      orders: orders(
        // bracketed trade after the unbracketed one closes
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,5020.00,Filled,,2026-03-05 10:30:00,2026-03-05 10:45:00,5006,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 10:30:00,2026-03-05 10:45:00,5005,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 10:30:00,2026-03-05 10:30:00,5004,,20x,"500.00 USD"',
        // manual exit with no leverage
        'CME_MINI:MES1!,Sell,Market,1,,,5005.00,Filled,,2026-03-05 10:10:00,2026-03-05 10:10:00,5002,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5001.00,Filled,,2026-03-05 10:00:00,2026-03-05 10:00:00,5001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(skipped, [{ order_id: '5001', reason: 'no bracket' }]);
    assert.equal(fills.length, 1);
    assert.equal(fills[0].order_id, '5004');
    assert.equal(fills[0].exit_time, T('2026-03-05 10:45:00'));
  });

  it('skips an entry that has a stop but no target', () => {
    const { fills, skipped } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Stop,1,,4990.00,4990.00,Filled,,2026-03-05 12:00:00,2026-03-05 12:05:00,5102,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 12:00:00,2026-03-05 12:00:00,5101,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(fills, []);
    assert.deepEqual(skipped, [{ order_id: '5101', reason: 'no bracket' }]);
  });

  // Two longs placed in the same second, each with its own stop and limit.
  const sameSecond = (levelA, levelB) => orders(
    `CME_MINI:MES1!,Sell,Limit,1,5040.00,,,Cancelled,,2026-03-05 17:00:00,2026-03-05 17:20:00,10006,${levelB},,`,
    `CME_MINI:MES1!,Sell,Stop,1,,5000.00,,Cancelled,,2026-03-05 17:00:00,2026-03-05 17:20:00,10005,${levelB},,`,
    `CME_MINI:MES1!,Buy,Market,1,,,5010.00,Filled,,2026-03-05 17:00:00,2026-03-05 17:00:00,10004,${levelB},20x,"500.00 USD"`,
    `CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 17:00:00,2026-03-05 17:20:00,10003,${levelA},,`,
    `CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 17:00:00,2026-03-05 17:20:00,10002,${levelA},,`,
    `CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 17:00:00,2026-03-05 17:00:00,10001,${levelA},20x,"500.00 USD"`,
  );

  it('gives each same-second entry its own bracket when Level IDs link them', () => {
    const { fills, skipped } = buildFills({ orders: sameSecond('L1', 'L2'), balances: PV, exportTime: EXPORT });
    assert.deepEqual(skipped, []);
    const byId = Object.fromEntries(fills.map(f => [f.order_id, f]));
    assert.equal(fills.length, 2);
    assert.deepEqual([byId['10001'].stop, byId['10001'].target], [4990, 5020]);
    assert.deepEqual([byId['10004'].stop, byId['10004'].target], [5000, 5040]);
  });

  it('skips same-second entries that no Level ID links to a bracket', () => {
    for (const [a, b] of [['', ''], ['L1', 'L1']]) {
      const { fills, skipped } = buildFills({ orders: sameSecond(a, b), balances: PV, exportTime: EXPORT });
      assert.deepEqual(fills, [], `levels ${a}/${b}`);
      assert.deepEqual(skipped.map(s => s.order_id).sort(), ['10001', '10004'], `levels ${a}/${b}`);
      for (const s of skipped) assert.equal(s.reason, 'ambiguous bracket');
    }
  });

  it('skips a filled entry with a blank or whitespace fill price', () => {
    for (const price of ['', '   ']) {
      const { fills, skipped } = buildFills({
        orders: orders(
          'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 18:00:00,2026-03-05 18:20:00,11003,,,',
          'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 18:00:00,2026-03-05 18:20:00,11002,,,',
          `CME_MINI:MES1!,Buy,Market,1,,,${price},Filled,,2026-03-05 18:00:00,2026-03-05 18:00:00,11001,,20x,"500.00 USD"`,
          'CME_MNQ1!,Sell,Limit,1,18100.00,,,Cancelled,,2026-03-05 19:00:00,2026-03-05 19:20:00,11103,,,',
          'CME_MNQ1!,Sell,Stop,1,,17900.00,,Cancelled,,2026-03-05 19:00:00,2026-03-05 19:20:00,11102,,,',
          'CME_MNQ1!,Buy,Market,1,,,18000.00,Filled,,2026-03-05 19:00:00,2026-03-05 19:00:00,11101,,20x,"500.00 USD"',
        ),
        balances: PV,
        exportTime: EXPORT,
      });
      assert.deepEqual(fills.map(f => f.order_id), ['11101'], `price '${price}'`);
      assert.deepEqual(skipped, [{ order_id: '11001', reason: 'missing or invalid fill price' }], `price '${price}'`);
    }
  });

  it('skips a filled entry with a blank or whitespace quantity instead of drawing zero risk', () => {
    for (const qty of ['', '  ']) {
      const { fills, skipped } = buildFills({
        orders: orders(
          'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 20:00:00,2026-03-05 20:20:00,12003,,,',
          'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 20:00:00,2026-03-05 20:20:00,12002,,,',
          `CME_MINI:MES1!,Buy,Market,${qty},,,5000.00,Filled,,2026-03-05 20:00:00,2026-03-05 20:00:00,12001,,20x,"500.00 USD"`,
        ),
        balances: PV,
        exportTime: EXPORT,
      });
      assert.deepEqual(fills, [], `qty '${qty}'`);
      assert.deepEqual(skipped, [{ order_id: '12001', reason: 'invalid quantity in order history' }], `qty '${qty}'`);
    }
  });

  it('skips an entry whose stop or target is zero or negative', () => {
    for (const [stop, target] of [['0.00', '5020.00'], ['-4990.00', '5020.00'], ['4990.00', '0.00']]) {
      const { fills, skipped } = buildFills({
        orders: orders(
          `CME_MINI:MES1!,Sell,Limit,1,${target},,,Cancelled,,2026-03-05 21:00:00,2026-03-05 21:20:00,13003,,,`,
          `CME_MINI:MES1!,Sell,Stop,1,,${stop},,Cancelled,,2026-03-05 21:00:00,2026-03-05 21:20:00,13002,,,`,
          'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 21:00:00,2026-03-05 21:00:00,13001,,20x,"500.00 USD"',
        ),
        balances: PV,
        exportTime: EXPORT,
      });
      assert.deepEqual(fills, [], `stop ${stop}, target ${target}`);
      assert.deepEqual(skipped, [{ order_id: '13001', reason: 'missing or invalid bracket price' }], `stop ${stop}, target ${target}`);
    }
  });

  it('skips every entry on a symbol with a Filled row that has no quantity, and no other symbol', () => {
    for (const qty of ['', '  ', '0', '-1']) {
      const { fills, skipped } = buildFills({
        orders: orders(
          'CME_MNQ1!,Sell,Limit,1,18100.00,,18100.00,Filled,,2026-03-05 23:00:00,2026-03-05 23:20:00,14103,,,',
          'CME_MNQ1!,Sell,Stop,1,,17900.00,,Cancelled,,2026-03-05 23:00:00,2026-03-05 23:20:00,14102,,,',
          'CME_MNQ1!,Buy,Market,1,,,18000.00,Filled,,2026-03-05 23:00:00,2026-03-05 23:00:00,14101,,20x,"500.00 USD"',
          'CME_MES1!,Sell,Limit,1,5030.00,,,Cancelled,,2026-03-05 22:30:00,2026-03-05 22:50:00,14006,,,',
          'CME_MES1!,Sell,Stop,1,,4995.00,,Cancelled,,2026-03-05 22:30:00,2026-03-05 22:50:00,14005,,,',
          'CME_MES1!,Buy,Market,1,,,5001.00,Filled,,2026-03-05 22:30:00,2026-03-05 22:30:00,14004,,20x,"500.00 USD"',
          `CME_MES1!,Sell,Market,${qty},,,5010.00,Filled,,2026-03-05 22:10:00,2026-03-05 22:10:00,14007,,,`,
          'CME_MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 22:00:00,2026-03-05 22:20:00,14003,,,',
          'CME_MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 22:00:00,2026-03-05 22:20:00,14002,,,',
          'CME_MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 22:00:00,2026-03-05 22:00:00,14001,,20x,"500.00 USD"',
        ),
        balances: PV,
        exportTime: EXPORT,
      });
      assert.deepEqual(fills.map(f => [f.order_id, f.symbol, f.exit_time]), [
        ['14101', 'CME_MNQ1!', T('2026-03-05 23:20:00')],
      ], `qty '${qty}'`);
      assert.deepEqual(skipped, [
        { order_id: '14001', reason: 'invalid quantity in order history' },
        { order_id: '14004', reason: 'invalid quantity in order history' },
      ], `qty '${qty}'`);
    }
  });

  it('ignores a rejected entry and its bracket', () => {
    const { fills, skipped } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Rejected,,2026-03-05 13:00:00,2026-03-05 13:00:00,6003,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Rejected,,2026-03-05 13:00:00,2026-03-05 13:00:00,6002,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,,Rejected,,2026-03-05 13:00:00,2026-03-05 13:00:00,6001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(fills, []);
    assert.deepEqual(skipped, []);
  });

  it('replays same-second fills in export order (exit before the next entry)', () => {
    const { fills } = buildFills({
      orders: orders(
        // second trade: entry fills the same second the first trade's stop fills
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,5020.00,Filled,,2026-03-05 14:10:00,2026-03-05 14:30:00,7006,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4980.00,,Cancelled,,2026-03-05 14:10:00,2026-03-05 14:30:00,7005,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,4995.00,Filled,,2026-03-05 14:10:00,2026-03-05 14:10:00,7004,,20x,"500.00 USD"',
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 14:00:00,2026-03-05 14:10:00,7003,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4995.00,4995.00,Filled,,2026-03-05 14:00:00,2026-03-05 14:10:00,7002,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 14:00:00,2026-03-05 14:00:00,7001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(fills.map(f => [f.order_id, f.exit_time]), [
      ['7001', T('2026-03-05 14:10:00')],
      ['7004', T('2026-03-05 14:30:00')],
    ]);
  });

  it('closes open entries when a fill flips the position', () => {
    const { fills } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Buy,Market,1,,,5003.00,Filled,,2026-03-05 15:20:00,2026-03-05 15:20:00,8004,,,',
        'CME_MINI:MES1!,Sell,Market,2,,,5005.00,Filled,,2026-03-05 15:10:00,2026-03-05 15:10:00,8003,,,',
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 15:00:00,2026-03-05 15:10:00,8002,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 15:00:00,2026-03-05 15:10:00,8005,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 15:00:00,2026-03-05 15:00:00,8001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.equal(fills.length, 1);
    assert.equal(fills[0].exit_time, T('2026-03-05 15:10:00'));
  });

  it('keeps symbols independent', () => {
    const { fills } = buildFills({
      orders: orders(
        'CME_MINI:MES1!,Sell,Market,1,,,5010.00,Filled,,2026-03-05 16:20:00,2026-03-05 16:20:00,9006,,,',
        'CME_MINI:MNQ1!,Sell,Limit,1,18100.00,,18100.00,Filled,,2026-03-05 16:05:00,2026-03-05 16:10:00,9005,,,',
        'CME_MINI:MNQ1!,Sell,Stop,1,,17900.00,,Cancelled,,2026-03-05 16:05:00,2026-03-05 16:10:00,9004,,,',
        'CME_MINI:MNQ1!,Buy,Market,1,,,18000.00,Filled,,2026-03-05 16:05:00,2026-03-05 16:05:00,9003,,20x,"500.00 USD"',
        'CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,2026-03-05 16:00:00,2026-03-05 16:20:00,9002,,,',
        'CME_MINI:MES1!,Sell,Stop,1,,4990.00,,Cancelled,,2026-03-05 16:00:00,2026-03-05 16:20:00,9007,,,',
        'CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,2026-03-05 16:00:00,2026-03-05 16:00:00,9001,,20x,"500.00 USD"',
      ),
      balances: PV,
      exportTime: EXPORT,
    });
    assert.deepEqual(fills.map(f => [f.order_id, f.exit_time, f.point_value]), [
      ['9001', T('2026-03-05 16:20:00'), 5],
      ['9003', T('2026-03-05 16:10:00'), null],
    ]);
  });

  describe('point_value and account_size lookup', () => {
    const bracket = (id, placed) => [
      `CME_MINI:MES1!,Sell,Limit,1,5020.00,,,Cancelled,,${placed},${placed},${id}3,,,`,
      `CME_MINI:MES1!,Sell,Stop,1,,4990.00,4990.00,Filled,,${placed},${placed},${id}2,,,`,
      `CME_MINI:MES1!,Buy,Market,1,,,5000.00,Filled,,${placed},${placed},${id}1,,20x,"500.00 USD"`,
    ];
    const ORD = orders(
      ...bracket('13', '2026-03-03 13:00:00'), // after the latest balance row
      ...bracket('12', '2026-03-03 12:00:00'), // exactly on the latest balance row
      ...bracket('11', '2026-03-02 11:00:00'), // between rows
      ...bracket('10', '2026-03-02 09:00:00'), // before any balance row
    );
    const BAL = balances(
      `2026-03-03 12:00:00,100100,100050,-50,USD,${closeAction('CME_MINI:MES1!', '5.000000')}`,
      `2026-03-03 11:00:00,100050,100100,50,USD,${closeAction('CME_MINI:MNQ1!', '2.000000')}`,
      `2026-03-02 10:20:00,100000,100050,50,USD,${closeAction('CME_MINI:MES1!', '50.000000')}`,
    );

    it('takes point value from the latest row for the symbol', () => {
      const { fills } = buildFills({ orders: ORD, balances: BAL, exportTime: EXPORT });
      for (const f of fills) assert.equal(f.point_value, 5);
    });

    it('takes account size from the latest row at or before entry, else the earliest Balance before', () => {
      const { fills } = buildFills({ orders: ORD, balances: BAL, exportTime: EXPORT });
      assert.deepEqual(fills.map(f => [f.order_id, f.account_size]), [
        ['101', 100000],
        ['111', 100050],
        ['121', 100050],
        ['131', 100050],
      ]);
    });

    it('returns null point value and account size with no balance rows', () => {
      const { fills } = buildFills({ orders: ORD, balances: [], exportTime: EXPORT });
      assert.equal(fills.length, 4);
      for (const f of fills) {
        assert.equal(f.point_value, null);
        assert.equal(f.account_size, null);
      }
    });
  });
});

// ── planPosition() ───────────────────────────────────────────────────────

describe('planPosition()', () => {
  const E = T('2026-03-02 10:00:00');
  const longFill = {
    order_id: '1', symbol: 'CME_MINI:MES1!', side: 'long', qty: 2, entry_price: 5000, entry_time: E,
    stop: 4990, target: 5020, exit_time: E + 600, open_at_export: false, point_value: 5, account_size: 100000,
  };

  it('computes ticks, risk and end time for a long', () => {
    assert.deepEqual(planPosition(longFill, { tick: 0.25 }), {
      shape: 'long_position', entry_time: E, end_time: E + 600, entry_price: 5000,
      stop_ticks: 40, profit_ticks: 80, risk_amount: 100, account_size: 100000,
    });
  });

  it('computes a short with stop above and target below', () => {
    const p = planPosition({ ...longFill, side: 'short', stop: 5012.5, target: 4975 }, { tick: 0.25 });
    assert.equal(p.shape, 'short_position');
    assert.equal(p.stop_ticks, 50);
    assert.equal(p.profit_ticks, 100);
    assert.equal(p.risk_amount, 125);
  });

  it('rounds ticks that are not exact in floating point', () => {
    const p = planPosition({ ...longFill, entry_price: 5000.3, stop: 5000.1, target: 5000.7 }, { tick: 0.1 });
    assert.equal(p.stop_ticks, 2);
    assert.equal(p.profit_ticks, 4);
  });

  it('enforces a 5 minute minimum width by default', () => {
    assert.equal(planPosition({ ...longFill, exit_time: E + 60 }, { tick: 0.25 }).end_time, E + 300);
    assert.equal(planPosition({ ...longFill, exit_time: E }, { tick: 0.25 }).end_time, E + 300);
  });

  it('honours a custom minimum width', () => {
    assert.equal(planPosition({ ...longFill, exit_time: E + 60 }, { tick: 0.25, minWidthSec: 900 }).end_time, E + 900);
  });

  it('returns null risk when point value is unknown', () => {
    assert.equal(planPosition({ ...longFill, point_value: null }, { tick: 0.25 }).risk_amount, null);
  });

  it('throws on a non-finite or non-positive tick', () => {
    for (const tick of [0, -0.25, NaN, Infinity, undefined, '0.25']) {
      assert.throws(() => planPosition(longFill, { tick }), /tick/, `expected throw for ${String(tick)}`);
    }
  });
});

// ── isDuplicate() ────────────────────────────────────────────────────────

describe('isDuplicate()', () => {
  const E = T('2026-03-02 10:00:30');
  const plan = { shape: 'long_position', entry_time: E, entry_price: 5000.25 };
  const barStart = Math.floor(E / 60) * 60;

  it('matches same shape, same bar, same price', () => {
    assert.equal(isDuplicate(plan, [{ shape: 'long_position', time: barStart, price: 5000.25 }]), true);
  });

  it('misses on a different side', () => {
    assert.equal(isDuplicate(plan, [{ shape: 'short_position', time: barStart, price: 5000.25 }]), false);
  });

  it('misses on a different bar', () => {
    assert.equal(isDuplicate(plan, [{ shape: 'long_position', time: barStart + 60, price: 5000.25 }]), false);
    assert.equal(isDuplicate(plan, [{ shape: 'long_position', time: barStart - 1, price: 5000.25 }]), false);
  });

  it('respects a custom bar size', () => {
    // 10:00:30 and 10:01:00 share a 5 minute bar in every real timezone offset
    assert.equal(isDuplicate(plan, [{ shape: 'long_position', time: barStart + 60, price: 5000.25 }], 300), true);
  });

  it('misses on a different price', () => {
    assert.equal(isDuplicate(plan, [{ shape: 'long_position', time: barStart, price: 5000.5 }]), false);
  });

  it('returns false for no existing drawings', () => {
    assert.equal(isDuplicate(plan, []), false);
  });
});
