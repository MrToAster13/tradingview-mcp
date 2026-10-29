// The combo tester's bar store: merging chart reads, the atomic save, and the run lock.
// A store is { version, symbol, resolution, keys, inputs, bars }, bars oldest first, each
// { t, o, h, l, c, seg, live, v: { key: value } }. See docs/combo-tester.md, "The store".
import { readFileSync, writeFileSync, renameSync, openSync, closeSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MAX_BARS = 200000;
const REVISED_SHARE = 0.1;

// Merge one read ({ symbol, resolution, inputs, bars: closed bars }) into the store. Returns
// { store, added } or { store: the old store, skipped: reason }. Never changes the old store.
// A bar is live when it is appended within liveWindow seconds of now.
//
// Live bars keep their stored values. Bars loaded from history take a new read's values only
// when that read starts at or before the read that wrote them (from), so warm-up at the old edge
// of an earlier read is replaced once more history loads, and a shorter read never damages it.
// A few revised closes (up to REVISED_SHARE of the overlap) are taken, and those bars stop being live.
// Inside the time span of the read, every stored bar must be in the read, and a new bar may
// only fall in a gap between segments; anything else means history changed.
// Two neighbouring bars share a segment when they were neighbours in the store or in this read.
export function mergeRead(store, read, { now, liveWindow, maxBars = MAX_BARS }) {
  const isLive = (t) => now - t <= liveWindow;
  const readKeys = [...new Set(read.bars.flatMap((b) => Object.keys(b.v)))];
  const skip = (skipped) => ({ store, skipped });
  if (store && (read.symbol !== store.symbol || read.resolution !== store.resolution)) {
    return skip(`symbol or timeframe is ${read.symbol} ${read.resolution}, the store holds ${store.symbol} ${store.resolution}`);
  }
  const inputs = { ...(store?.inputs || {}) };
  for (const [name, inp] of Object.entries(read.inputs)) {
    if (inp == null) continue;
    if (inputs[name] != null && inputs[name] !== inp) return skip(`inputs of ${name} changed; start a new --out folder`);
    inputs[name] = inp;
  }
  if (!store || store.bars.length === 0) {
    const keys = [...new Set([...(store?.keys || []), ...readKeys])];
    const from = read.bars.length ? read.bars[0].t : null;
    const bars = read.bars.map((b) => ({ ...b, v: Object.fromEntries(keys.map((k) => [k, b.v[k] ?? null])), seg: 0, live: isLive(b.t), from })).slice(-maxBars);
    return { store: { version: 1, symbol: read.symbol, resolution: read.resolution, keys, inputs, bars }, added: bars.length };
  }
  if (!read.bars.length) return { store, added: 0 };

  const stored = new Map(store.bars.map((b, i) => [b.t, i]));
  const inRead = new Map(read.bars.map((b) => [b.t, b]));
  const lo = read.bars[0].t;
  const hi = read.bars[read.bars.length - 1].t;
  const changed = (t, why) => skip(`history changed at bar ${t} (${why}): a roll, back-adjust or session switch; start a new --out folder`);
  const revised = new Set();
  let overlap = 0;
  for (let i = 0; i < store.bars.length; i++) {
    const s = store.bars[i];
    if (s.t < lo || s.t > hi) continue;
    const r = inRead.get(s.t);
    if (!r) return changed(s.t, 'the chart no longer has this bar');
    overlap++;
    if (r.c !== s.c) revised.add(s.t);
  }
  if (revised.size > REVISED_SHARE * overlap) {
    const t = [...revised][0];
    return changed(t, `close ${store.bars[stored.get(t)].c} now ${inRead.get(t).c}, ${revised.size} of ${overlap} bars differ`);
  }
  let next = 0;
  for (const r of read.bars) {
    if (stored.has(r.t)) continue;
    while (next < store.bars.length && store.bars[next].t < r.t) next++;
    const before = store.bars[next - 1];
    const after = store.bars[next];
    if (before && after && before.seg === after.seg) return changed(r.t, 'a new bar inside a stored stretch');
  }
  if (hi < store.bars[0].t) return skip('the read is older than the store and does not touch it');

  const newKeys = readKeys.filter((k) => !store.keys.includes(k));
  const keys = [...store.keys, ...newKeys];
  const fill = (v) => Object.fromEntries(keys.map((k) => [k, v[k] ?? null]));
  const lastT = store.bars[store.bars.length - 1].t;
  const merged = [];
  const times = [...new Set([...stored.keys(), ...inRead.keys()])].sort((a, b) => a - b);
  let added = 0;
  let seg = 0;
  let prev = null;
  for (const t of times) {
    const i = stored.get(t);
    const s = i === undefined ? null : store.bars[i];
    const r = inRead.get(t) || null;
    let bar;
    if (s && r && revised.has(t)) {
      const take = lo <= (s.from ?? Infinity);
      bar = { ...s, o: r.o, h: r.h, l: r.l, c: r.c, v: take ? { ...fill(s.v), ...r.v } : fill(s.v), live: false, from: take ? lo : s.from };
    } else if (s && s.live) {
      const v = fill(s.v);
      if (r) for (const k of newKeys) v[k] = r.v[k] ?? null;
      bar = { ...s, v };
    } else if (s) {
      const take = r && lo <= (s.from ?? Infinity);
      bar = take ? { ...s, v: { ...fill(s.v), ...r.v }, from: lo } : { ...s, v: fill(s.v) };
    } else {
      bar = { ...r, v: fill(r.v), live: t > lastT && isLive(t), from: lo };
      added++;
    }
    if (prev) {
      const together = (prev.s && s && prev.s.seg === s.seg) || (prev.r && r);
      if (!together) seg++;
    }
    merged.push({ ...bar, seg });
    prev = { s, r };
  }
  return { store: { ...store, keys, inputs, bars: merged.slice(-maxBars) }, added };
}

// The stored store, or null when there is none yet. A file that does not parse throws, so a
// half-written store never gets replaced by an empty one.
export function loadStore(path) {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (e) {
    throw new Error(`store ${path} is corrupt (${e.message}); move it aside to start over`);
  }
}

// Write to a temp file next to the target, then rename over it.
export function saveStore(path, store) {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(store));
  renameSync(tmp, path);
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// Take dir/lock for this process. Throws when another live process holds it; a lock left by a
// dead process is taken over. Returns a function that releases the lock.
export function acquireLock(dir) {
  const path = join(dir, 'lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(path, 'wx');
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return () => {
        try { unlinkSync(path); } catch { /* already gone */ }
      };
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      const pid = Number(readFileSync(path, 'utf8'));
      if (Number.isInteger(pid) && pid > 0 && alive(pid)) throw new Error(`another run (pid ${pid}) holds ${path}`);
      unlinkSync(path);
    }
  }
  throw new Error(`could not take ${path}`);
}
