// Read-only chart reader for the combo tester. One Runtime.evaluate returns the symbol, the
// timeframe, the replay state, the main series bars and every study's plot titles and inputs,
// with data rows only for the wanted studies. Names enter the page only as JSON data.
// Nothing on the chart changes. The one call that is not a pure read asks the main series for
// older history, the same request the chart makes when you scroll left; the view does not move.
import CDP from 'chrome-remote-interface';

const MORE_BARS = 5000;

// In-page expression. wanted lists study names (name, short name or legend title) to return rows for.
export function buildReadExpr(wanted) {
  return `(() => {
  const wanted = ${JSON.stringify(JSON.stringify(wanted.map(String)))};
  const want = new Set(JSON.parse(wanted));
  const api = window.TradingViewApi;
  const chart = api._activeChartWidgetWV.value();
  const model = chart._chartWidget.model();
  const rows = (x) => { const p = []; for (let i = x.firstIndex(); i <= x.lastIndex(); i++) { const v = x.valueAt(i); if (v) p.push(Array.from(v, (a) => (typeof a === 'number' && isFinite(a) ? a : null))); } return p; };
  let replay = false;
  try { const v = api._replayApi.isReplayStarted(); replay = !!(v && typeof v.value === 'function' ? v.value() : v); } catch (e) { replay = true; }
  const studies = [];
  for (const s of model.model().dataSources()) {
    let mi = null;
    try { mi = s.metaInfo && s.metaInfo(); } catch (e) { mi = null; }
    if (!mi || !mi.plots || !mi.plots.length || typeof s.data !== 'function') continue;
    let title = null;
    try { title = s.title(); } catch (e) { title = null; }
    let inputs = null;
    try {
      const st = s.properties().childs().inputs.state();
      const keep = {};
      for (const k of Object.keys(st).sort()) if (!/^(text|pineFeatures|pineId|pineVersion|__.*)$/.test(k)) keep[k] = st[k];
      inputs = JSON.stringify(keep);
    } catch (e) { inputs = null; }
    const plots = mi.plots.map((p) => (mi.styles && mi.styles[p.id] && mi.styles[p.id].title) || null);
    const name = mi.description, short = mi.shortDescription;
    const d = s.data();
    const last = d.lastIndex() >= d.firstIndex() ? d.valueAt(d.lastIndex()) : null;
    const hit = want.has(name) || want.has(short) || want.has(title);
    const lastRow = last ? Array.from(last, (a) => (typeof a === 'number' && isFinite(a) ? a : null)) : null;
    studies.push({ name, short, title, inputs, plots, lastT: last ? last[0] : null, last: lastRow, rows: hit ? rows(d) : null });
  }
  let chartType = null;
  try { chartType = chart.chartType(); } catch (e) { chartType = null; }
  return { symbol: chart.symbol(), resolution: chart.resolution(), chartType, replay, bars: rows(model.mainSeries().bars()), studies };
})()`;
}

// Ask for older history, checked in the same page call: only when the chart shows the config
// symbol and timeframe and replay is off, so another agent's chart or replay is left alone.
export function buildMoreExpr(symbol, resolution) {
  return `(() => {
  const want = JSON.parse(${JSON.stringify(JSON.stringify([String(symbol), String(resolution)]))});
  const api = window.TradingViewApi;
  const chart = api._activeChartWidgetWV.value();
  let replay = true;
  try { const v = api._replayApi.isReplayStarted(); replay = !!(v && typeof v.value === 'function' ? v.value() : v); } catch (e) { replay = true; }
  if (replay || chart.symbol() !== want[0] || chart.resolution() !== want[1] || ![0, 1, 2, 3, 9].includes(chart.chartType())) return false;
  chart._chartWidget.model().mainSeries().requestMoreData(${MORE_BARS});
  return true;
})()`;
}

const REPLAY_EXPR = `(() => { try { const v = window.TradingViewApi._replayApi.isReplayStarted(); return !!(v && typeof v.value === 'function' ? v.value() : v); } catch (e) { return true; } })()`;

async function evaluate(client, expression) {
  const r = await client.Runtime.evaluate({ expression, returnByValue: true });
  if (r.exceptionDetails) throw new Error('chart read failed: ' + (r.exceptionDetails.exception?.description ?? r.exceptionDetails.text));
  return r.result?.value;
}

// Chart types whose bars are prices a trade could fill at: bars, candles, line, area, hollow candles.
export const PRICE_TYPES = [0, 1, 2, 3, 9];
const PAGE_EXPR = `(() => { const c = window.TradingViewApi._activeChartWidgetWV.value(); return { symbol: c.symbol(), resolution: c.resolution(), chartType: c.chartType() }; })()`;

// The first chart tab showing the config symbol and timeframe on a price chart type, else the
// first tab, so the cycle skips and logs why.
export function pickPage(pages, { symbol, resolution }) {
  return pages.find((p) => p.symbol === symbol && p.resolution === resolution && PRICE_TYPES.includes(p.chartType)) || pages[0];
}

async function choosePage(targets, port, want) {
  if (!want.symbol || targets.length < 2) return targets[0];
  const pages = [];
  for (const t of targets) {
    const c = await CDP({ port, target: t.id });
    try {
      pages.push({ id: t.id, ...(await evaluate(c, PAGE_EXPR)) });
    } catch {
      // a tab that cannot answer is not a candidate
    } finally {
      await c.close();
    }
  }
  const hit = pickPage(pages, want);
  return targets.find((t) => t.id === hit?.id) || targets[0];
}

// One read of a TradingView chart tab on port 9222, picked by pickPage. Adds replayAfter, a second
// replay check made after the read, so a replay started mid-read is caught. With symbol and
// resolution, asks for older history last (see buildMoreExpr).
export async function readChart(wanted, { symbol = null, resolution = null, port = 9222 } = {}) {
  const targets = (await CDP.List({ port })).filter((x) => x.type === 'page' && /tradingview\.com\/chart\//.test(x.url));
  if (!targets.length) throw new Error(`no TradingView chart page on port ${port}`);
  const page = await choosePage(targets, port, { symbol, resolution });
  const client = await CDP({ port, target: page.id });
  try {
    const raw = await evaluate(client, buildReadExpr(wanted));
    if (!raw || typeof raw !== 'object') throw new Error('chart read returned nothing');
    raw.replayAfter = await evaluate(client, REPLAY_EXPR);
    if (symbol && resolution) await evaluate(client, buildMoreExpr(symbol, resolution));
    return raw;
  } finally {
    await client.close();
  }
}
