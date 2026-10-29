#!/usr/bin/env node
// Combo tester loop: read the chart, merge closed bars into the store, test every combination,
// write the leaderboard, sleep, repeat. It only reads the chart. See docs/combo-tester.md.
// Usage: node scripts/combo/run.js --config my-signals.json --out combo-data [--every 15] [--once]
//        node scripts/combo/run.js --list
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseConfig, resolveSignals, extractBars, readProblem, evaluate, renderMarkdown } from './engine.js';
import { mergeRead, loadStore, saveStore, acquireLock } from './store.js';
import { readChart } from './read.js';

const USAGE = 'usage: node scripts/combo/run.js --config FILE --out DIR [--every MINUTES] [--once]\n       node scripts/combo/run.js --list';

export function parseArgs(argv) {
  const o = { config: null, out: null, every: 15, once: false, list: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--once') o.once = true;
    else if (a === '--list') o.list = true;
    else if (a === '--config' || a === '--out' || a === '--every') {
      const v = argv[i + 1];
      if (v === undefined || v.startsWith('--')) throw new Error(`${a} needs a value`);
      if (a === '--every') {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) throw new Error(`--every must be a number of minutes above 0, got ${v}`);
        o.every = n;
      } else {
        o[a.slice(2)] = v;
      }
      i++;
    } else {
      throw new Error(`unknown option ${a}`);
    }
  }
  if (o.list) return o;
  if (!o.config) throw new Error('--config FILE is required');
  if (!o.out) throw new Error('--out DIR is required');
  return o;
}

const PRICE_TYPES = new Set([0, 1, 2, 3, 9]); // bars, candles, line, area, hollow candles
const READ_TIMEOUT_MS = 60000;

// JSON with Infinity written as "inf", which JSON.stringify would turn into null.
export function toJson(v) {
  return JSON.stringify(v, (k, x) => (x === Infinity ? 'inf' : x));
}

export function withTimeout(promise, ms) {
  let timer;
  const t = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`chart read timed out after ${ms} ms`)), ms); });
  return Promise.race([promise, t]).finally(() => clearTimeout(timer));
}

const writeJson = (path, v) => writeFileSync(path, toJson(v));

// One cycle. read() returns the raw chart read; now() is unix seconds. Returns { skipped } or
// { added, survivors }. A skipped cycle writes nothing.
export async function runCycle({ config: rawConfig, out, read, now, every, log }) {
  const config = parseConfig(rawConfig);
  const skip = (why) => {
    log(`skip: ${why}`);
    return { skipped: why };
  };
  const raw = await read([...new Set(config.signals.flatMap((s) => [s.study, s.ref?.study].filter(Boolean)))]);
  if (raw.replay || raw.replayAfter) return skip('bar replay is running');
  if (raw.symbol !== config.symbol) return skip(`chart shows ${raw.symbol}, config wants ${config.symbol}`);
  if (raw.resolution !== config.resolution) return skip(`chart timeframe is ${raw.resolution}, config wants ${config.resolution}`);
  if (raw.chartType != null && !PRICE_TYPES.has(raw.chartType)) return skip(`chart type ${raw.chartType} changes prices; use bars, candles, hollow candles, line or area`);
  const resolved = resolveSignals(config.signals, raw.studies);
  const problem = readProblem(raw, resolved);
  if (problem) return skip(problem);

  const { bars, inputs } = extractBars(raw, resolved);
  const statePath = join(out, 'state.json');
  const storePath = join(out, 'store.json');
  const merged = mergeRead(loadStore(storePath), { symbol: raw.symbol, resolution: raw.resolution, inputs, bars }, { now: now(), liveWindow: 2 * every * 60 + barSeconds(bars) });
  if (merged.skipped) return skip(merged.skipped);

  const { board, state } = evaluate({ ...config, signals: resolved.signals }, merged.store, loadStore(statePath) || {});
  mkdirSync(out, { recursive: true });
  saveStore(storePath, merged.store);
  saveStore(statePath, state);
  writeJson(join(out, 'leaderboard.json'), board);
  writeFileSync(join(out, 'leaderboard.md'), renderMarkdown(board));
  log(`stored ${merged.store.bars.length} bars (+${merged.added}), ${board.combosTested} combinations, ${board.survivors.length} survivors`);
  return { added: merged.added, survivors: board.survivors.length };
}

// Smallest gap between neighbouring bars, in seconds.
function barSeconds(bars) {
  let min = Infinity;
  for (let i = 1; i < bars.length; i++) min = Math.min(min, bars[i].t - bars[i - 1].t);
  return Number.isFinite(min) ? min : 0;
}

// Run cycle() forever (or cycles times, for tests). An error is logged and the loop goes on.
export async function runLoop({ cycle, sleep, log, cycles = Infinity }) {
  for (let n = 0; n < cycles; n++) {
    try {
      await cycle();
    } catch (e) {
      log(`cycle failed: ${e.message}`);
    }
    if (n + 1 < cycles) await sleep();
  }
}

const stamp = () => new Date().toISOString().slice(0, 19).replace('T', ' ');
const log = (m) => console.log(`${stamp()} ${m}`);

async function list() {
  const raw = await readChart([]);
  console.log(`${raw.symbol} ${raw.resolution}${raw.replay ? ' (replay running)' : ''}`);
  for (const s of raw.studies) {
    const names = [...new Set([s.name, s.short, s.title].filter(Boolean))].map((n) => JSON.stringify(n)).join(' / ');
    console.log(`\nstudy ${names}`);
    s.plots.forEach((p, i) => { if (p) console.log(`  plot ${JSON.stringify(p)}  last value ${s.last ? s.last[i + 1] : '-'}`); });
  }
}

async function main(args) {
  if (args.list) return list();
  const config = JSON.parse(readFileSync(args.config, 'utf8'));
  parseConfig(config);
  const out = resolve(args.out);
  mkdirSync(out, { recursive: true });
  const release = acquireLock(out);
  process.on('exit', release);
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
  const read = (wanted) => withTimeout(readChart(wanted, { symbol: config.symbol, resolution: config.resolution }), READ_TIMEOUT_MS);
  const cycle = () => runCycle({ config, out, read, now: () => Math.floor(Date.now() / 1000), every: args.every, log });
  await runLoop({ cycle, sleep: () => new Promise((r) => setTimeout(r, args.every * 60000)), log, cycles: args.once ? 1 : Infinity });
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
