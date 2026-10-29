/**
 * alert_list and alert_delete failure handling (ELI-698). The alert API is a
 * fake; nothing connects to CDP or TradingView.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { list, deleteAlerts } from '../src/core/alerts.js';

function priceAlert(id) {
  return {
    alert_id: id,
    symbol: '={"symbol":"CME_MINI:MES1!"}',
    type: 'price',
    message: 'MES1! crossing 6000',
    active: true,
    condition: { type: 'cross' },
    resolution: '1',
  };
}

function fakeApi({ alerts = [priceAlert(1), priceAlert(2)], listError = null, deleteResponse = { s: 'ok' } } = {}) {
  const deleted = [];
  return {
    deleted,
    async listAlerts() {
      if (listError) throw new Error(listError);
      return alerts;
    },
    async deleteAlerts(ids) { deleted.push(ids); return deleteResponse; },
  };
}

describe('alert_list', () => {
  it('returns success: false and the error text when the alerts endpoint fails', async () => {
    const result = await list(fakeApi({ listError: 'not logged in' }));
    assert.equal(result.success, false);
    assert.match(result.error, /not logged in/);
  });

  it('returns the alerts with their symbol unwrapped when the endpoint works', async () => {
    const result = await list(fakeApi());
    assert.equal(result.success, true);
    assert.equal(result.alert_count, 2);
    assert.equal(result.alerts[0].alert_id, 1);
    assert.equal(result.alerts[0].symbol, 'CME_MINI:MES1!');
  });

  it('returns success: true with zero alerts when the account has none', async () => {
    const result = await list(fakeApi({ alerts: [] }));
    assert.equal(result.success, true);
    assert.equal(result.alert_count, 0);
  });
});

describe('alert_delete with delete_all', () => {
  it('returns success: false and deletes nothing when the list call fails', async () => {
    const api = fakeApi({ listError: 'list_alerts returned an unexpected response' });
    const result = await deleteAlerts({ delete_all: true }, api);
    assert.equal(result.success, false);
    assert.match(result.error, /unexpected response/);
    assert.equal(api.deleted.length, 0);
  });

  it('deletes every listed alert when the list call works', async () => {
    const api = fakeApi();
    const result = await deleteAlerts({ delete_all: true }, api);
    assert.equal(result.success, true);
    assert.deepEqual(api.deleted, [[1, 2]]);
    assert.equal(result.deleted_count, 2);
  });
});

describe('alerts.js list request', () => {
  it('holds one implementation of the list_alerts request', () => {
    const src = readFileSync(new URL('../src/core/alerts.js', import.meta.url), 'utf8');
    const hits = src.match(/pricealerts\.tradingview\.com\/list_alerts/g) || [];
    assert.equal(hits.length, 1);
  });
});
