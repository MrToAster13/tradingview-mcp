/**
 * Tests for src/core/tv_process.js: process detection, the CDP probe and the
 * bring-up decision. Probes, launch and delay are injected. The probeCdp
 * tests use a throwaway local HTTP server on a random port, never 9222.
 *
 * Run: node --test tests/tv_process.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { ensureTradingView, isTvRunning, probeCdp } from '../src/core/tv_process.js';

function fakes({ cdpUp = false, running = false, stalls = 0, launchBringsCdp = true, launchThrows = null, warning } = {}) {
  const s = { cdpUp, running, stalls, calls: [], delays: [] };
  const _deps = {
    probeCdp: async (port, host) => {
      s.calls.push(`probe ${host}:${port}`);
      if (s.stalls > 0) { s.stalls--; return null; }
      return s.cdpUp ? '{"Browser":"x"}' : null;
    },
    isTvRunning: async () => { s.calls.push('isTvRunning'); return s.running; },
    launch: async (opts) => {
      s.calls.push(`launch ${JSON.stringify(opts)}`);
      if (launchThrows) throw new Error(launchThrows);
      s.running = true;
      if (launchBringsCdp) s.cdpUp = true;
      return { success: true, ...(warning && { warning }) };
    },
    delay: async (ms) => { s.delays.push(ms); },
  };
  return { s, _deps };
}

const launches = (s) => s.calls.filter((c) => c.startsWith('launch'));

describe('ensureTradingView()', () => {
  it('CDP answers: up, no process check, no launch', async () => {
    const { s, _deps } = fakes({ cdpUp: true, running: true });
    assert.deepEqual(await ensureTradingView({ port: 9222, _deps }), { state: 'up' });
    assert.deepEqual(s.calls, ['probe 127.0.0.1:9222']);
  });

  it('running without CDP: retries 5 times at 2s, then refuses without launching', async () => {
    const { s, _deps } = fakes({ running: true });
    await assert.rejects(() => ensureTradingView({ port: 9222, _deps }),
      /running without CDP on 127\.0\.0\.1:9222 \(no answer within 10s\)\. Not killing it\./);
    assert.deepEqual(s.delays, [2000, 2000, 2000, 2000, 2000]);
    assert.equal(s.calls.filter((c) => c.startsWith('probe')).length, 6);
    assert.deepEqual(launches(s), []);
  });

  it('running with a stalled first probe: up after one retry', async () => {
    const { s, _deps } = fakes({ cdpUp: true, running: true, stalls: 1 });
    assert.deepEqual(await ensureTradingView({ port: 9222, _deps }), { state: 'up' });
    assert.deepEqual(s.delays, [2000]);
    assert.deepEqual(launches(s), []);
  });

  it('not running: launches with kill_existing false on the given port', async () => {
    const { s, _deps } = fakes();
    const r = await ensureTradingView({ port: 9333, _deps });
    assert.deepEqual(r, { state: 'launched', ready: true, warning: undefined });
    assert.deepEqual(launches(s), ['launch {"port":9333,"kill_existing":false}']);
    assert.ok(s.calls.indexOf('isTvRunning') < s.calls.indexOf(launches(s)[0]));
    assert.deepEqual(s.delays, []);
  });

  it('launched but CDP not answering: ready false with the launch warning', async () => {
    const { _deps } = fakes({ launchBringsCdp: false, warning: 'not yet' });
    assert.deepEqual(await ensureTradingView({ port: 9222, _deps }), { state: 'launched', ready: false, warning: 'not yet' });
  });

  it('launch throws: "launch failed: ..."', async () => {
    const { _deps } = fakes({ launchThrows: 'TradingView not found' });
    await assert.rejects(() => ensureTradingView({ port: 9222, _deps }), { message: 'launch failed: TradingView not found' });
  });

  it('a process check that throws stops bring-up and launches nothing', async () => {
    const { s, _deps } = fakes();
    _deps.isTvRunning = async () => { throw new Error('boom'); };
    await assert.rejects(() => ensureTradingView({ port: 9222, _deps }), /boom/);
    assert.deepEqual(launches(s), []);
  });
});

describe('isTvRunning()', () => {
  const thrower = (status) => () => { throw Object.assign(new Error('exit'), { status }); };

  it('win32: true when tasklist lists TradingView.exe, false when not', () => {
    assert.equal(isTvRunning({ platform: 'win32', execSync: () => Buffer.from('TradingView.exe  1234 Console') }), true);
    assert.equal(isTvRunning({ platform: 'win32', execSync: () => Buffer.from('INFO: No tasks are running') }), false);
  });

  it('win32: a tasklist that fails counts as running', () => {
    assert.equal(isTvRunning({ platform: 'win32', execSync: thrower(undefined) }), true);
  });

  it('darwin and linux: exact-name pgrep, exit 1 means not running', () => {
    const cmds = [];
    const ok = (cmd) => { cmds.push(cmd); return Buffer.from(''); };
    assert.equal(isTvRunning({ platform: 'darwin', execSync: ok }), true);
    assert.equal(isTvRunning({ platform: 'linux', execSync: ok }), true);
    assert.deepEqual(cmds, ['pgrep -x TradingView', 'pgrep -i -x tradingview']);
    assert.equal(isTvRunning({ platform: 'linux', execSync: thrower(1) }), false);
  });

  it('darwin and linux: any other pgrep failure counts as running', () => {
    assert.equal(isTvRunning({ platform: 'linux', execSync: thrower(2) }), true);
    assert.equal(isTvRunning({ platform: 'darwin', execSync: thrower(undefined) }), true);
  });
});

describe('probeCdp()', () => {
  async function serve(status, body) {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url === '/json/version' ? status : 404);
      res.end(body);
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    return { port: server.address().port, close: () => new Promise((r) => server.close(r)) };
  }

  it('returns the body on HTTP 200', async () => {
    const srv = await serve(200, '{"Browser":"TradingView"}');
    try { assert.equal(await probeCdp(srv.port), '{"Browser":"TradingView"}'); } finally { await srv.close(); }
  });

  it('returns null on a non-200 status', async () => {
    const srv = await serve(500, 'nope');
    try { assert.equal(await probeCdp(srv.port), null); } finally { await srv.close(); }
  });

  it('returns null when nothing listens', async () => {
    const srv = await serve(200, 'x');
    const { port } = srv;
    await srv.close();
    assert.equal(await probeCdp(port), null);
  });
});
