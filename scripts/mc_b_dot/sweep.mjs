// Exit sweep for the MC B dot strategy (mc_b_dot_strategy.pine) on 1-minute futures charts.
// Pure functions over prepared bar rows; read.mjs produces the input.
//
// Entry matches the Pine strategy: a dot confirmed on bar close, filled at the next bar's open.
// Exits are a stop and a target fixed at the signal, checked from the fill bar onward with
// TradingView's broker-emulator rule: a bar whose open is nearer its high goes open, high, low,
// close; otherwise open, low, high, close. A bar that opens past an exit fills at its open.
//
// Target modes: free1..free9 (Nth free Cipher level beyond the close), freeR<K> (first free
// Cipher level at least K times the risk away), live (the Cipher level plotted on the signal
// bar), pivot (the MC SR pivot), r<K> (K times the risk). minRR skips a signal whose target is
// nearer than minRR times the risk, like the Pine input.
// Stop modes:   swing<N> (extreme of the last N bars), free1..free9, live and pivot on the
// other side of the close. Every stop sits stopTicks (default 1) past its level or extreme.
// spec is the contract: tick size, dollars per point and the round-trip fee. The default is MES.
// fromT and toT (bar times) limit which signal bars count, so overlapping replay windows can be
// simulated one at a time without counting a signal twice. A trade may run past toT.
// Prices are compared in whole ticks, so a 0.1-tick contract fills on an exact touch.

export const MES = { tick: 0.25, pointValue: 5, fee: 1 };

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

// bars: [t, o, h, l, c, ...]; b: MarketCipher_B rows; sr: MarketCipher_SR rows. Index 0 is time.
export function prepare({ bars, b, sr }) {
  const bt = new Map(b.map((r) => [r[0], r]));
  const st = new Map(sr.map((r) => [r[0], r]));
  return bars.map(([t, o, h, l, c]) => {
    const x = bt.get(t) || [];
    const y = st.get(t) || [];
    return {
      t, o, h, l, c,
      mf: num(x[4]), wave: num(x[2]), up: num(x[7]), dn: num(x[8]),
      ph: num(y[1]), pl: num(y[2]), res: num(y[4]), sup: num(y[5]),
    };
  });
}

const fired = (v) => v !== null && v !== 0;

function mfOk(mf, side, mode, level) {
  if (mf === null) return false;
  if (mode === 'either') return Math.abs(mf) > level;
  if (mode === 'with') return side === 1 ? mf > level : mf < -level;
  if (mode === 'against') return side === 1 ? mf < -level : mf > level;
  throw new Error('unknown money-flow mode ' + mode);
}

export function signals(s, { mfMode = 'either', mfLevel = 25, waveLimit = 45 } = {}) {
  mfOk(0, 1, mfMode, 0);
  const out = [];
  s.forEach((r, i) => {
    const w = r.wave;
    if (w !== null && fired(r.up) && w < 0 && w >= -waveLimit && mfOk(r.mf, 1, mfMode, mfLevel)) out.push({ i, side: 1 });
    if (w !== null && fired(r.dn) && w > 0 && w <= waveLimit && mfOk(r.mf, -1, mfMode, mfLevel)) out.push({ i, side: -1 });
  });
  return out;
}

// Free Cipher levels after each bar, as the Pine script tracks them: a later bar that trades
// through a level uses it up, then any newly plotted Res or Sup value is added. A row from
// grid.mjs stitch compares with its own window's previous row (ownPrev), not the series' one.
// Returns a function from bar index to the sorted distinct levels after that bar.
const levelCache = new WeakMap();
function levelTimeline(s, maxLevels = 200) {
  const key = levelCache.get(s);
  if (key && key.maxLevels === maxLevels) return key.at;
  const snaps = new Array(s.length);
  let lv = [];
  s.forEach((r, i) => {
    if (r.seedLevels) {
      lv = [...lv, ...r.seedLevels.filter((p) => !lv.some((x) => x.p === p)).map((p) => ({ p, bar: i - 1 }))];
      if (lv.length > maxLevels) lv = lv.slice(-maxLevels);
    }
    lv = lv.filter((x) => !(x.bar < i && r.l <= x.p && r.h >= x.p));
    const prev = r.ownPrev !== undefined ? r.ownPrev : i > 0 ? s[i - 1] : null;
    for (const k of ['res', 'sup']) {
      const v = r[k];
      if (v !== null && v !== (prev && prev[k] !== null ? prev[k] : 0)) {
        lv.push({ p: v, bar: i });
        if (lv.length > maxLevels) lv.shift();
      }
    }
    snaps[i] = lv;
  });
  const at = (i) => [...new Set(snaps[i].map((x) => x.p))].sort((a, z) => a - z);
  levelCache.set(s, { maxLevels, at });
  return at;
}

export const levelsAfter = (s, i, maxLevels) => levelTimeline(s, maxLevels)(i);

// Price helpers for one contract. fromTicks trims float noise, so 27952 ticks of 0.1 is 2795.2.
function pricer(tick) {
  const toTicks = (p) => Math.round(p / tick);
  const fromTicks = (n) => Number((n * tick).toFixed(10));
  return { tick, toTicks, fromTicks };
}

// Nth distinct level strictly beyond price in direction dir (1 = above, -1 = below).
function nthBeyond(levels, price, dir, n) {
  const beyond = dir === 1 ? levels.filter((x) => x > price) : levels.filter((x) => x < price).reverse();
  return beyond.length >= n ? beyond[n - 1] : null;
}

function levelFor(mode, s, i, dir, at) {
  const r = s[i];
  const m = /^free(\d)$/.exec(mode);
  if (m) {
    if (Number(m[1]) < 1) throw new Error('unknown level mode ' + mode);
    return nthBeyond(at(i), r.c, dir, Number(m[1]));
  }
  const v = mode === 'live' ? (dir === 1 ? r.res : r.sup) : mode === 'pivot' ? (dir === 1 ? r.ph : r.pl) : undefined;
  if (v === undefined) throw new Error('unknown level mode ' + mode);
  return v !== null && (dir === 1 ? v > r.c : v < r.c) ? v : null;
}

function stopFor(sl, s, i, side, at, px, offset) {
  const m = /^swing(\d+)$/.exec(sl);
  if (m) {
    if (Number(m[1]) < 1) throw new Error('unknown stop mode ' + sl);
    const from = Math.max(0, i - Number(m[1]) + 1);
    const win = s.slice(from, i + 1);
    const ext = side === 1 ? Math.min(...win.map((r) => r.l)) : Math.max(...win.map((r) => r.h));
    return px.fromTicks(px.toTicks(ext) - side * offset);
  }
  const lvl = levelFor(sl, s, i, -side, at);
  return lvl === null ? null : px.fromTicks(px.toTicks(lvl) - side * offset);
}

function targetFor(tp, s, i, side, stop, at, px) {
  const c = s[i].c;
  const risk = Math.abs(px.toTicks(c) - px.toTicks(stop));
  const m = /^r(\d+(?:\.\d+)?)$/.exec(tp);
  if (m) return px.fromTicks(px.toTicks(c) + side * Math.floor(Number(m[1]) * risk + 1e-9));
  const f = /^freeR(\d+(?:\.\d+)?)$/.exec(tp);
  if (f) {
    const need = Number(f[1]) * risk - 1e-9;
    const beyond = side === 1 ? at(i).filter((x) => x > c) : at(i).filter((x) => x < c).reverse();
    return beyond.find((x) => Math.abs(px.toTicks(x) - px.toTicks(c)) >= need) ?? null;
  }
  return levelFor(tp, s, i, side, at);
}

// Pine rrOk: with minRR > 0 the target must sit at least minRR times the risk from the close.
function rrOk(c, stop, target, minRR, px) {
  const risk = Math.abs(px.toTicks(c) - px.toTicks(stop));
  return !minRR || (risk > 0 && Math.abs(px.toTicks(target) - px.toTicks(c)) >= minRR * risk - 1e-9);
}

// Exit on bar r for an open position, or null.
function exitOn(r, p, px) {
  const { side, stop, target } = p;
  const st = px.toTicks(stop);
  const tg = px.toTicks(target);
  const pastStop = (x) => (side === 1 ? px.toTicks(x) <= st : px.toTicks(x) >= st);
  const pastTarget = (x) => (side === 1 ? px.toTicks(x) >= tg : px.toTicks(x) <= tg);
  if (pastStop(r.o)) return { exit: r.o, reason: 'stop' };
  if (pastTarget(r.o)) return { exit: r.o, reason: 'target' };
  const highFirst = r.h - r.o < r.o - r.l;
  const path = highFirst ? [r.h, r.l] : [r.l, r.h];
  for (const x of path) {
    if (pastStop(x)) return { exit: stop, reason: 'stop' };
    if (pastTarget(x)) return { exit: target, reason: 'target' };
  }
  return null;
}

export function simulate(s, {
  mfMode = 'either', tp, sl, minRR = 0, mfLevel, waveLimit, maxLevels,
  spec = MES, stopTicks = 1, fromT = -Infinity, toT = Infinity,
} = {}) {
  const px = pricer(spec.tick);
  const netOf = (side, entry, exit) => side * (px.toTicks(exit) - px.toTicks(entry)) * spec.tick * spec.pointValue - spec.fee;
  const at = levelTimeline(s, maxLevels);
  const bySignal = new Map();
  for (const g of signals(s, { mfMode, mfLevel, waveLimit })) {
    if (s[g.i].t < fromT || s[g.i].t >= toT) continue;
    if (!bySignal.has(g.i)) bySignal.set(g.i, []);
    bySignal.get(g.i).push(g.side);
  }
  const trades = [];
  const skipped = { busy: 0, no_stop: 0, no_target: 0 };
  let pos = null;
  let pending = null;
  const close = (i, exit, reason) => {
    trades.push({ ...pos, exitI: i, exitT: s[i].t, exit, reason, net: netOf(pos.side, pos.entry, exit) });
    pos = null;
  };
  for (let i = 0; i < s.length; i++) {
    const r = s[i];
    if (pending) {
      pos = { ...pending, entryI: i, entryT: r.t, entry: r.o };
      pending = null;
    }
    if (pos) {
      const x = exitOn(r, pos, px);
      if (x) close(i, x.exit, x.reason);
    }
    for (const side of bySignal.get(i) || []) {
      if (pos || pending) { skipped.busy++; continue; }
      const stop = stopFor(sl, s, i, side, at, px, stopTicks);
      if (stop === null) { skipped.no_stop++; continue; }
      const target = targetFor(tp, s, i, side, stop, at, px);
      const wrongSide = target !== null && (side === 1 ? px.toTicks(target) <= px.toTicks(r.c) : px.toTicks(target) >= px.toTicks(r.c));
      if (target === null || wrongSide || !rrOk(r.c, stop, target, minRR, px)) { skipped.no_target++; continue; }
      if (i + 1 < s.length) pending = { side, signalI: i, stop, target };
    }
  }
  if (pos) close(s.length - 1, s[s.length - 1].c, 'open');
  return { trades, skipped };
}

export function summarize(trades) {
  const closed = trades.filter((t) => t.reason !== 'open');
  const wins = closed.filter((t) => t.net > 0);
  const losses = closed.filter((t) => t.net <= 0);
  const sum = (a) => a.reduce((x, t) => x + t.net, 0);
  const grossProfit = sum(wins);
  const grossLoss = -sum(losses);
  let eq = 0;
  let peak = 0;
  let maxDD = 0;
  for (const t of closed) {
    eq += t.net;
    peak = Math.max(peak, eq);
    maxDD = Math.max(maxDD, peak - eq);
  }
  return {
    trades: closed.length,
    wins: wins.length,
    winRate: closed.length ? wins.length / closed.length : null,
    net: sum(closed),
    grossProfit,
    grossLoss,
    pf: grossLoss > 0 ? grossProfit / grossLoss : null,
    avgWin: wins.length ? grossProfit / wins.length : null,
    avgLoss: losses.length ? -grossLoss / losses.length : null,
    maxDD,
    open: trades.length - closed.length,
  };
}

export function sweep(s, { mfModes, tps, sls, splitT, ...rest }) {
  const rows = [];
  for (const mfMode of mfModes) {
    for (const tp of tps) {
      for (const sl of sls) {
        const { trades, skipped } = simulate(s, { mfMode, tp, sl, ...rest });
        rows.push({
          mfMode, tp, sl, skipped,
          all: summarize(trades),
          train: summarize(trades.filter((t) => t.entryT < splitT)),
          test: summarize(trades.filter((t) => t.entryT >= splitT)),
          tradeList: trades,
        });
      }
    }
  }
  return rows;
}
