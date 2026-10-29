/**
 * Tests for scripts/watchdog/desk_watch.js, the desktop watchdog Hermes runs every
 * 5 minutes. Every probe and side effect is injected; nothing here touches
 * TradingView, processes, the disk or the network.
 *
 * Run: node --test tests/watchdog.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  lastStoredAgeMin, checkTester, checkDevice, checkTradingView, diffEvents, runWatch,
  pidAlive, parseState, RUN_BUDGET_MS,
} from '../scripts/watchdog/desk_watch.js';

const at = (iso) => Date.parse(iso + 'Z');
const LOG = [
  '2026-10-29 10:00:00 stored 11328 bars (+30), 16 combinations, 0 survivors',
  '2026-10-29 10:15:00 skip: chart timeframe is 5, config wants 1',
  '2026-10-29 10:30:00 cycle failed: chart read timed out after 60000 ms',
].join('\n');

describe('lastStoredAgeMin', () => {
  it('measures from the last successful cycle, ignoring newer skip and failure lines', () => {
    assert.equal(lastStoredAgeMin(LOG, at('2026-10-29T10:51:00')), 51);
  });

  it('is null when the log has no successful cycle', () => {
    assert.equal(lastStoredAgeMin('2026-10-29 10:15:00 skip: replay', at('2026-10-29T10:20:00')), null);
    assert.equal(lastStoredAgeMin('', at('2026-10-29T10:20:00')), null);
  });
});

describe('checkTester', () => {
  const base = { lockPid: 42, alive: () => true, logText: LOG, staleMin: 35, restart: () => { throw new Error('no restart expected'); } };

  it('is stale when the last stored cycle is older than the limit, even with newer log lines', () => {
    const r = checkTester({ ...base, now: at('2026-10-29T10:40:00') });
    assert.equal(r.state, 'stale');
    assert.match(r.msg, /no successful cycle for 40 minutes/);
  });

  it('is ok when a stored cycle is recent', () => {
    assert.equal(checkTester({ ...base, now: at('2026-10-29T10:20:00') }).state, 'ok');
  });

  it('restarts the tester when the lock holder is dead or there is no lock', () => {
    let started = 0;
    const restart = () => { started++; return 777; };
    const dead = checkTester({ ...base, alive: () => false, restart, now: at('2026-10-29T10:20:00') });
    assert.deepEqual([dead.state, dead.repaired], ['ok', true]);
    assert.match(dead.msg, /pid 777/);
    checkTester({ ...base, lockPid: null, restart, now: at('2026-10-29T10:20:00') });
    assert.equal(started, 2);
  });
});

describe('checkDevice', () => {
  it('flags low disk and high memory against the limits', () => {
    assert.equal(checkDevice({ freeGb: 50, memPct: 40, diskMinGb: 10, memMaxPct: 90 }).state, 'ok');
    const r = checkDevice({ freeGb: 4.2, memPct: 95, diskMinGb: 10, memMaxPct: 90 });
    assert.equal(r.state, 'low');
    assert.match(r.msg, /4\.2 GB free/);
    assert.match(r.msg, /95% used/);
  });
});

describe('checkTradingView', () => {
  it('does nothing while CDP and the MCP server both answer', async () => {
    let calls = 0;
    const r = await checkTradingView({ up: async () => true, tvUp: async () => { calls++; }, sleep: async () => {} });
    assert.deepEqual([r.state, calls], ['ok', 0]);
  });

  it('runs tv_up when either is down, and reports a repair or a failure', async () => {
    let n = 0;
    const flaky = async (url) => (url.includes('9222') ? n++ > 0 : true);
    const fixed = await checkTradingView({ up: flaky, tvUp: async () => ({ code: 0, tail: 'ok' }), sleep: async () => {} });
    assert.deepEqual([fixed.state, fixed.repaired], ['ok', true]);
    const broken = await checkTradingView({ up: async (url) => !url.includes('8765'), tvUp: async () => ({ code: 1, tail: 'refused' }), sleep: async () => {} });
    assert.equal(broken.state, 'down');
    assert.match(broken.msg, /exit 1: refused/);
  });
});

describe('diffEvents', () => {
  it('reports changes, repairs and recoveries, and stays quiet when nothing changed', () => {
    assert.deepEqual(diffEvents({ tester: 'ok' }, { tester: { state: 'ok' } }).events, []);
    assert.deepEqual(diffEvents({ tester: 'ok' }, { tester: { state: 'stale', msg: 'S' } }).events, ['S']);
    assert.deepEqual(diffEvents({ tester: 'stale' }, { tester: { state: 'stale', msg: 'S' } }).events, []);
    assert.match(diffEvents({ tester: 'stale' }, { tester: { state: 'ok' } }).events[0], /logging again/);
    assert.deepEqual(diffEvents({ tester: 'ok' }, { tester: { state: 'ok', repaired: true, msg: 'R' } }).events, ['R']);
  });
});

describe('review regressions', () => {
  const base = { lockPid: 42, alive: () => true, logText: '', staleMin: 35, now: at('2026-10-29T10:40:00') };

  it('treats a pid owned by another account (EPERM) as dead, so a reused pid does not block a restart', () => {
    assert.equal(pidAlive(5, () => { const e = new Error('x'); e.code = 'EPERM'; throw e; }), false);
    assert.equal(pidAlive(5, () => { const e = new Error('x'); e.code = 'ESRCH'; throw e; }), false);
    assert.equal(pidAlive(5, () => true), true);
  });

  it('reports a restart that dies at once as failed instead of ok', () => {
    const r = checkTester({ ...base, lockPid: null, restart: () => { throw new Error('exited with code 1'); } });
    assert.equal(r.state, 'failed');
    assert.match(r.msg, /exited with code 1/);
  });

  it('counts a fresh store file as a successful cycle when the log has none, as for a tester started by hand', () => {
    assert.equal(checkTester({ ...base, storeAgeMin: 3, restart: () => 1 }).state, 'ok');
    assert.equal(checkTester({ ...base, storeAgeMin: 50, restart: () => 1 }).state, 'stale');
  });

  it('starts from an empty state when the state file is corrupt', () => {
    assert.deepEqual(parseState('{"tester": "o'), {});
    assert.deepEqual(parseState('{"tester":"ok"}'), { tester: 'ok' });
  });

  it('keeps one run inside the 5-minute cron interval', () => {
    assert.ok(RUN_BUDGET_MS < 5 * 60000, `run budget ${RUN_BUDGET_MS} ms`);
  });

  it('keeps the old state for a check whose alert could not be relayed, so the next run sends it again', async () => {
    const r = await runWatch({
      checks: { device: async () => ({ state: 'low', msg: 'Desktop: low.' }), tester: async () => ({ state: 'ok' }) },
      prev: { device: 'ok', tester: 'ok' }, relay: async () => { throw new Error('ssh down'); }, heartbeat: async () => {},
    });
    assert.deepEqual(r.state, { device: 'ok', tester: 'ok' });
  });
});

describe('runWatch', () => {
  const healthy = {
    tradingview: async () => ({ state: 'ok' }),
    tester: async () => ({ state: 'ok' }),
    device: async () => ({ state: 'ok' }),
  };

  it('beats the heartbeat every run and relays only when there is news', async () => {
    const sent = [];
    let beats = 0;
    const deps = { checks: healthy, prev: {}, relay: async (t) => sent.push(t), heartbeat: async () => { beats++; } };
    await runWatch(deps);
    assert.deepEqual([sent.length, beats], [0, 1]);
    await runWatch({ ...deps, checks: { ...healthy, device: async () => ({ state: 'low', msg: 'Desktop: C: low.' }) } });
    assert.equal(sent.length, 1);
    assert.match(sent[0], /C: low/);
    assert.equal(beats, 2);
  });

  it('keeps going when a check, the relay or the heartbeat throws', async () => {
    const r = await runWatch({
      checks: { ...healthy, tester: async () => { throw new Error('boom'); } },
      prev: {}, relay: async () => { throw new Error('ssh down'); }, heartbeat: async () => { throw new Error('ssh down'); },
    });
    assert.deepEqual(r.state, { tradingview: 'ok', tester: 'error', device: 'ok' });
    assert.match(r.events[0], /tester check failed: boom/);
  });
});
