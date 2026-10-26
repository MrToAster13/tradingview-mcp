// Walk one symbol back through replay windows on the 1-minute chart and save each window as JSON.
// Each window first asks the chart for all the older bars it will serve (about 15000 on 1m).
// Usage: node scripts/mc_b_dot/collect.mjs <outDir> --symbol EXCH:SYM [--max 12] [--overlap 400]
//   --max      total windows to save, including the live window 0 (default 12)
//   --overlap  bars of overlap between neighbouring windows (default 400)
// Each file is <outDir>/<windowName>.json in the same shape read.mjs writes.
// It only reads the chart and moves replay; it never draws or removes studies.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { openChartClient, readChart } from './read.mjs';
import { replayPointFromBars, windowName, shouldStop } from './chartdata.mjs';
import { setSymbol, setTimeframe } from '../../src/core/chart.js';
import * as replay from '../../src/core/replay.js';
import { disconnect } from '../../src/connection.js';

const USAGE = 'usage: node scripts/mc_b_dot/collect.mjs <outDir> --symbol EXCH:SYM [--max 12] [--overlap 400]';
const BAR_SECONDS = 60;
const SETTLE_POLLS = 3;
const SETTLE_TIMEOUT_MS = 90000;
const POLL_MS = 1000;
const MORE_BARS = 5000;
const MAX_MORE_CALLS = 20;
const GROW_POLLS = 8;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function intArg(name, v, min) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) throw new Error(`${name} must be an integer ${min} or more, got ${v}`);
  return n;
}

export function parseCollectArgs(argv) {
  const positional = [];
  const o = { symbol: null, max: 12, overlap: 400 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--symbol' || a === '--max' || a === '--overlap') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--symbol') o.symbol = v;
      else if (a === '--max') o.max = intArg('--max', v, 1);
      else o.overlap = intArg('--overlap', v, 0);
      i++;
    } else if (a.startsWith('--')) {
      throw new Error(`unknown option ${a}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) throw new Error('expected exactly one output directory');
  if (!o.symbol) throw new Error('--symbol EXCH:SYM is required');
  return { outDir: positional[0], ...o };
}

// In-page probe of the loading state. Reports the chart symbol, the main series last bar time,
// the MarketCipher_B last index and last row time, and the first row time of the main series and
// both studies. ok is false until everything is present.
export function loadStateExpr(symbol) {
  return `(() => {
  try {
    const chart = window.TradingViewApi._activeChartWidgetWV.value();
    if (chart.symbol() !== ${JSON.stringify(symbol)}) return { ok: false, why: 'chart shows ' + chart.symbol() };
    const model = chart._chartWidget.model();
    const main = model.mainSeries().bars();
    if (main.lastIndex() < main.firstIndex()) return { ok: false, why: 'no main bars yet' };
    const mainLast = main.valueAt(main.lastIndex());
    if (!mainLast) return { ok: false, why: 'main last bar missing' };
    const src = {};
    for (const s of model.model().dataSources()) { const d = s.metaInfo && s.metaInfo().description; if (d && !src[d]) src[d] = s; }
    const b = src['MarketCipher_B'], sr = src['MarketCipher_SR'];
    if (!b || !sr) return { ok: false, why: 'MarketCipher studies not loaded' };
    const bd = b.data(), sd = sr.data();
    if (sd.lastIndex() < sd.firstIndex()) return { ok: false, why: 'MarketCipher_SR has no rows yet' };
    if (bd.lastIndex() < bd.firstIndex()) return { ok: false, why: 'MarketCipher_B has no rows yet' };
    const bLast = bd.valueAt(bd.lastIndex());
    if (!bLast) return { ok: false, why: 'MarketCipher_B last row missing' };
    const firstT = (x) => { const v = x.valueAt(x.firstIndex()); return v ? v[0] : null; };
    return { ok: true, mainT: mainLast[0], bLast: bd.lastIndex(), bT: bLast[0], mainFirstT: firstT(main), bFirstT: firstT(bd), srFirstT: firstT(sd) };
  } catch (e) {
    return { ok: false, why: String((e && e.message) || e) };
  }
})()`;
}

// Settled when the last SETTLE_POLLS samples are all ok, share one MarketCipher_B lastIndex,
// the MarketCipher_B last row is within 2 bars of the main series last bar, and both studies start
// at the main series' first bar, so they have recalculated over any older bars just loaded.
export function isSettled(samples) {
  if (samples.length < SETTLE_POLLS) return false;
  const last = samples.slice(-SETTLE_POLLS);
  if (!last.every((s) => s && s.ok && s.bLast === last[0].bLast)) return false;
  const s = last[last.length - 1];
  return Math.abs(s.bT - s.mainT) <= 2 * BAR_SECONDS && s.bFirstT === s.mainFirstT && s.srFirstT === s.mainFirstT;
}

// Poll once a second until the chart is settled on the wanted symbol, or time out.
export async function waitForLoaded(client, symbol, { timeoutMs = SETTLE_TIMEOUT_MS, pollMs = POLL_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  const samples = [];
  let last = null;
  while (Date.now() < deadline) {
    const r = await client.Runtime.evaluate({ expression: loadStateExpr(symbol), returnByValue: true });
    last = r.result?.value ?? { ok: false, why: 'no value from page' };
    samples.push(last);
    if (samples.length > SETTLE_POLLS) samples.shift();
    if (isSettled(samples)) return last;
    await sleep(pollMs);
  }
  throw new Error(`chart did not settle within ${timeoutMs / 1000} s; last state ${JSON.stringify(last)}`);
}

// Ask the chart for older bars until it stops growing. probe() returns the loaded bar count and
// request() asks for more. After each request it polls up to growPolls times for the count to rise;
// no rise means the chart has all the history it will serve. Returns the final count.
export async function loadHistory({ probe, request, sleep: wait = sleep, maxCalls = MAX_MORE_CALLS, growPolls = GROW_POLLS, pollMs = POLL_MS }) {
  let size = await probe();
  for (let call = 0; call < maxCalls; call++) {
    await request();
    let grown = false;
    for (let p = 0; p < growPolls && !grown; p++) {
      await wait(pollMs);
      const now = await probe();
      if (now > size) { size = now; grown = true; }
    }
    if (!grown) break;
  }
  return size;
}

const SERIES = 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries()';

// Load all the history the chart will serve, then wait for the studies to recalculate over it.
async function loadAll(client, symbol) {
  await waitForLoaded(client, symbol);
  const ev = (expression) => client.Runtime.evaluate({ expression, returnByValue: true });
  await loadHistory({
    probe: async () => (await ev(`${SERIES}.bars().size()`)).result?.value ?? 0,
    request: () => ev(`${SERIES}.requestMoreData(${MORE_BARS})`),
  });
  await waitForLoaded(client, symbol);
}

// Live window, no replay. Refuses if replay is somehow still on.
async function readLive(client, symbol) {
  await loadAll(client, symbol);
  const data = await readChart(client, { symbol, resolution: '1' });
  if (data.meta.replay) throw new Error('live read reports replay is on; stop replay and retry');
  return data;
}

// One replay window: start at fromMs, wait, read, and always stop replay afterwards.
async function readReplayWindow(client, symbol, fromMs) {
  try {
    await replay.start({ date: new Date(fromMs).toISOString() });
    await loadAll(client, symbol);
    const data = await readChart(client, { symbol, resolution: '1' });
    if (!data.meta.replay) {
      throw new Error('replay window read reports replay is not started; refusing to save live data as a replay window');
    }
    return data;
  } finally {
    await replay.stop({});
  }
}

const iso = (t) => new Date(t * 1000).toISOString();

function saveWindow(outDir, symbol, data) {
  const { firstT, lastT } = data.meta;
  const name = windowName(symbol, firstT, lastT);
  writeFileSync(join(outDir, `${name}.json`), JSON.stringify(data));
  console.log(`${name}  bars ${data.bars.length}  first ${iso(firstT)}  last ${iso(lastT)}`);
  return name;
}

async function collect({ outDir, symbol, max, overlap }) {
  mkdirSync(outDir, { recursive: true });
  const client = await openChartClient();
  try {
    await replay.stop({});
    await setSymbol({ symbol });
    await setTimeframe({ timeframe: '1' });

    let last = await readLive(client, symbol);
    if (last.meta.firstT == null) throw new Error('live chart has no bars');
    saveWindow(outDir, symbol, last);
    let written = 1;

    while (written < max) {
      const next = await readReplayWindow(client, symbol, replayPointFromBars(last.bars, overlap));
      if (shouldStop({ prevFirstT: last.meta.firstT, firstT: next.meta.firstT, windows: written, maxWindows: max })) {
        const why = next.meta.firstT == null
          ? 'replay window has no bars'
          : `first bar did not move back (${iso(next.meta.firstT)} is not before ${iso(last.meta.firstT)}); the loaded history may be shorter than the overlap`;
        console.log(`stop after ${written} windows: ${why}`);
        break;
      }
      saveWindow(outDir, symbol, next);
      written++;
      last = next;
    }
    console.log(`done: ${written} windows in ${resolve(outDir)}`);
  } finally {
    try { await replay.stop({}); } catch (e) { console.error(`replay stop failed: ${e.message}`); }
    try { await disconnect(); } catch {}
    await client.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let args;
  try {
    args = parseCollectArgs(process.argv.slice(2));
  } catch (e) {
    console.error(`${e.message}\n${USAGE}`);
    process.exit(2);
  }
  collect(args).catch((e) => {
    console.error(`error: ${e.message}`);
    process.exit(1);
  });
}
