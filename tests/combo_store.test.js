/**
 * Tests for scripts/combo/store.js: merging chart reads into the bar store, the
 * atomic save, and the run lock. Uses a temp folder; nothing touches TradingView.
 *
 * Run: node --test tests/combo_store.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { mergeRead, loadStore, saveStore, acquireLock } from '../scripts/combo/store.js';

const S = 'CME_MINI:MES1!';
const b = (t, c, v = { k: 1 }) => ({ t, o: c, h: c, l: c, c, v });
const read = (bars, extra = {}) => ({ symbol: S, resolution: '5', inputs: { X: '{"in_0":1}' }, bars, ...extra });
const opts = (now) => ({ now, liveWindow: 1000 });

describe('mergeRead', () => {
  it('creates a store from the first read and marks only recent bars live', () => {
    const r = mergeRead(null, read([b(100, 1), b(5000, 2)]), opts(5500));
    assert.equal(r.skipped, undefined);
    assert.deepEqual(r.store.bars.map((x) => [x.t, x.seg, x.live]), [[100, 0, false], [5000, 0, true]]);
    assert.deepEqual(r.store.keys, ['k']);
    assert.equal(r.added, 2);
  });

  it('keeps stored values on overlap and appends newer bars', () => {
    const first = mergeRead(null, read([b(100, 1, { k: 1 }), b(200, 2, { k: 1 })]), opts(300)).store;
    const r = mergeRead(first, read([b(200, 2, { k: 9 }), b(300, 3, { k: 5 })]), opts(400));
    assert.deepEqual(r.store.bars.map((x) => [x.t, x.v.k]), [[100, 1], [200, 1], [300, 5]]);
    assert.equal(r.added, 1);
  });

  it('skips the read when an overlapping close differs, leaving the store as it was', () => {
    const first = mergeRead(null, read([b(100, 1), b(200, 2)]), opts(300)).store;
    const r = mergeRead(first, read([b(200, 2.25), b(300, 3)]), opts(400));
    assert.match(r.skipped, /history changed/);
    assert.equal(r.store, first);
  });

  it('starts a new segment when the read does not overlap the store', () => {
    const first = mergeRead(null, read([b(100, 1), b(200, 2)]), opts(300)).store;
    const r = mergeRead(first, read([b(900, 3), b(1000, 4)]), opts(1100));
    assert.deepEqual(r.store.bars.map((x) => x.seg), [0, 0, 1, 1]);
  });

  it('prepends older bars from a read that overlaps the store, as not live', () => {
    const first = mergeRead(null, read([b(300, 3), b(400, 4)]), opts(450)).store;
    const r = mergeRead(first, read([b(100, 1), b(200, 2), b(300, 3)]), opts(450));
    assert.deepEqual(r.store.bars.map((x) => [x.t, x.seg, x.live]), [[100, 0, false], [200, 0, false], [300, 0, true], [400, 0, true]]);
  });

  it('skips the read when study inputs or the symbol changed', () => {
    const first = mergeRead(null, read([b(100, 1)]), opts(200)).store;
    assert.match(mergeRead(first, read([b(200, 2)], { inputs: { X: '{"in_0":2}' } }), opts(300)).skipped, /inputs of X changed/);
    assert.match(mergeRead(first, read([b(200, 2)], { symbol: 'NQ1!' }), opts(300)).skipped, /symbol/);
  });

  it('adds a new key and fills it only on bars the read covers', () => {
    const first = mergeRead(null, read([b(100, 1, { k: 1 }), b(200, 2, { k: 1 })]), opts(300)).store;
    const r = mergeRead(first, read([b(200, 2, { k: 7, j: 4 }), b(300, 3, { k: 1, j: 5 })]), opts(400));
    assert.deepEqual(r.store.keys, ['k', 'j']);
    assert.deepEqual(r.store.bars.map((x) => [x.v.k, x.v.j]), [[1, null], [1, 4], [1, 5]]);
  });
});

describe('mergeRead regressions', () => {
  const store3 = () => {
    let s = mergeRead(null, read([b(100, 1), b(200, 2), b(300, 3)]), opts(350)).store;
    s = mergeRead(s, read([b(1000, 10), b(1100, 11)]), opts(1150)).store;
    return s;
  };

  it('fills bars that a later read places in the gap between segments, and joins the segments', () => {
    const r = mergeRead(store3(), read([200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200].map((t) => b(t, t / 100))), opts(1250));
    assert.equal(r.skipped, undefined);
    assert.deepEqual(r.store.bars.map((x) => x.t), [100, 200, 300, 400, 500, 600, 700, 800, 900, 1000, 1100, 1200]);
    assert.deepEqual([...new Set(r.store.bars.map((x) => x.seg))].length, 1);
  });

  it('updates values of bars that were loaded from history, but not of live bars', () => {
    const first = mergeRead(null, read([b(100, 1, { k: null }), b(5000, 2, { k: 1 })]), opts(5100)).store;
    const r = mergeRead(first, read([b(100, 1, { k: 4 }), b(5000, 2, { k: 9 }), b(5100, 3, { k: 1 })]), opts(5200));
    assert.deepEqual(r.store.bars.map((x) => x.v.k), [4, 1, 1]);
  });

  it('treats unreadable inputs as unknown instead of changed', () => {
    const first = mergeRead(null, read([b(100, 1)], { inputs: { X: null } }), opts(200)).store;
    const r = mergeRead(first, read([b(100, 1), b(200, 2)]), opts(300));
    assert.equal(r.skipped, undefined);
    assert.equal(r.store.inputs.X, '{"in_0":1}');
    assert.equal(mergeRead(r.store, read([b(200, 2), b(300, 3)], { inputs: { X: null } }), opts(400)).skipped, undefined);
  });

  it('merges into a store that has no bars yet', () => {
    const empty = mergeRead(null, read([]), opts(100)).store;
    const r = mergeRead(empty, read([b(100, 1)]), opts(200));
    assert.deepEqual(r.store.bars.map((x) => x.t), [100]);
  });

  it('skips the read when a bar inside a segment is missing or new, as after a session switch', () => {
    const s = mergeRead(null, read([b(100, 1), b(200, 2), b(300, 3), b(400, 4)]), opts(450)).store;
    assert.match(mergeRead(s, read([b(100, 1), b(300, 3), b(400, 4), b(500, 5)]), opts(550)).skipped, /history changed/);
    assert.match(mergeRead(s, read([b(100, 1), b(150, 1.5), b(200, 2), b(300, 3), b(400, 4)]), opts(450)).skipped, /history changed/);
  });
});

describe('mergeRead round 2 regressions', () => {
  it('does not let a read that starts later overwrite history values with its warm-up', () => {
    const first = mergeRead(null, read([b(100, 1, { k: 5 }), b(200, 2, { k: 6 }), b(300, 3, { k: 7 })]), opts(10000)).store;
    const r = mergeRead(first, read([b(200, 2, { k: null }), b(300, 3, { k: 8 })]), opts(10000));
    assert.deepEqual(r.store.bars.map((x) => x.v.k), [5, 6, 7]);
    const deeper = mergeRead(first, read([b(50, 0.5, { k: 1 }), b(100, 1, { k: 2 }), b(200, 2, { k: 3 })]), opts(10000));
    assert.deepEqual(deeper.store.bars.map((x) => x.v.k), [1, 2, 3, 7]);
  });

  it('takes a revised close on a few bars and drops their live flag instead of stopping', () => {
    const bars = Array.from({ length: 20 }, (_, i) => b(100 * (i + 1), i + 1));
    const first = mergeRead(null, read(bars), opts(2100)).store;
    const revised = bars.map((x) => (x.t === 2000 ? b(2000, 20.25) : x));
    const r = mergeRead(first, read(revised), opts(2100));
    assert.equal(r.skipped, undefined);
    const last = r.store.bars.find((x) => x.t === 2000);
    assert.deepEqual([last.c, last.live], [20.25, false]);
    const shifted = bars.map((x) => b(x.t, x.c + 0.25));
    assert.match(mergeRead(first, read(shifted), opts(2100)).skipped, /history changed/);
  });

  it('takes a revised close from a read that starts later without taking its warm-up values', () => {
    const bars = Array.from({ length: 20 }, (_, i) => b(100 * (i + 1), i + 1, { k: 5 }));
    const first = mergeRead(null, read(bars), opts(100000)).store;
    const later = bars.slice(1).map((x) => (x.t === 200 ? b(200, 2.25, { k: null }) : x));
    const bar = mergeRead(first, read(later), opts(100000)).store.bars.find((x) => x.t === 200);
    assert.deepEqual([bar.c, bar.v.k], [2.25, 5]);
  });

  it('keeps at most maxBars bars, dropping the oldest', () => {
    const r = mergeRead(null, read([b(100, 1), b(200, 2), b(300, 3), b(400, 4)]), { ...opts(500), maxBars: 3 });
    assert.deepEqual(r.store.bars.map((x) => x.t), [200, 300, 400]);
  });
});

describe('saveStore and loadStore', () => {
  it('round-trips the store and leaves no temp file behind', () => {
    const dir = mkdtempSync(join(tmpdir(), 'combo-'));
    const p = join(dir, 'store.json');
    const store = mergeRead(null, read([b(100, 1)]), opts(200)).store;
    saveStore(p, store);
    assert.deepEqual(loadStore(p), store);
    assert.deepEqual(readdirSync(dir), ['store.json']);
  });

  it('returns null for a missing store and throws on a corrupt one', () => {
    const dir = mkdtempSync(join(tmpdir(), 'combo-'));
    assert.equal(loadStore(join(dir, 'store.json')), null);
    writeFileSync(join(dir, 'store.json'), '{"bars": [');
    assert.throws(() => loadStore(join(dir, 'store.json')), /corrupt/);
  });
});

describe('acquireLock', () => {
  it('refuses a second run while the lock holder is alive, and takes over a stale lock', () => {
    const dir = mkdtempSync(join(tmpdir(), 'combo-'));
    const release = acquireLock(dir);
    assert.throws(() => acquireLock(dir), /another run/);
    release();
    assert.equal(existsSync(join(dir, 'lock')), false);
    writeFileSync(join(dir, 'lock'), '99999999');
    const release2 = acquireLock(dir);
    release2();
  });
});
