/**
 * alert_copy (ELI-610): copy an existing alert, such as a study alert on a
 * Pine indicator, to a new resolution. The alert API is a fake; nothing
 * connects to CDP or TradingView.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { copy } from '../src/core/alerts.js';

// A study alert as pricealerts list_alerts returns it, trimmed to the fields
// that matter (shape read from a live alert on 2026-10-27).
function studyAlert(overrides = {}) {
  const condition = () => ({
    type: 'alert_cond',
    frequency: 'on_bar_close',
    series: [{
      type: 'study',
      study: 'Script@tv-scripting-101',
      pine_id: 'PUB;1f392d225c4a4af78775de8220363069',
      pine_version: '1.0',
      inputs: { in_0: '2.3.0', in_1: true, in_2: '60', in_3: 60, in_4: 53, in_5: -60, in_6: -53 },
      offsets_by_plot: { plot_0: 0, plot_1: 0 },
    }],
    alert_cond_id: 'plot_22',
    cross_interval: false,
    resolution: '15',
  });
  return {
    alert_id: 5913411136,
    symbol: '={"symbol":"CME_MINI:MES1!","adjustment":"splits","session":"regular","currency-id":"USD"}',
    resolution: '15',
    condition: condition(),
    conditions: [condition()],
    message: 'Blue Wave Crossing Down',
    expiration: '2026-11-23T20:57:53Z',
    auto_deactivate: false,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    sound_file: 'alert/calling',
    sound_duration: 0,
    popup: true,
    web_hook: null,
    name: null,
    type: 'indicator',
    active: true,
    presentation_data: { main_series: { type: 'futures' }, studies: {} },
    ...overrides,
  };
}

function fakeApi({ alerts = [studyAlert()], createResponse = { s: 'ok', r: { alert_id: 777 } } } = {}) {
  const created = [];
  return {
    created,
    async listAlerts() { return alerts; },
    async createAlert(payload) { created.push(payload); return createResponse; },
  };
}

describe('alert_copy', () => {
  it('posts a copy with the same script, inputs, condition and notification settings at the new resolution', async () => {
    const api = fakeApi();
    await copy({ alert_id: 5913411136, resolution: '1D' }, api);

    assert.equal(api.created.length, 1);
    const p = api.created[0];
    assert.equal(p.resolution, '1D');
    assert.equal(p.conditions.length, 1);
    const c = p.conditions[0];
    assert.equal(c.resolution, '1D');
    assert.equal(c.type, 'alert_cond');
    assert.equal(c.alert_cond_id, 'plot_22');
    assert.equal(c.frequency, 'on_bar_close');
    assert.equal(c.series[0].pine_id, 'PUB;1f392d225c4a4af78775de8220363069');
    assert.deepEqual(c.series[0].inputs, { in_0: '2.3.0', in_1: true, in_2: '60', in_3: 60, in_4: 53, in_5: -60, in_6: -53 });
    assert.equal(p.symbol, '={"symbol":"CME_MINI:MES1!","adjustment":"splits","session":"regular","currency-id":"USD"}');
    assert.equal(p.message, 'Blue Wave Crossing Down');
    assert.equal(p.sound_file, 'alert/calling');
    assert.equal(p.popup, true);
    assert.equal(p.mobile_push, true);
    assert.equal(p.email, false);
    assert.equal(p.auto_deactivate, false);
    assert.equal(p.active, true);
    assert.equal(p.expiration, '2026-11-23T20:57:53Z');
  });

  it('reports the new alert id and resolution when TradingView accepts the copy', async () => {
    const result = await copy({ alert_id: 5913411136, resolution: '1D' }, fakeApi());
    assert.equal(result.success, true);
    assert.equal(result.alert_id, 777);
    assert.equal(result.source_alert_id, 5913411136);
    assert.equal(result.resolution, '1D');
  });

  it('creates nothing and says why when the alert id is not found', async () => {
    const api = fakeApi();
    const result = await copy({ alert_id: 123, resolution: '1D' }, api);
    assert.equal(result.success, false);
    assert.match(result.error, /123.*not found/i);
    assert.equal(api.created.length, 0);
  });

  it('creates nothing and says why when the resolution is not a TradingView resolution', async () => {
    for (const bad of ['', 'daily', '1H', '-5', ' ']) {
      const api = fakeApi();
      const result = await copy({ alert_id: 5913411136, resolution: bad }, api);
      assert.equal(result.success, false, `resolution ${JSON.stringify(bad)}`);
      assert.match(result.error, /resolution/i);
      assert.equal(api.created.length, 0);
    }
  });

  it('gives the copy a future expiration when the source alert has already expired', async () => {
    const api = fakeApi({ alerts: [studyAlert({ expiration: '2026-01-01T00:00:00Z', active: false })] });
    const before = Date.now();
    await copy({ alert_id: 5913411136, resolution: '1D' }, api);
    const expires = Date.parse(api.created[0].expiration);
    assert.ok(expires > before + 29 * 24 * 3600 * 1000, `copy expires ${api.created[0].expiration}`);
  });

  it('creates nothing and says why when the source alert has no condition', async () => {
    const api = fakeApi({ alerts: [studyAlert({ condition: undefined, conditions: [] })] });
    const result = await copy({ alert_id: 5913411136, resolution: '1D' }, api);
    assert.equal(result.success, false);
    assert.match(result.error, /condition/i);
    assert.equal(api.created.length, 0);
  });

  it('reports TradingView\'s error when it rejects the copy', async () => {
    const api = fakeApi({ createResponse: { s: 'error', err: { code: 'too_many_alerts' } } });
    const result = await copy({ alert_id: 5913411136, resolution: '1D' }, api);
    assert.equal(result.success, false);
    assert.match(result.error, /too_many_alerts/);
  });
});
