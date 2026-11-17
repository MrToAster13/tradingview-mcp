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
  pidAlive, parseState, RUN_BUDGET_MS, TV_UP_ARGS, readSettings, testerArgs, cdpAnswers,
} from '../scripts/watchdog/desk_watch.js';
import { tvUp } from '../scripts/tv_up.js';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

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

  // ELI-848: the watchdog checks CDP only. tv_up runs when CDP is down.
  it('runs tv_up when CDP is down, and reports a repair or a failure', async () => {
    let n = 0;
    const flaky = async (url) => (url.includes('9222') ? n++ > 0 : true);
    const fixed = await checkTradingView({ up: flaky, tvUp: async () => ({ code: 0, tail: 'ok' }), sleep: async () => {} });
    assert.deepEqual([fixed.state, fixed.repaired], ['ok', true]);
    const broken = await checkTradingView({ up: async () => false, tvUp: async () => ({ code: 1, tail: 'refused' }), sleep: async () => {} });
    assert.equal(broken.state, 'down');
    assert.match(broken.msg, /exit 1: refused/);
  });
});

// ELI-848: the HTTP server exits on idle and closes the Funnel (ELI-756). The watchdog must not
// bring either back, and must not report the idle exit as a repair.
describe('ELI-848: the watchdog leaves the HTTP server and the Funnel alone', () => {
  it('does not run tv_up or send an event when only the HTTP server is down after an idle exit', async () => {
    const probed = [];
    let tvUpRuns = 0;
    const sent = [];
    const up = async (url) => { probed.push(url); return url.includes(':9222/'); };
    const out = await runWatch({
      checks: { tradingview: () => checkTradingView({ up, tvUp: async () => { tvUpRuns++; return { code: 0 }; }, sleep: async () => {} }) },
      prev: { tradingview: 'ok' }, relay: async (t) => sent.push(t), heartbeat: async () => {},
    });
    assert.equal(tvUpRuns, 0);
    assert.deepEqual(sent, []);
    assert.deepEqual(out, { state: { tradingview: 'ok' }, events: [] });
    assert.deepEqual(probed.filter((u) => !u.includes(':9222/')), [], 'probes nothing but CDP');
  });

  it('brings TradingView back when CDP is down and says so in one event', async () => {
    let cdp = false;
    const sent = [];
    const out = await runWatch({
      checks: { tradingview: () => checkTradingView({ up: async (url) => url.includes(':9222/') && cdp, tvUp: async () => { cdp = true; return { code: 0 }; }, sleep: async () => {} }) },
      prev: { tradingview: 'ok' }, relay: async (t) => sent.push(t), heartbeat: async () => {},
    });
    assert.equal(out.state.tradingview, 'ok');
    assert.equal(out.events.length, 1);
    assert.match(out.events[0], /CDP/);
    assert.doesNotMatch(out.events[0], /MCP server/);
    assert.equal(sent.length, 1);
  });

  it('runs tv_up as a CDP-only bring-up that needs no API key and never kills a running TradingView', async () => {
    const [script, ...argv] = TV_UP_ARGS;
    assert.equal(script, 'scripts/tv_up.js');
    const fake = (tvRunning) => {
      const calls = [];
      const deps = {
        log: () => {},
        probeCdp: async () => null,
        isTvRunning: async () => tvRunning,
        launch: async (opts) => { calls.push(`launch ${JSON.stringify(opts)}`); return { success: true }; },
        httpRequest: async (url) => { calls.push(`http ${url}`); return null; },
        spawnHttpServer: () => { calls.push('spawnHttpServer'); },
        tailscale: async (args) => { calls.push(`tailscale ${args.join(' ')}`); return '{}'; },
        delay: async () => {},
      };
      return { calls, deps };
    };
    // TradingView runs without CDP: tv_up refuses and launches nothing, since launching would kill it.
    const running = fake(true);
    assert.equal(await tvUp({ env: {}, argv, _deps: running.deps }), 1);
    assert.deepEqual(running.calls, []);
    // No TradingView: tv_up launches one with kill_existing false and starts no HTTP server or Funnel.
    const stopped = fake(false);
    assert.equal(await tvUp({ env: {}, argv, _deps: stopped.deps }), 0);
    assert.deepEqual(stopped.calls, ['launch {"port":9222,"kill_existing":false}']);
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

// ELI-851 items 2 and 3: settings parsing, the repo default and the tester interval.
describe('ELI-851: watchdog settings', () => {
  const collect = () => { const lines = []; return { lines, warn: (m) => lines.push(m) }; };

  it('falls back to the default and logs one warning for a threshold that is not a number', () => {
    for (const [name, key, def] of [['DESK_WATCH_STALE_MIN', 'staleMin', 35], ['DESK_WATCH_DISK_MIN_GB', 'diskMinGb', 10], ['DESK_WATCH_MEM_MAX_PCT', 'memMaxPct', 90]]) {
      const { lines, warn } = collect();
      const s = readSettings({ [name]: '3O' }, warn);
      assert.equal(s[key], def, name);
      assert.equal(lines.length, 1, `${name}: ${lines.join(' | ')}`);
      assert.match(lines[0], new RegExp(name));
      assert.match(lines[0], /3O/);
    }
  });

  // Review finding: a small negative value passed the old range check with no warning.
  it('keeps the default and warns for a negative threshold', () => {
    for (const name of ['DESK_WATCH_DISK_MIN_GB', 'DESK_WATCH_MEM_MAX_PCT', 'DESK_WATCH_STALE_MIN']) {
      const { lines, warn } = collect();
      const s = readSettings({ [name]: '-0.5' }, warn);
      assert.deepEqual([s.diskMinGb, s.memMaxPct, s.staleMin], [10, 90, 35], name);
      assert.equal(lines.length, 1, name);
    }
    assert.equal(readSettings({ DESK_WATCH_DISK_MIN_GB: '0' }, () => { throw new Error('0 is valid'); }).diskMinGb, 0);
  });

  it('takes valid numbers and stays quiet', () => {
    const { lines, warn } = collect();
    const s = readSettings({ DESK_WATCH_STALE_MIN: '50', DESK_WATCH_DISK_MIN_GB: '2.5', DESK_WATCH_MEM_MAX_PCT: '95' }, warn);
    assert.deepEqual([s.staleMin, s.diskMinGb, s.memMaxPct], [50, 2.5, 95]);
    assert.deepEqual(lines, []);
  });

  it('defaults mcpRepo to this repo root', () => {
    assert.equal(readSettings({}, () => {}).mcpRepo, REPO_ROOT);
    assert.equal(readSettings({ DESK_WATCH_MCP_REPO: 'elsewhere' }, () => {}).mcpRepo, 'elsewhere');
  });

  it('has no home path in the watchdog source', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'watchdog', 'desk_watch.js'), 'utf8');
    assert.doesNotMatch(src, /[A-Za-z]:\\{1,2}Users\\|\/home\/|\/Users\//);
  });

  it('restarts the tester with the interval from one setting, default 15', () => {
    const at = (args) => args[args.indexOf('--every') + 1];
    assert.equal(readSettings({}, () => {}).testerEvery, 15);
    assert.equal(at(testerArgs(readSettings({}, () => {}))), '15');
    assert.equal(at(testerArgs(readSettings({ DESK_WATCH_TESTER_EVERY: '10' }, () => {}))), '10');
    const { lines, warn } = collect();
    assert.equal(readSettings({ DESK_WATCH_TESTER_EVERY: '0' }, warn).testerEvery, 15, 'run.js refuses --every 0');
    assert.equal(lines.length, 1);
  });
});

// ELI-853: one CDP probe. The watchdog and tv_up.js both use probeCdp from src/core/tv_process.js.
describe('ELI-853: the watchdog and tv_up.js share probeCdp', () => {
  it('cdpAnswers asks probeCdp for 127.0.0.1:9222 with the watchdog timeout', async () => {
    const calls = [];
    const probe = async (...args) => { calls.push(args); return '{"Browser":"x"}'; };
    assert.equal(await cdpAnswers(probe), true);
    assert.deepEqual(calls, [[9222, '127.0.0.1', { timeoutMs: 5000 }]]);
  });

  it('cdpAnswers counts an empty 200 body as up and null as down', async () => {
    assert.equal(await cdpAnswers(async () => ''), true);
    assert.equal(await cdpAnswers(async () => null), false);
  });

  it('cdpAnswers defaults to probeCdp from tv_process.js', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'watchdog', 'desk_watch.js'), 'utf8');
    assert.match(src, /import \{[^}]*\bprobeCdp\b[^}]*\} from '\.\.\/\.\.\/src\/core\/tv_process\.js'/);
    assert.match(src, /cdpAnswers\(probe = probeCdp\)/);
  });

  it('desk_watch.js and tv_up.js carry no CDP probe of their own', () => {
    const watch = readFileSync(join(REPO_ROOT, 'scripts', 'watchdog', 'desk_watch.js'), 'utf8');
    assert.ok(!/\bfetch\(/.test(watch), 'desk_watch.js still fetches');
    const up = readFileSync(join(REPO_ROOT, 'scripts', 'tv_up.js'), 'utf8');
    assert.ok(!up.includes('/json/version'), 'tv_up.js still probes /json/version itself');
    assert.match(up, /import \{[^}]*\bprobeCdp\b[^}]*\} from '\.\.\/src\/core\/tv_process\.js'/);
  });
});
