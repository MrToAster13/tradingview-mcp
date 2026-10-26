// Read-only dump of the loaded chart history for the exit sweep.
// Usage: node scripts/mc_b_dot/read.mjs <out.json> [--symbol EXCH:SYM] [--resolution 1]
// Writes { bars, b, sr, orders, meta } where bars/b/sr are raw data rows (index 0 is time) of the
// main series, MarketCipher_B and MarketCipher_SR, orders is the MC B Dot Strategy's filled-order
// list for the parity check, and meta holds the symbol, resolution, contract spec fields
// (minmov, pricescale, pointvalue, currency), whether bar replay is running, and the first and
// last bar times. Without --symbol any symbol is accepted. It reads only; nothing on the chart changes.
import { writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import CDP from 'chrome-remote-interface';

const USAGE = 'usage: node scripts/mc_b_dot/read.mjs <out.json> [--symbol EXCH:SYM] [--resolution 1]';

export function parseArgs(argv) {
  const positional = [];
  let symbol = null;
  let resolution = '1';
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--symbol' || a === '--resolution') {
      const v = argv[i + 1];
      if (!v || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--symbol') symbol = v;
      else resolution = v;
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) throw new Error('expected exactly one output path');
  return { out: positional[0], symbol, resolution };
}

// In-page expression. Returns the data object, or a string starting with E_ on a refusal.
// symbol null means any symbol. resolution must match the chart's resolution.
export function buildReadExpr({ symbol = null, resolution = '1' } = {}) {
  return `(() => {
  const chart = window.TradingViewApi._activeChartWidgetWV.value();
  const wantSymbol = ${JSON.stringify(symbol)};
  const wantRes = ${JSON.stringify(String(resolution))};
  if ((wantSymbol !== null && chart.symbol() !== wantSymbol) || chart.resolution() !== wantRes) {
    return 'E_CHART ' + chart.symbol() + ' ' + chart.resolution() + ' (wanted ' + (wantSymbol ?? 'any') + ' ' + wantRes + ')';
  }
  const rows = (x) => { const p = []; for (let i = x.firstIndex(); i <= x.lastIndex(); i++) { const v = x.valueAt(i); if (v) p.push(v.map((a) => (Number.isFinite(a) ? a : null))); } return p; };
  const model = chart._chartWidget.model();
  const src = {};
  for (const s of model.model().dataSources()) { const d = s.metaInfo && s.metaInfo().description; if (d && !src[d]) src[d] = s; }
  const b = src['MarketCipher_B'], sr = src['MarketCipher_SR'], st = src['MC B Dot Strategy (1m)'];
  if (!b || !sr) return 'E_NOSTUDY';
  let orders = null;
  try { const o = st && st.ordersData(); orders = o && typeof o.value === 'function' ? o.value() : o; } catch (e) { orders = null; }
  const mainBars = rows(model.mainSeries().bars());
  let info = null;
  try { info = model.mainSeries().symbolInfo(); } catch (e) { info = null; }
  const pick = (k) => { try { const v = info && info[k]; return v === undefined ? null : v; } catch (e) { return null; } };
  let replay = false;
  try { const v = window.TradingViewApi._replayApi.isReplayStarted(); replay = !!(v && typeof v.value === 'function' ? v.value() : v); } catch (e) { replay = false; }
  const meta = {
    symbol: chart.symbol(), resolution: chart.resolution(),
    minmov: pick('minmov'), pricescale: pick('pricescale'), pointvalue: pick('pointvalue'), currency: pick('currency_code'),
    replay,
    firstT: mainBars.length ? mainBars[0][0] : null,
    lastT: mainBars.length ? mainBars[mainBars.length - 1][0] : null,
  };
  return { bars: mainBars, b: rows(b.data()), sr: rows(sr.data()), orders, meta };
})()`;
}

// Parsed chart data from an open CDP client. Throws on refusals (E_ strings) and read errors.
export async function readChart(client, { symbol = null, resolution = '1' } = {}) {
  const r = await client.Runtime.evaluate({ expression: buildReadExpr({ symbol, resolution }), returnByValue: true });
  const v = r.result?.value;
  if (typeof v === 'string' && v.startsWith('E_')) throw new Error(v);
  if (!v || typeof v !== 'object') {
    throw new Error('read failed: ' + (r.exceptionDetails?.exception?.description ?? String(v)));
  }
  return v;
}

// Attach to the first TradingView chart page on port 9222.
export async function openChartClient() {
  const targets = await CDP.List({ port: 9222 });
  const page = targets.find((x) => x.type === 'page' && /tradingview\.com\/chart\//.test(x.url));
  if (!page) throw new Error('no TradingView chart page on port 9222');
  return CDP({ port: 9222, target: page.id });
}

async function main(args) {
  const client = await openChartClient();
  try {
    const v = await readChart(client, args);
    writeFileSync(args.out, JSON.stringify(v));
    const orders = v.orders ? v.orders.length : 'none';
    console.log(`bars ${v.bars.length}, b ${v.b.length}, sr ${v.sr.length}, orders ${orders}, replay ${v.meta.replay} -> ${args.out}`);
  } finally {
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  main(args).catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
}
