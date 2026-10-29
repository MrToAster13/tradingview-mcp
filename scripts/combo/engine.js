// Pure logic for the combo tester: config checks, signal lookup, signal checks, combinations,
// trades, stats and ranking. No CDP and no file access, so all of it runs under node --test.
// See docs/combo-tester.md for the rules this file implements.

const OPS = new Set(['>', '<', 'crosses_above', 'crosses_below', 'fires']);
const PRICES = new Set(['open', 'high', 'low', 'close']);
const PRICE_FIELD = { open: 'o', high: 'h', low: 'l', close: 'c' };
const TRAIN_SHARE = 0.7;
const MIN_TEST_TRADES = 30;
const SUBSET_MARGIN = 1.1;
const ALPHA = 0.05;
const CLOSEST = 5;

function fail(msg) {
  throw new Error(msg);
}

// Checked config with defaults filled in. Throws on the first problem.
export function parseConfig(c) {
  if (!c || typeof c !== 'object') fail('config must be a JSON object');
  if (typeof c.symbol !== 'string' || !c.symbol) fail('config needs a symbol, such as "CME_MINI:MES1!"');
  if (typeof c.resolution !== 'string' || !c.resolution) fail('config needs a resolution string, such as "5"');
  const horizon = c.horizon ?? 12;
  if (!Number.isInteger(horizon) || horizon < 1) fail(`horizon must be a whole number of bars, 1 or more, got ${c.horizon}`);
  const costPoints = c.costPoints ?? 0;
  if (typeof costPoints !== 'number' || !Number.isFinite(costPoints) || costPoints < 0) fail(`costPoints must be 0 or more, got ${c.costPoints}`);
  const maxSize = c.maxSize ?? 2;
  if (!Number.isInteger(maxSize) || maxSize < 1 || maxSize > 3) fail(`maxSize must be 1, 2 or 3, got ${c.maxSize}`);
  if (!Array.isArray(c.signals) || c.signals.length === 0) fail('config needs a non-empty signals list');
  const names = new Set();
  for (const s of c.signals) {
    if (!s || typeof s.name !== 'string' || !s.name) fail('every signal needs a name');
    if (names.has(s.name)) fail(`duplicate signal name "${s.name}"`);
    names.add(s.name);
    if (s.side !== 'bull' && s.side !== 'bear') fail(`signal "${s.name}": side must be "bull" or "bear"`);
    if (typeof s.study !== 'string' || !s.study) fail(`signal "${s.name}" needs a study`);
    if (typeof s.plot !== 'string' || !s.plot) fail(`signal "${s.name}" needs a plot`);
    if (!OPS.has(s.op)) fail(`signal "${s.name}": op must be one of ${[...OPS].join(', ')}`);
    if (s.op !== 'fires') {
      const hasValue = typeof s.value === 'number' && Number.isFinite(s.value);
      const hasRef = s.ref !== undefined;
      if (hasValue === hasRef) fail(`signal "${s.name}": op ${s.op} needs exactly one of value or ref`);
      const goodRef = typeof s.ref === 'string' || Boolean(s.ref && typeof s.ref === 'object' && typeof s.ref.study === 'string' && typeof s.ref.plot === 'string');
      if (hasRef && !goodRef) fail(`signal "${s.name}": ref must be a plot title, a price name, or { "study": ..., "plot": ... }`);
    }
  }
  return { ...c, horizon, costPoints, maxSize };
}

function findStudy(name, studies) {
  const hits = studies.filter((s) => s.name === name || s.short === name || s.title === name);
  if (hits.length === 0) fail(`no study named "${name}" on the chart`);
  if (hits.length > 1) fail(`"${name}" matches ${hits.length} studies; rename one in its settings`);
  return hits[0];
}

// Map each signal's plot and ref to a value key, and each key to a study row column.
// Columns follow the order of the study's plots, colorers included; column 0 is time.
export function resolveSignals(signals, studies) {
  const operands = new Map();
  const operand = (studyName, plot) => {
    const key = `${studyName}|${plot}`;
    if (!operands.has(key)) {
      const st = findStudy(studyName, studies);
      const idx = st.plots.map((p, i) => (p === plot ? i : -1)).filter((i) => i >= 0);
      if (idx.length === 0) fail(`no plot "${plot}" in study "${studyName}"`);
      if (idx.length > 1) fail(`study "${studyName}" has ${idx.length} plots titled "${plot}"`);
      operands.set(key, { key, study: studyName, col: idx[0] + 1 });
    }
    return key;
  };
  const out = signals.map((s) => {
    const a = operand(s.study, s.plot);
    let b = null;
    if (s.op !== 'fires') {
      if (s.ref === undefined) b = s.value;
      else if (typeof s.ref === 'string') b = PRICES.has(s.ref) ? s.ref : operand(s.study, s.ref);
      else b = operand(s.ref.study, s.ref.plot);
    }
    return { ...s, a, b };
  });
  return { signals: out, operands: [...operands.values()] };
}

function studiesFor(raw, resolved) {
  const names = [...new Set(resolved.operands.map((o) => o.study))];
  return Object.fromEntries(names.map((n) => [n, findStudy(n, raw.studies)]));
}

// Why a read cannot be used yet, or null. A study must have a row for the main series' last bar.
export function readProblem(raw, resolved) {
  const last = raw.bars.length ? raw.bars[raw.bars.length - 1][0] : null;
  if (last == null) return 'the chart has no bars';
  for (const [name, st] of Object.entries(studiesFor(raw, resolved))) {
    if (st.lastT !== last || !st.rows) return `${name} is not loaded up to the last bar`;
  }
  return null;
}

// Closed bars with the signal values joined by bar time. The last bar is still forming and is dropped.
export function extractBars(raw, resolved) {
  const studies = studiesFor(raw, resolved);
  const byTime = {};
  for (const [name, st] of Object.entries(studies)) {
    const m = new Map();
    for (const r of st.rows || []) m.set(r[0], r);
    byTime[name] = m;
  }
  const bars = raw.bars.slice(0, -1).map(([t, o, h, l, c]) => {
    const v = {};
    for (const op of resolved.operands) {
      const x = byTime[op.study].get(t)?.[op.col];
      v[op.key] = typeof x === 'number' && Number.isFinite(x) ? x : null;
    }
    return { t, o, h, l, c, v };
  });
  const inputs = Object.fromEntries(Object.entries(studies).map(([n, st]) => [n, st.inputs]));
  return { bars, inputs };
}

function val(x, bar) {
  if (typeof x === 'number') return x;
  if (PRICES.has(x)) return bar[PRICE_FIELD[x]];
  const v = bar.v[x];
  return typeof v === 'number' ? v : null;
}

// Whether a resolved signal is true on bar i. A missing value is never true.
export function evalSignal(s, bars, i) {
  const bar = bars[i];
  const a = val(s.a, bar);
  if (s.op === 'fires') return a !== null && a !== 0;
  const b = val(s.b, bar);
  if (a === null || b === null) return false;
  if (s.op === '>') return a > b;
  if (s.op === '<') return a < b;
  if (i === 0 || bars[i - 1].seg !== bar.seg) return false;
  const pa = val(s.a, bars[i - 1]);
  const pb = val(s.b, bars[i - 1]);
  if (pa === null || pb === null) return false;
  if (s.op === 'crosses_above') return pa <= pb && a > b;
  return pa >= pb && a < b;
}

// Every same-side combination of 1 to maxSize signals.
export function combos(signals, maxSize) {
  const out = [];
  for (const side of ['bull', 'bear']) {
    const list = signals.filter((s) => s.side === side);
    const walk = (start, picked) => {
      if (picked.length) out.push({ side, signals: picked, id: `${side}: ${picked.map((s) => s.name).join(' + ')}` });
      if (picked.length === maxSize) return;
      for (let i = start; i < list.length; i++) walk(i + 1, [...picked, list[i]]);
    };
    walk(0, []);
  }
  return out;
}

// Trades for one combination on bars [from, to). Signal on bar i, entry at the open of i+1,
// exit at the open of i+1+horizon. Entry, exit and signal must sit in one segment and the range.
export function simulate(combo, bars, { horizon, costPoints, from, to, accept = () => true }) {
  const trades = [];
  const dir = combo.side === 'bull' ? 1 : -1;
  let i = from;
  while (i + 1 + horizon < to) {
    const x = i + 1 + horizon;
    if (bars[x].seg === bars[i].seg && accept(bars[i]) && combo.signals.every((s) => evalSignal(s, bars, i))) {
      trades.push({ i, t: bars[i].t, r: dir * (bars[x].o - bars[i + 1].o) - costPoints });
      i = x;
    } else {
      i++;
    }
  }
  return trades;
}

export function stats(trades) {
  const n = trades.length;
  if (n === 0) return { n: 0, winRate: null, avg: null, pf: null, t: null };
  const rs = trades.map((x) => x.r);
  const avg = rs.reduce((a, b) => a + b, 0) / n;
  const gain = rs.filter((r) => r > 0).reduce((a, b) => a + b, 0);
  const loss = -rs.filter((r) => r < 0).reduce((a, b) => a + b, 0);
  const pf = loss === 0 ? (gain > 0 ? Infinity : null) : gain / loss;
  let t = null;
  if (n >= 2) {
    const sd = Math.sqrt(rs.reduce((a, r) => a + (r - avg) ** 2, 0) / (n - 1));
    if (sd > 1e-12) t = avg / (sd / Math.sqrt(n));
  }
  return { n, winRate: rs.filter((r) => r > 0).length / n, avg, pf, t };
}

// Inverse of the standard normal CDF (Acklam's rational approximation, error under 1.2e-9).
function invNorm(p) {
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const lo = 0.02425;
  if (p < lo) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1);
  }
  if (p > 1 - lo) return -invNorm(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
}

// The test t-stat a combination must reach when n combinations were tested (Bonferroni). With df,
// the t distribution quantile by the Cornish-Fisher expansion; without it, the normal quantile.
export function tCrit(n, df) {
  const z = invNorm(1 - ALPHA / n);
  if (!df) return z;
  return z + (z ** 3 + z) / (4 * df) + (5 * z ** 5 + 16 * z ** 3 + 3 * z) / (96 * df ** 2);
}

// Test every combination on the store. state.firstSurvived maps a combination id to the last bar
// time of the cycle it first survived; it is never reset. Returns the leaderboard and new state.
export function evaluate(config, store, state = {}) {
  const bars = store.bars;
  const split = Math.floor(bars.length * TRAIN_SHARE);
  const all = combos(config.signals, config.maxSize);
  const bar = all.length ? tCrit(all.length, MIN_TEST_TRADES - 1) : Infinity;
  const lastT = bars.length ? bars[bars.length - 1].t : null;
  const firstSurvived = { ...(state.firstSurvived || {}) };
  const sim = (c, from, to, accept) => stats(simulate(c, bars, { horizon: config.horizon, costPoints: config.costPoints, from, to, accept }));

  const passed = [];
  const failed = [];
  for (const c of all) {
    const train = sim(c, 0, split);
    const test = sim(c, split, bars.length);
    const ok = test.n >= MIN_TEST_TRADES && train.avg > 0 && test.avg > 0 && test.t !== null && test.t >= tCrit(all.length, test.n - 1);
    (ok ? passed : failed).push({ c, train, test });
  }
  const closest = failed.filter((p) => p.test.t !== null).sort((x, y) => y.test.t - x.test.t).slice(0, CLOSEST)
    .map(({ c, train, test }) => ({ id: c.id, side: c.side, size: c.signals.length, signals: c.signals.map((s) => s.name), train, test }));
  passed.sort((x, y) => y.test.t - x.test.t);
  const names = (p) => new Set(p.c.signals.map((s) => s.name));
  const kept = passed.filter((p) => {
    const mine = names(p);
    return !passed.some((q) => {
      const theirs = names(q);
      if (theirs.size >= mine.size || ![...theirs].every((n) => mine.has(n))) return false;
      return p.test.avg < SUBSET_MARGIN * q.test.avg;
    });
  });

  const survivors = kept.map(({ c, train, test }) => {
    if (firstSurvived[c.id] === undefined) firstSurvived[c.id] = lastT;
    const since = firstSurvived[c.id];
    const forward = sim(c, 0, bars.length, (b) => b.live && b.t > since);
    return { id: c.id, side: c.side, size: c.signals.length, signals: c.signals.map((s) => s.name), train, test, firstSurvived: since, forward };
  });

  const board = {
    symbol: store.symbol, resolution: store.resolution, updated: lastT,
    bars: bars.length, trainBars: split, testBars: bars.length - split,
    liveBars: bars.filter((b) => b.live).length,
    combosTested: all.length, tBar: bar, horizon: config.horizon, costPoints: config.costPoints,
    survivors, closest,
  };
  return { board, state: { firstSurvived } };
}

const num = (x, d = 2) => (x === null || x === undefined ? '-' : x === Infinity ? 'inf' : x.toFixed(d));
const pct = (x) => (x === null ? '-' : `${Math.round(x * 100)}%`);
const when = (t) => (t === null ? '-' : new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ') + ' UTC');

export function renderMarkdown(board) {
  const lines = [
    `# Combo tester: ${board.symbol} ${board.resolution}`,
    '',
    `Updated: ${when(board.updated)}. Bars stored: ${board.bars} (train ${board.trainBars}, test ${board.testBars}, live ${board.liveBars}).`,
    `Combinations tested: ${board.combosTested}. Test t-stat bar at ${MIN_TEST_TRADES} trades: ${num(board.tBar)}, a little lower with more trades. Exit after ${board.horizon} bars, cost ${board.costPoints} points.`,
    '',
  ];
  if (!board.survivors.length) {
    lines.push(`No combination survives yet. A survivor needs ${MIN_TEST_TRADES} test trades, a positive average in train and test, and a test t-stat of at least ${num(board.tBar)}.`);
  } else {
    lines.push('| Rank | Combination | Test trades | Test win | Test avg pts | Test PF | Test t | Train avg pts | Forward trades | Forward avg pts | Survived since |');
    lines.push('| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |');
    board.survivors.forEach((s, i) => {
      lines.push(`| ${i + 1} | ${s.id} | ${s.test.n} | ${pct(s.test.winRate)} | ${num(s.test.avg)} | ${num(s.test.pf)} | ${num(s.test.t)} | ${num(s.train.avg)} | ${s.forward.n} | ${num(s.forward.avg)} | ${when(s.firstSurvived)} |`);
    });
    lines.push('', 'Train and test numbers include bars loaded from history, which a repainting indicator may have changed. Forward numbers use only live bars stored after the combination first survived.');
  }
  if (board.closest?.length) {
    lines.push('', '## Closest, not passing yet', '', '| Combination | Test trades | Test win | Test avg pts | Test PF | Test t | Train avg pts |', '| --- | --- | --- | --- | --- | --- | --- |');
    for (const s of board.closest) {
      lines.push(`| ${s.id} | ${s.test.n} | ${pct(s.test.winRate)} | ${num(s.test.avg)} | ${num(s.test.pf)} | ${num(s.test.t)} | ${num(s.train.avg)} |`);
    }
  }
  return lines.join('\n') + '\n';
}
