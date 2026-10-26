// Tests for the replay collector helpers. Run: node --test scripts/mc_b_dot/collect.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isSettled, loadHistory } from './collect.mjs';

const ok = (extra = {}) => ({ ok: true, mainT: 6000, bLast: 99, bT: 6000, mainFirstT: 0, bFirstT: 0, srFirstT: 0, ...extra });

test('isSettled waits until both Market Cipher studies start at the first loaded bar', () => {
  assert.equal(isSettled([ok(), ok(), ok()]), true);
  assert.equal(isSettled([ok(), ok(), ok({ bFirstT: 600 })]), false, 'MarketCipher_B has not recalculated over the older bars');
  assert.equal(isSettled([ok(), ok(), ok({ srFirstT: 600 })]), false, 'MarketCipher_SR has not recalculated over the older bars');
});

// The chart serves 5000 more bars per request until it runs out of history at 15165.
function fakeChart(cap = 15165, step = 5000, start = 533) {
  let size = start;
  let pending = 0;
  return {
    calls: 0,
    probe: async () => { size = Math.min(cap, size + pending); pending = 0; return size; },
    request: async function () { this.calls++; pending = step; },
  };
}

test('loadHistory keeps asking for older bars until the chart stops growing', async () => {
  const c = fakeChart();
  const n = await loadHistory({ probe: c.probe, request: () => c.request(), sleep: async () => {} });
  assert.equal(n, 15165);
  assert.equal(c.calls, 4, 'three requests grow the chart, the fourth shows it is full');
});

test('loadHistory stops after maxCalls requests', async () => {
  const c = fakeChart(1e9);
  const n = await loadHistory({ probe: c.probe, request: () => c.request(), sleep: async () => {}, maxCalls: 2 });
  assert.equal(c.calls, 2);
  assert.equal(n, 10533);
});
