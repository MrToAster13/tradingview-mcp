/**
 * Tests for createCdpChartPositions(): the page JavaScript the CDP chart
 * positions adapter sends. evaluate() is a fake; nothing connects to CDP.
 *
 * Run: node --test tests/chart_positions.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createCdpChartPositions } from '../src/core/chart_positions.js';

function fakeCdp({ before = ['a'], after = ['a', 'b'] } = {}) {
  const exprs = [];
  let idReads = 0;
  let apiReads = 0;
  const evaluate = async (expr) => {
    exprs.push(expr);
    if (expr.includes('getAllShapes().map')) return idReads++ === 0 ? before : after;
    if (expr.includes('getShapeById')) return [{ time: 60, price: 1 }];
    return undefined;
  };
  const adapter = createCdpChartPositions({
    evaluate,
    getChartApi: async () => { apiReads++; return 'window.__api'; },
    getState: async () => ({ success: true, symbol: 'CME_MINI:MES1!', resolution: '15' }),
    sleep: async () => {},
  });
  return { adapter, exprs, apiReads: () => apiReads };
}

describe('createCdpChartPositions()', () => {
  it('maps chart state resolution to timeframe', async () => {
    const { adapter } = fakeCdp();
    assert.deepEqual(await adapter.getState(), { symbol: 'CME_MINI:MES1!', timeframe: '15' });
  });

  it('sends points and options as JSON and returns the id that appeared', async () => {
    const { adapter, exprs } = fakeCdp();
    const id = await adapter.createPosition({
      shape: 'long_position', entry_time: 120, end_time: 180, entry_price: 5000.25,
      overrides: { stopLevel: 40, profitLevel: 80, riskDisplayMode: 'money' },
    });
    assert.equal(id, 'b');
    const create = exprs.find(e => e.includes('createMultipointShape'));
    const m = /createMultipointShape\((\[.*?\]), (\{.*\})\)/s.exec(create);
    assert.deepEqual(JSON.parse(m[1]), [{ time: 120, price: 5000.25 }, { time: 180, price: 5000.25 }]);
    assert.deepEqual(JSON.parse(m[2]), { shape: 'long_position', overrides: { stopLevel: 40, profitLevel: 80, riskDisplayMode: 'money' } });
  });

  it('returns null when no new shape appeared', async () => {
    const { adapter } = fakeCdp({ before: ['a'], after: ['a'] });
    assert.equal(await adapter.createPosition({ shape: 'short_position', entry_time: 60, end_time: 120, entry_price: 1, overrides: {} }), null);
  });

  it('rejects non-finite times and prices before sending anything', async () => {
    const { adapter, exprs } = fakeCdp();
    await assert.rejects(() => adapter.createPosition({ shape: 'long_position', entry_time: NaN, end_time: 120, entry_price: 1, overrides: {} }));
    await assert.rejects(() => adapter.createPosition({ shape: 'long_position', entry_time: 60, end_time: 120, entry_price: '1);alert(1', overrides: {} }));
    assert.equal(exprs.length, 0);
  });

  it('quotes entity ids in readback and removal', async () => {
    const { adapter, exprs } = fakeCdp();
    const evil = 'x"); alert(1); ("';
    assert.deepEqual(await adapter.getAnchor(evil), { time: 60, price: 1 });
    await adapter.removePosition(evil);
    for (const e of exprs) assert.ok(e.includes(JSON.stringify(evil)), e);
  });

  it('setView rejects non-finite values before sending anything', async () => {
    const { adapter, exprs } = fakeCdp();
    await assert.rejects(() => adapter.setView({ spacing: 'x', offset: 1 }));
    await assert.rejects(() => adapter.setView({ spacing: 1, offset: Infinity }));
    assert.equal(exprs.length, 0);
    await adapter.setView({ spacing: 4.5, offset: 120 });
    assert.match(exprs[0], /setBarSpacing\(4\.5\);\s*ts\.setRightOffset\(120\)/);
  });

  it('reads the chart API path once', async () => {
    const { adapter, apiReads } = fakeCdp();
    await adapter.listPositions();
    await adapter.tickSize();
    await adapter.getView();
    assert.equal(apiReads(), 1);
  });
});
