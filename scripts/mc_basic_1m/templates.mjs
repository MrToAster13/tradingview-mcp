// Fixed CDP expression templates for the mc_basic_1m scripts.
// Each template is the text (async () => { body })(). cdp.mjs hashes the
// exported string, fills the @@NAME@@ placeholders with fillTemplate, and
// sends the result to Runtime.evaluate. Nothing here runs by itself.

const RUN_COLOURS = Object.freeze({
  'HTF-a': '#9c27b0',
  'HTF-b': '#ff9800',
  'HTF-c': '#00bcd4',
});

const READ_GUARD = [
  'const chart = TradingViewApi._activeChartWidgetWV.value();',
  'if (!location.pathname.startsWith(@@GUARD_PATH@@)) { return "E_PATH"; }',
  'if (TradingViewApi.chartsCount() !== 1) { return "E_CHARTS"; }',
  'if (chart.symbol() !== "CME_MINI:MES1!") { return "E_SYMBOL"; }',
  'if (chart.resolution() !== @@EXPECTED_RES@@) { return "E_RES"; }',
  'if (TradingViewApi._activeChartWidgetWV.value() !== chart) { return "E_CHARTS"; }',
].join(' ');

const WRITE_GUARD = 'location.pathname.startsWith("/chart/HCCCDVCt/") && TradingViewApi.chartsCount() === 1 && chart.symbol() === "CME_MINI:MES1!" && chart.resolution() === "1" && TradingViewApi._activeChartWidgetWV.value() === chart && Date.now() < @@DEADLINE@@';

const GUARD_STEP = 'if (!(' + WRITE_GUARD + ')) { return "E_GUARD"; }';

const GUARD_STEP_RETURNING_IDS = 'if (!(' + WRITE_GUARD + ')) { return ["E_GUARD", sid, i]; }';

const DRAW_BODY = [
  'const chart = TradingViewApi._activeChartWidgetWV.value();',
  GUARD_STEP,
  'const all = chart.getAllShapes();',
  'const ids = [];',
  'for (const s of all) { ids.push(s.id); }',
  GUARD_STEP,
  'const txt = chart.createShape({ time: TEXT_TIME, price: TEXT_PRICE }, { shape: "text", text: TEXT });',
  'const fresh = chart.getAllShapes();',
  'const rows = [];',
  'for (const s of fresh) { if (!ids.includes(s.id)) { rows.push(s); } }',
  'const a = [];',
  'for (const s of rows) { if (s.id === txt) { a.push(s); } }',
  'const pos = [];',
  'if (a.length === 1) { pos.push(a[0]); }',
  'if (a.length === 0 && rows.length === 1) { pos.push(rows[0]); }',
  'if (pos.length !== 1) { return "E_TEXT_ID"; }',
  'const sid = pos[0].id;',
  'const st = chart.getShapeById(sid);',
  'if (!st || st.name !== "text") { return "E_TEXT_ID"; }',
  'const pts = st.getPoints();',
  'const p = st.getProperties();',
  'if (pts.length !== 1 || pts[0].time !== TEXT_TIME || pts[0].price !== TEXT_PRICE || p.text !== TEXT) { return "E_TEXT_ID"; }',
  'const x = chart.getAllShapes();',
  'const b = [];',
  'for (const s of x) { b.push(s.id); }',
  'const out = [];',
  'try {',
  GUARD_STEP,
  'const r = chart.createMultipointShape([{ time: P1_TIME, price: P1_PRICE }, { time: P2_TIME, price: P2_PRICE }], { shape: IS_LONG ? "long_position" : "short_position", overrides: { stopLevel: STOP_LEVEL, profitLevel: PROFIT_LEVEL, linecolor: COLOUR } });',
  'out.push(r);',
  '} catch (e) {',
  'await new Promise(resolve => setTimeout(resolve, 5000));',
  'const a = [];',
  'for (const s of chart.getAllShapes()) { if (!b.includes(s.id)) { a.push(s); } }',
  'if (a.length === 0) { return ["E_POS_THROW", sid, null]; }',
  'if (a.length !== 1) { return ["E_POS_ID", sid, null]; }',
  'const st = chart.getShapeById(a[0].id);',
  'if (!st || st.name !== (IS_LONG ? "long_position" : "short_position")) { return ["E_POS_ID", sid, null]; }',
  'out.push(a[0].id);',
  '}',
  'try {',
  'const a = [];',
  'for (const s of chart.getAllShapes()) { if (!b.includes(s.id)) { a.push(s); } }',
  'const pos = [];',
  'for (const s of a) { if (s.id === out[0]) { pos.push(s); } }',
  'if (pos.length !== 1) { return ["E_POS_ID", sid, null]; }',
  'const i = pos[0].id;',
  'const st = chart.getShapeById(i);',
  'if (!st) { return ["E_POS_ID", sid, null]; }',
  'const pts = st.getPoints();',
  'if (st.name !== (IS_LONG ? "long_position" : "short_position") || pts[0].time !== P1_TIME || pts[0].price !== P1_PRICE) { return ["E_POS_ID", sid, i]; }',
  '{',
  GUARD_STEP_RETURNING_IDS,
  'const st = chart.getShapeById(i);',
  'if (!st) { return ["E_NOSHAPE", sid, i]; }',
  'const pts = st.getPoints();',
  'const p = st.getProperties();',
  'const x = chart.getShapeById(sid);',
  'if (!x) { return ["E_NOSHAPE", sid, i]; }',
  'const fresh = x.getPoints();',
  'const rows = x.getProperties();',
  'if (st.name !== (IS_LONG ? "long_position" : "short_position") || pts.length !== 2 || pts[0].time !== P1_TIME || pts[0].price !== P1_PRICE || pts[1].time !== P2_TIME || pts[1].price !== P2_PRICE || p.stopLevel !== STOP_LEVEL || p.profitLevel !== PROFIT_LEVEL || x.name !== "text" || fresh.length !== 1 || fresh[0].time !== TEXT_TIME || fresh[0].price !== TEXT_PRICE || rows.text !== TEXT) { return ["E_SHAPE_MISMATCH", sid, i]; }',
  'return { id: i, text: sid, linecolor: p.linecolor };',
  '}',
  '} catch (e) { return ["E_POS_ID", sid, null]; }',
].join(' ');

const READ_HISTORY_BODY = [
  READ_GUARD,
  'const r = (x, i, p) => { if (i > x.lastIndex()) { return p; } p.push(x.valueAt(i).map(a => (isFinite(a) ? a : null))); return r(x, i + 1, p); };',
  'const x = chart._chartWidget.model().mainSeries().bars();',
  'const out = r(x, x.firstIndex(), []);',
  'const all = chart._chartWidget.model().model().dataSources();',
  'const pts = [];',
  'const pos = [];',
  'for (const s of all) { if (s.metaInfo && s.metaInfo().description === "MarketCipher_B") { pts.push(s); } if (s.metaInfo && s.metaInfo().description === "MarketCipher_SR") { pos.push(s); } }',
  'if (pts.length === 0) { return "E_NOSTUDY"; }',
  'if (@@GUARD_PATH@@ === "/chart/HCCCDVCt/" && pos.length === 0) { return "E_NOSTUDY"; }',
  'const ids = pts[0].data();',
  'const b = r(ids, ids.firstIndex(), []);',
  'const fresh = (@@GUARD_PATH@@ !== "/chart/HCCCDVCt/" || pos.length === 0) ? null : r(pos[0].data(), pos[0].data().firstIndex(), []);',
  'const sid = pts[0].metaInfo().plots.map(p => ({ id: p.id, type: p.type }));',
  'const txt = (@@GUARD_PATH@@ !== "/chart/HCCCDVCt/" || pos.length === 0) ? null : pos[0].metaInfo().plots.map(p => ({ id: p.id, type: p.type }));',
  'const st = (@@GUARD_PATH@@ !== "/chart/HCCCDVCt/" || pos.length === 0) ? null : pos[0].inputs().in_2;',
  'return [out, b, fresh, sid, txt, st];',
].join(' ');

const READ_SHAPES_BODY = [
  READ_GUARD,
  'const all = chart.getAllShapes();',
  'const out = [];',
  'for (const s of all) { const st = chart.getShapeById(s.id); if (!st) { return "E_NOSHAPE"; } const p = st.getProperties(); const pts = st.getPoints(); out.push({ id: s.id, name: st.name, pts: pts.map(a => ({ time: a.time, price: a.price })), linecolor: p.linecolor || null, text: p.text || null, stopLevel: p.stopLevel || null, profitLevel: p.profitLevel || null }); }',
  'return out;',
].join(' ');

const DISCOVER_BODY = [
  READ_GUARD,
  'const all = chart._chartWidget.model().model().dataSources();',
  'const pos = [];',
  'for (const s of all) { if (s.metaInfo && s.metaInfo().description === "MarketCipher_B") { pos.push(s); } }',
  'if (pos.length === 0) { return "E_NOSTUDY"; }',
  'return true;',
].join(' ');

const IDENTITY_BODY = READ_GUARD + ' return true;';

const wrap = (body) => '(async () => { ' + body + ' })()';

const TEMPLATES = Object.freeze({
  identity: wrap(IDENTITY_BODY),
  discover: wrap(DISCOVER_BODY),
  read_history: wrap(READ_HISTORY_BODY),
  read_shapes: wrap(READ_SHAPES_BODY),
  draw_trade: wrap(DRAW_BODY),
});

const READ_PLACEHOLDERS = Object.freeze(['GUARD_PATH', 'EXPECTED_RES']);

const PLACEHOLDERS = Object.freeze({
  identity: READ_PLACEHOLDERS,
  discover: READ_PLACEHOLDERS,
  read_history: READ_PLACEHOLDERS,
  read_shapes: READ_PLACEHOLDERS,
  draw_trade: Object.freeze([
    'DEADLINE', 'TEXT', 'TEXT_TIME', 'TEXT_PRICE', 'IS_LONG', 'COLOUR',
    'P1_TIME', 'P1_PRICE', 'P2_TIME', 'P2_PRICE', 'STOP_LEVEL', 'PROFIT_LEVEL',
  ]),
});

const NO_ARGS = Object.freeze([]);

const CALLER_KEYS = Object.freeze({
  identity: NO_ARGS,
  discover: NO_ARGS,
  read_history: NO_ARGS,
  read_shapes: NO_ARGS,
  draw_trade: Object.freeze([
    'RUN_ID', 'UNVERIFIED', 'DEADLINE', 'IS_LONG', 'P1_TIME', 'P1_PRICE',
    'P2_TIME', 'P2_PRICE', 'TEXT_TIME', 'TEXT_PRICE', 'STOP_LEVEL', 'PROFIT_LEVEL',
  ]),
});

const READ_NAMES = Object.freeze(['identity', 'discover', 'read_history', 'read_shapes']);

const PATH_RE = /^\/chart\/[A-Za-z0-9]+\/$/;

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

export function buildLabel(runId, unverified) {
  if (!Object.hasOwn(RUN_COLOURS, runId)) {
    throw fail('E_ARGS', 'unknown run id');
  }
  if (typeof unverified !== 'boolean') {
    throw fail('E_ARGS', 'UNVERIFIED must be a boolean');
  }
  return unverified ? runId + ' BACKTEST UNVERIFIED' : runId + ' BACKTEST';
}

export function normalizeColour(raw) {
  if (typeof raw !== 'string') {
    return null;
  }
  const s = raw.trim().toLowerCase();
  const hex = /^#([0-9a-f]{6})$/.exec(s);
  if (hex) {
    return '#' + hex[1];
  }
  const m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})\s*(?:,\s*(\d+(?:\.\d+)?)\s*)?\)$/.exec(s);
  if (!m) {
    return null;
  }
  const parts = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (parts.some((v) => v > 255)) {
    return null;
  }
  const isRgba = s.startsWith('rgba(');
  const hasAlpha = m[4] !== undefined;
  if (isRgba !== hasAlpha) {
    return null;
  }
  if (hasAlpha && Number(m[4]) !== 1) {
    return null;
  }
  return '#' + parts.map((v) => v.toString(16).padStart(2, '0')).join('');
}

function validPrice(v) {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v * 4);
}

function validTime(v) {
  return Number.isInteger(v);
}

function validLevel(v) {
  return Number.isInteger(v) && v > 0;
}

export function prepareValues(name, callerArgs, ctx) {
  if (!Object.hasOwn(CALLER_KEYS, name)) {
    throw fail('E_ARGS', 'unknown template name');
  }
  if (typeof callerArgs !== 'object' || callerArgs === null) {
    throw fail('E_ARGS', 'args must be an object');
  }
  const want = CALLER_KEYS[name];
  const have = Object.keys(callerArgs);
  if (have.length !== want.length || want.some((k) => !have.includes(k))) {
    throw fail('E_ARGS', 'args keys do not match CALLER_KEYS for ' + name);
  }

  if (READ_NAMES.includes(name)) {
    if (!ctx || typeof ctx.guardPath !== 'string' || !PATH_RE.test(ctx.guardPath)) {
      throw fail('E_ARGS', 'guardPath must match /^\\/chart\\/[A-Za-z0-9]+\\/$/');
    }
    if (ctx.expectedRes !== '1' && ctx.expectedRes !== '15') {
      throw fail('E_ARGS', 'expectedRes must be "1" or "15"');
    }
    return Object.freeze({ GUARD_PATH: ctx.guardPath, EXPECTED_RES: ctx.expectedRes });
  }

  const a = callerArgs;
  if (!Object.hasOwn(RUN_COLOURS, a.RUN_ID)) {
    throw fail('E_ARGS', 'RUN_ID must be one of the three run ids');
  }
  if (typeof a.UNVERIFIED !== 'boolean') {
    throw fail('E_ARGS', 'UNVERIFIED must be a boolean');
  }
  if (typeof a.IS_LONG !== 'boolean') {
    throw fail('E_ARGS', 'IS_LONG must be a boolean');
  }
  if (!Number.isInteger(a.DEADLINE) || a.DEADLINE <= 0) {
    throw fail('E_ARGS', 'DEADLINE must be a positive integer (ms)');
  }
  for (const k of ['P1_TIME', 'P2_TIME', 'TEXT_TIME']) {
    if (!validTime(a[k])) {
      throw fail('E_ARGS', k + ' must be an integer');
    }
  }
  for (const k of ['P1_PRICE', 'P2_PRICE', 'TEXT_PRICE']) {
    if (!validPrice(a[k])) {
      throw fail('E_ARGS', k + ' must be a finite number on the 0.25 grid');
    }
  }
  for (const k of ['STOP_LEVEL', 'PROFIT_LEVEL']) {
    if (!validLevel(a[k])) {
      throw fail('E_ARGS', k + ' must be a positive integer');
    }
  }

  return Object.freeze({
    TEXT: buildLabel(a.RUN_ID, a.UNVERIFIED),
    COLOUR: RUN_COLOURS[a.RUN_ID],
    DEADLINE: a.DEADLINE,
    IS_LONG: a.IS_LONG,
    P1_TIME: a.P1_TIME,
    P1_PRICE: a.P1_PRICE,
    P2_TIME: a.P2_TIME,
    P2_PRICE: a.P2_PRICE,
    TEXT_TIME: a.TEXT_TIME,
    TEXT_PRICE: a.TEXT_PRICE,
    STOP_LEVEL: a.STOP_LEVEL,
    PROFIT_LEVEL: a.PROFIT_LEVEL,
  });
}

export function fillTemplate(text, names, values) {
  if (typeof text !== 'string') {
    throw fail('E_ARGS', 'template must be a string');
  }
  const re = /@@([A-Z_]+)@@/g;
  let out = '';
  let last = 0;
  let m = re.exec(text);
  while (m !== null) {
    const name = m[1];
    if (!names.includes(name)) {
      throw fail('E_ARGS', 'token ' + name + ' is not a placeholder of this template');
    }
    if (!Object.hasOwn(values, name)) {
      throw fail('E_ARGS', 'no value for ' + name);
    }
    out += text.slice(last, m.index) + JSON.stringify(values[name]);
    last = m.index + m[0].length;
    m = re.exec(text);
  }
  out += text.slice(last);
  if (out.includes('@@')) {
    throw fail('E_ARGS', 'filled template still contains @@');
  }
  return out;
}

// Fills text with the placeholder list of the named template. cdp.mjs and fake_chart.mjs call this, so
// cdp.mjs needs no computed lookup of PLACEHOLDERS (design line 137).
export function fillPlaceholders(name, text, values) {
  if (typeof name !== 'string' || !Object.hasOwn(PLACEHOLDERS, name)) {
    throw fail('E_ARGS', 'unknown template name');
  }
  return fillTemplate(text, PLACEHOLDERS[name], values);
}

export { TEMPLATES, PLACEHOLDERS, CALLER_KEYS, WRITE_GUARD, READ_GUARD, RUN_COLOURS };
