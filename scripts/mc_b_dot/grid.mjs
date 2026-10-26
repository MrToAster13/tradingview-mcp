// Per-instrument parameter grid for the MC B dot exit sweep (sweep.mjs).
// Pure helpers first, then a CLI that reads a folder of replay window files and writes one JSON report.
//
// Replay windows overlap by a few hundred bars and each window's indicators restart, so a window owns
// the bars from its own fromT (after its warm-up) up to the next newer window's fromT. runWindows
// stitches the windows into one series, taking each bar from its owner, and simulates one account.
// Train and test split each instrument at one bar time (splitTimeOf), the same for every grid row.
// pickBest ranks on train only.
//
// Usage: node grid.mjs <dataDir> <outJson> [--warmup 300] [--train 0.6] [--min-trades 30] [--fee 1]

import { readdirSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { prepare, simulate, summarize, levelsAfter } from './sweep.mjs';

export const DEFAULT_GRID = {
  mfMode: ['with', 'either'],
  mfLevel: [20, 23, 25],
  waveLimit: [45],
  tp: ['free1', 'free2', 'freeR1', 'freeR1.5', 'r1', 'r1.5', 'r2', 'r3'],
  sl: ['swing5', 'swing10', 'swing20', 'free1'],
  stopTicks: [0, 1],
  minRR: [0],
};

// The user's own rule, evaluated on every symbol whether or not it wins the grid.
export const REFERENCE_RULE = { mfMode: 'with', mfLevel: 23, tp: 'free1', sl: 'swing10', stopTicks: 0 };

const SECONDS_PER_BAR = 60;
const NO_SKIPS = { busy: 0, no_stop: 0, no_target: 0 };

// Each window gets fromT = its first bar after the warm-up, and toT = the next newer window's fromT
// (Infinity for the newest). With bar times (meta.times) the warm-up counts bars, so a weekend or the
// daily break inside it does not shorten it; a window no longer than its warm-up gets fromT Infinity.
// Without times the warm-up counts clock minutes from firstT.
export function windowRanges(metas, warmupBars) {
  if (!Number.isInteger(warmupBars) || warmupBars < 0) throw new Error(`warm-up must be a whole number of bars, 0 or more, got ${warmupBars}`);
  for (const m of metas) {
    if (!Number.isFinite(m?.firstT)) throw new Error('window meta has no finite firstT');
  }
  const sorted = [...metas].sort((a, b) => a.firstT - b.firstT);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k].firstT === sorted[k - 1].firstT) throw new Error(`two windows share firstT ${sorted[k].firstT}`);
  }
  const shift = warmupBars * SECONDS_PER_BAR;
  const fromOf = (m) => (Array.isArray(m.times) ? (m.times.length > warmupBars ? m.times[warmupBars] : Infinity) : m.firstT + shift);
  return sorted.map((m, k) => ({
    ...m,
    fromT: fromOf(m),
    toT: k + 1 < sorted.length ? fromOf(sorted[k + 1]) : Infinity,
  }));
}

// One series from overlapping windows. Each bar time takes its row from the window that owns it
// (fromT <= t < toT) when that window has the bar, else from the window with the most bars before
// it, so the indicators there have warmed up the longest. Signals count from the oldest fromT to the
// newest toT. Each row carries ownPrev, the previous row of its own window, so a seam between two
// windows whose Cipher plots differ does not read as a newly plotted level. A row where the owning
// window changes also carries seedLevels, that window's own free levels up to the bar before. They
// join the free list, so a level both windows hold free survives the seam. src[i] is the window
// row i came from. Cached per windows array and rebuilt when any window's s, fromT or toT changes.
const stitchCache = new WeakMap();
const stitchKey = (windows) => windows.map((w) => [w.s, w.s.length, w.fromT, w.toT]);
const sameKey = (a, b) => a.length === b.length && a.every((x, k) => x.every((v, j) => v === b[k][j]));
export function stitch(windows) {
  const key = stitchKey(windows);
  const hit = stitchCache.get(windows);
  if (hit && sameKey(hit.key, key)) return hit.out;
  const idx = windows.map((w) => new Map(w.s.map((r, j) => [r.t, j])));
  const times = [...new Set(windows.flatMap((w) => w.s.map((r) => r.t)))].sort((a, b) => a - b);
  const src = [];
  const s = times.map((t) => {
    let pick = -1;
    for (let k = 0; k < windows.length; k++) {
      if (!idx[k].has(t)) continue;
      if (t >= windows[k].fromT && t < windows[k].toT) { pick = k; break; }
      if (pick < 0 || idx[k].get(t) > idx[pick].get(t)) pick = k;
    }
    const seam = src.length > 0 && src[src.length - 1] !== pick;
    src.push(pick);
    const j = idx[pick].get(t);
    const row = { ...windows[pick].s[j], ownPrev: j > 0 ? windows[pick].s[j - 1] : null };
    if (seam && j > 0) row.seedLevels = levelsAfter(windows[pick].s, j - 1);
    return row;
  });
  const froms = windows.map((w) => w.fromT).filter(Number.isFinite);
  const out = {
    s,
    src,
    fromT: froms.length ? Math.min(...froms) : Infinity,
    toT: windows.length ? Math.max(...windows.map((w) => w.toT)) : -Infinity,
  };
  stitchCache.set(windows, { key, out });
  return out;
}

// Counted bar times whose row comes from a window that has not finished its warm-up there. This
// happens when neighbouring windows overlap by less than the warm-up.
export function coldTimes(windows) {
  const st = stitch(windows);
  return st.s
    .filter((r, i) => r.t >= st.fromT && r.t < st.toT && r.t < windows[st.src[i]].fromT)
    .map((r) => r.t);
}

// One account over the stitched series. A trade still open at the end of the data is dropped.
export function runWindows(windows, opts = {}) {
  const st = stitch(windows);
  if (st.s.length === 0) return { trades: [], skipped: { ...NO_SKIPS } };
  const r = simulate(st.s, { ...opts, fromT: st.fromT, toT: st.toT });
  return { trades: r.trades.filter((t) => t.reason !== 'open'), skipped: r.skipped };
}

// The first frac of trades by count (after sorting by entry time) is train; the rest is test.
export function splitByTime(trades, frac) {
  if (!(frac >= 0 && frac <= 1)) throw new Error(`train fraction must be between 0 and 1, got ${frac}`);
  const sorted = [...trades].sort((a, b) => a.entryT - b.entryT);
  const k = Math.floor(frac * sorted.length + 1e-9);
  const test = sorted.slice(k);
  return { train: sorted.slice(0, k), test, splitT: test.length ? test[0].entryT : null };
}

// One split time per symbol: the bar time at the frac share of the stitched bars that count
// signals. Every grid row then tests on the same span. null when nothing is left for test.
export function splitTimeOf(windows, frac) {
  if (!(frac >= 0 && frac <= 1)) throw new Error(`train fraction must be between 0 and 1, got ${frac}`);
  const st = stitch(windows);
  const times = st.s.map((r) => r.t).filter((t) => t >= st.fromT && t < st.toT);
  const k = Math.floor(frac * times.length + 1e-9);
  return k < times.length ? times[k] : null;
}

// Trades entering before splitT are train, the rest test. A null splitT puts everything in train.
export function splitAt(trades, splitT) {
  const sorted = [...trades].sort((a, b) => a.entryT - b.entryT);
  if (splitT === null) return { train: sorted, test: [], splitT };
  return { train: sorted.filter((t) => t.entryT < splitT), test: sorted.filter((t) => t.entryT >= splitT), splitT };
}

// Cartesian product of the grid axes. The first key changes slowest, and keys keep grid order.
export function combos(grid) {
  let out = [{}];
  for (const key of Object.keys(grid)) {
    if (!Array.isArray(grid[key])) throw new Error(`grid axis ${key} must be an array`);
    const next = [];
    for (const base of out) {
      for (const v of grid[key]) next.push({ ...base, [key]: v });
    }
    out = next;
  }
  return out;
}

// Best row by train[by] (default pf), with train net breaking ties. Test numbers are never read.
export function pickBest(rows, { minTrades = 0, by = 'pf' } = {}) {
  const eligible = rows.filter((r) => r.train.trades >= minTrades && typeof r.train.pf === 'number' && Number.isFinite(r.train.pf));
  const rank = (r) => {
    const v = r.train[by];
    return typeof v === 'number' && !Number.isNaN(v) ? v : -Infinity;
  };
  let best = null;
  for (const r of eligible) {
    if (best === null) { best = r; continue; }
    const a = rank(r);
    const b = rank(best);
    if (a > b || (a === b && r.train.net > best.train.net)) best = r;
  }
  return best;
}

// Contract spec for the simulator. The tick is minmov / pricescale, rounded to 10 decimals.
export function specFor(meta, fee) {
  const m = meta || {};
  const need = (name, v, ok = (x) => true) => {
    if (typeof v !== 'number' || !Number.isFinite(v) || !ok(v)) {
      throw new Error(`${m.symbol ?? 'contract'}: missing or invalid ${name}`);
    }
    return v;
  };
  const minmov = need('minmov', m.minmov, (x) => x > 0);
  const pricescale = need('pricescale', m.pricescale, (x) => x > 0);
  const pointValue = need('pointvalue', m.pointvalue, (x) => x > 0);
  need('fee', fee, (x) => x >= 0);
  return { tick: Number((minmov / pricescale).toFixed(10)), pointValue, fee };
}

// ---- runner ----------------------------------------------------------------------

// One grid point: run every window, split the trades, and summarize each part.
function evaluate(windows, params, spec, splitT) {
  const { trades, skipped } = runWindows(windows, { ...params, spec });
  const split = splitAt(trades, splitT);
  return {
    params,
    trades: trades.length,
    all: summarize(trades),
    train: summarize(split.train),
    test: summarize(split.test),
    splitT: split.splitT,
    skipped,
  };
}

function loadWindowFiles(dir) {
  const files = readdirSync(dir).filter((f) => f.endsWith('.json')).sort();
  if (files.length === 0) throw new Error(`no .json window files in ${dir}`);
  return files.map((file) => {
    const j = JSON.parse(readFileSync(join(dir, file), 'utf8'));
    if (!j.meta || !Array.isArray(j.bars) || !Array.isArray(j.b) || !Array.isArray(j.sr)) {
      throw new Error(`${file} is not a window file (needs meta, bars, b and sr)`);
    }
    if (!j.meta.symbol) throw new Error(`${file} has no meta.symbol`);
    return { file, meta: j.meta, bars: j.bars, b: j.b, sr: j.sr };
  });
}

function runSymbol(symbol, wins, opts) {
  const specs = wins.map((w) => specFor(w.meta, opts.fee));
  const spec = specs[0];
  for (const s of specs) {
    if (s.tick !== spec.tick || s.pointValue !== spec.pointValue) throw new Error(`${symbol}: windows disagree on the contract spec`);
  }
  const prepared = new Map(wins.map((w) => [w.file, prepare(w)]));
  const ranges = windowRanges(wins.map((w) => ({ ...w.meta, file: w.file, times: prepared.get(w.file).map((r) => r.t) })), opts.warmupBars);
  const windows = ranges.map((r) => ({ s: prepared.get(r.file), fromT: r.fromT, toT: r.toT }));
  const cold = coldTimes(windows);
  if (cold.length) {
    throw new Error(`${symbol}: ${cold.length} bars between windows sit only in a window's warm-up (first ${new Date(cold[0] * 1000).toISOString()}); collect with --overlap at least the --warmup`);
  }
  const splitT = splitTimeOf(windows, opts.trainFrac);
  const rows = combos(DEFAULT_GRID).map((params) => evaluate(windows, params, spec, splitT));
  return {
    spec,
    splitT,
    windows: ranges.map((r) => ({
      file: r.file,
      firstT: r.firstT,
      lastT: r.lastT ?? null,
      fromT: r.fromT,
      toT: Number.isFinite(r.toT) ? r.toT : null,
      bars: prepared.get(r.file).length,
    })),
    bars: stitch(windows).s.length,
    best: pickBest(rows, { minTrades: opts.minTrades, by: 'pf' }),
    reference: evaluate(windows, REFERENCE_RULE, spec, splitT),
    rows,
  };
}

const f2 = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toFixed(2) : 'n/a');
const part = (p) => `trades ${String(p.trades).padStart(4)}  net ${f2(p.net).padStart(10)}  pf ${f2(p.pf).padStart(6)}`;

function parseArgs(argv) {
  const pos = [];
  const opt = {};
  const known = new Set(['warmup', 'train', 'min-trades', 'fee']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const key = a.slice(2);
    if (!known.has(key)) throw new Error(`unknown option ${a}`);
    if (argv[i + 1] === undefined) throw new Error(`missing value for ${a}`);
    opt[key] = argv[++i];
  }
  if (pos.length !== 2) {
    throw new Error('usage: node grid.mjs <dataDir> <outJson> [--warmup 300] [--train 0.6] [--min-trades 30] [--fee 1]');
  }
  const num = (key, dflt) => {
    if (opt[key] === undefined) return dflt;
    const v = String(opt[key]).trim() === '' ? NaN : Number(opt[key]);
    if (!Number.isFinite(v)) throw new Error(`--${key} must be a number, got ${opt[key]}`);
    return v;
  };
  return {
    dir: pos[0],
    out: pos[1],
    warmupBars: (() => {
      const v = num('warmup', 300);
      if (!Number.isInteger(v) || v < 0) throw new Error(`--warmup must be a whole number of bars, 0 or more, got ${opt.warmup}`);
      return v;
    })(),
    trainFrac: num('train', 0.6),
    minTrades: num('min-trades', 30),
    fee: num('fee', 1),
  };
}

function main(argv) {
  const args = parseArgs(argv);
  const files = loadWindowFiles(args.dir);
  const bySymbol = new Map();
  for (const w of files) {
    if (!bySymbol.has(w.meta.symbol)) bySymbol.set(w.meta.symbol, []);
    bySymbol.get(w.meta.symbol).push(w);
  }
  const symbols = {};
  for (const [symbol, wins] of bySymbol) {
    symbols[symbol] = runSymbol(symbol, wins, args);
    const s = symbols[symbol];
    console.log(`${symbol}  ${wins.length} windows, ${s.bars} bars, tick ${s.spec.tick}`);
    if (s.best) {
      console.log(`  best       ${JSON.stringify(s.best.params)}`);
      console.log(`    train    ${part(s.best.train)}`);
      console.log(`    test     ${part(s.best.test)}`);
    } else {
      console.log(`  best       none (no row with train trades >= ${args.minTrades} and a profit factor)`);
    }
    console.log(`  reference  ${JSON.stringify(s.reference.params)}`);
    console.log(`    train    ${part(s.reference.train)}`);
    console.log(`    test     ${part(s.reference.test)}`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    settings: {
      warmupBars: args.warmupBars,
      trainFrac: args.trainFrac,
      minTrades: args.minTrades,
      fee: args.fee,
      by: 'pf',
      grid: DEFAULT_GRID,
      reference: REFERENCE_RULE,
    },
    symbols,
  };
  mkdirSync(dirname(args.out), { recursive: true });
  writeFileSync(args.out, JSON.stringify(report, null, 2));
  console.log(`wrote ${args.out}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
