/**
 * Core alert logic.
 *
 * Alerts are created / listed / deleted through TradingView's pricealerts REST API
 * (https://pricealerts.tradingview.com) using the desktop app's authenticated session.
 * Requests are sent as text/plain so the browser does not issue a CORS preflight that
 * the endpoint rejects. The create/delete bodies must be wrapped in a `payload` object.
 */
import { evaluate, evaluateAsync, safeString, requireFinite } from '../connection.js';

// Map the tool's friendly condition names to TradingView's alert condition types.
const CONDITION_TYPE_MAP = {
  crossing: 'cross', cross: 'cross',
  greater_than: 'greater', greater: 'greater', above: 'greater', '>': 'greater',
  less_than: 'less', less: 'less', below: 'less', '<': 'less',
};

export async function create({ condition, price, message }) {
  const p = requireFinite(price, 'price');
  const condType = CONDITION_TYPE_MAP[String(condition || 'crossing').trim().toLowerCase()] || 'cross';

  return evaluate(`
    (function() {
      try {
        var ms = window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
        var sym = (ms.proSymbol && ms.proSymbol()) || (ms.symbol && ms.symbol());
        if (!sym) return { success: false, error: 'Could not read current chart symbol from TradingView' };
        var price = ${JSON.stringify(p)};
        var condType = ${safeString(condType)};
        var msg = ${safeString(message || '')};
        if (!msg) {
          var verb = condType === 'greater' ? 'above' : (condType === 'less' ? 'below' : 'crossing');
          msg = sym.split(':').pop() + ' ' + verb + ' ' + price;
        }
        var cond = { type: condType, frequency: 'on_first_fire', series: [{ type: 'barset' }, { type: 'value', value: price }], resolution: '1' };
        var payload = {
          conditions: [cond],
          symbol: '={"symbol":"' + sym + '"}',
          resolution: '1',
          message: msg,
          sound_file: 'alert/fired', sound_duration: 0,
          popup: true, auto_deactivate: true,
          email: false, sms_over_email: false, mobile_push: true,
          web_hook: null, name: null,
          expiration: new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
          active: true, ignore_warnings: true
        };
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: payload }));
        var data = {};
        try { data = JSON.parse(x.responseText); } catch (e) {}
        if (data.s === 'ok') {
          return { success: true, source: 'internal_api', symbol: sym, price: price, condition: condType, message: msg, alert_id: (data.r && data.r.alert_id) || null };
        }
        return { success: false, source: 'internal_api', error: (data.err && data.err.code) || data.errmsg || ('HTTP ' + x.status), response: (x.responseText || '').slice(0, 200) };
      } catch (e) {
        return { success: false, source: 'internal_api', error: e.message };
      }
    })()
  `);
}

// The pricealerts calls this module makes, run inside TradingView Desktop with
// its session. Tests pass a fake with the same methods.
const pageApi = {
  async listAlerts() {
    const data = await evaluateAsync(`
      fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
        .then(function(r) { return r.json(); })
    `);
    if (!data || data.s !== 'ok' || !Array.isArray(data.r)) {
      throw new Error((data && data.errmsg) || 'list_alerts returned an unexpected response');
    }
    return data.r;
  },
  async createAlert(payload) {
    return evaluate(`
      (function() {
        var x = new XMLHttpRequest();
        x.open('POST', 'https://pricealerts.tradingview.com/create_alert', false);
        x.withCredentials = true;
        x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        x.send(JSON.stringify({ payload: ${JSON.stringify(payload)} }));
        try { return JSON.parse(x.responseText); } catch (e) { return { s: 'error', errmsg: 'HTTP ' + x.status }; }
      })()
    `);
  },
  async deleteAlerts(ids) {
    return evaluate(`
      (function() {
        try {
          var x = new XMLHttpRequest();
          x.open('POST', 'https://pricealerts.tradingview.com/delete_alerts', false);
          x.withCredentials = true;
          x.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
          x.send(JSON.stringify({ payload: { alert_ids: ${JSON.stringify(ids)} } }));
          try { return JSON.parse(x.responseText); } catch (e) { return { s: 'error', errmsg: 'HTTP ' + x.status + ' ' + (x.responseText || '').slice(0, 200) }; }
        } catch (e) { return { s: 'error', errmsg: e.message }; }
      })()
    `);
  },
};

function unwrapSymbol(symbol) {
  try { return JSON.parse(String(symbol).replace(/^=/, '')).symbol || symbol; } catch { return symbol; }
}

/**
 * List the account's alerts. A failed request returns success: false with
 * the error, so a logged-out session never reads as "no alerts".
 */
export async function list(api = pageApi) {
  let raw;
  try {
    raw = await api.listAlerts();
  } catch (err) {
    return { success: false, source: 'internal_api', error: err.message };
  }
  const alerts = raw.map((a) => ({
    alert_id: a.alert_id,
    symbol: unwrapSymbol(a.symbol),
    type: a.type,
    message: a.message,
    active: a.active,
    condition: a.condition,
    resolution: a.resolution,
    created: a.create_time,
    last_fired: a.last_fire_time,
    expiration: a.expiration,
  }));
  return { success: true, alert_count: alerts.length, source: 'internal_api', alerts };
}

export async function deleteAlerts({ delete_all, alert_ids, alert_id } = {}, api = pageApi) {
  // Resolve the set of alert ids to delete.
  let ids = [];
  if (Array.isArray(alert_ids)) ids = ids.concat(alert_ids);
  if (alert_id != null) ids.push(alert_id);
  if (delete_all) {
    const listed = await list(api);
    if (!listed.success) {
      return { success: false, source: 'internal_api', error: `Could not list alerts, nothing deleted: ${listed.error}` };
    }
    ids = listed.alerts.map((a) => a.alert_id);
  }
  ids = ids.filter((x) => x != null);
  if (!ids.length) {
    return { success: false, source: 'internal_api', error: delete_all ? 'No alerts to delete.' : 'Provide delete_all: true or an alert_id to delete.' };
  }

  const data = await api.deleteAlerts(ids);
  if (data && data.s === 'ok') {
    return { success: true, source: 'internal_api', deleted_count: ids.length, alert_ids: ids };
  }
  return { success: false, source: 'internal_api', alert_ids: ids, error: (data && ((data.err && data.err.code) || data.errmsg)) || 'delete failed' };
}

// Minutes ("15", "240"), or a count and unit ("1D", "1W", "30S"), or a bare unit ("D").
const RESOLUTION_RE = /^(\d+[SDWM]?|[SDWM])$/;

// Fields copied from the source alert unchanged: symbol, message and the
// notification settings. Conditions and resolution are set separately.
const COPIED_FIELDS = [
  'symbol', 'message', 'name', 'web_hook', 'expiration', 'auto_deactivate',
  'email', 'sms_over_email', 'mobile_push', 'popup', 'sound_file', 'sound_duration',
  'presentation_data',
];

/**
 * Copy an existing alert, including a study alert on a Pine indicator, to a
 * new resolution. The copy keeps the symbol, script, inputs, condition,
 * message and notification settings. Nothing is created when the alert is
 * not found or the resolution is not valid.
 */
export async function copy({ alert_id, resolution }, api = pageApi) {
  const res = String(resolution ?? '').trim();
  if (!RESOLUTION_RE.test(res)) {
    return { success: false, source: 'internal_api', error: `Invalid resolution ${JSON.stringify(resolution)}: use minutes such as "15" or "240", or "1D", "1W", "1M"` };
  }
  const id = Number(alert_id);
  const source = (await api.listAlerts()).find((a) => a.alert_id === id);
  if (!source) {
    return { success: false, source: 'internal_api', error: `Alert ${alert_id} not found` };
  }

  const conditions = (Array.isArray(source.conditions) && source.conditions.length ? source.conditions : [source.condition])
    .filter((c) => c && typeof c === 'object');
  if (!conditions.length) {
    return { success: false, source: 'internal_api', source_alert_id: id, error: `Alert ${alert_id} has no condition to copy` };
  }
  const payload = {};
  for (const field of COPIED_FIELDS) {
    if (source[field] !== undefined) payload[field] = structuredClone(source[field]);
  }
  // A source that has expired, or has no expiration, would hand the copy a
  // dead date. Give it the same 30 days create() uses.
  if (!(Date.parse(payload.expiration) > Date.now())) {
    payload.expiration = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  }
  payload.conditions = conditions.map((c) => ({ ...structuredClone(c), resolution: res }));
  payload.resolution = res;
  payload.active = true;
  payload.ignore_warnings = true;

  const data = await api.createAlert(payload);
  if (data && data.s === 'ok') {
    return { success: true, source: 'internal_api', alert_id: (data.r && data.r.alert_id) || null, source_alert_id: id, resolution: res };
  }
  return { success: false, source: 'internal_api', source_alert_id: id, error: (data && ((data.err && data.err.code) || data.errmsg)) || 'create_alert failed' };
}
