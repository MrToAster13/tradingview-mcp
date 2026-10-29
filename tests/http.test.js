/**
 * Tests for the Streamable HTTP mode in src/http.js (node src/server.js --http).
 * Binds port 0 on 127.0.0.1. Does not need TradingView: tools/list never
 * touches CDP.
 *
 * Run: node --test tests/http.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { startHttpServer, readHttpConfig, main } from '../src/http.js';
import { createServer } from '../src/create_server.js';
import { tailscaleSync } from '../src/funnel.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVER_JS = join(ROOT, 'src', 'server.js');
const KEY = 'k'.repeat(16) + '0123456789abcdef0123456789abcdef'; // 48 chars
const WRONG_KEY = 'w'.repeat(48);
const MINUTE = 60_000;

function fakeClock() {
  let now = 0;
  let nextId = 0;
  const timers = new Map();
  return {
    setTimeout(fn, ms) { timers.set(++nextId, { fn, at: now + ms }); return nextId; },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      now += ms;
      for (const [id, t] of [...timers]) {
        if (t.at <= now) { timers.delete(id); t.fn(); }
      }
    },
  };
}

function envWithout(...names) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (names.includes(k.toUpperCase())) delete env[k];
  return env;
}

async function startTestServer(extra = {}) {
  const logs = [];
  const exits = [];
  const clock = fakeClock();
  const handle = await startHttpServer({
    apiKey: KEY,
    port: 0,
    idleMs: 15 * MINUTE,
    _deps: {
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      exit: (code) => exits.push(code),
      log: (line) => logs.push(line),
    },
    ...extra,
  });
  return { handle, logs, exits, clock, base: `http://127.0.0.1:${handle.port}` };
}

const initBody = JSON.stringify({
  jsonrpc: '2.0', id: 1, method: 'initialize',
  params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '0' } },
});
const mcpHeaders = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };

describe('http mode — auth and routing', () => {
  let s;
  before(async () => { s = await startTestServer(); });
  after(async () => { await s.handle.close(); });

  it('binds to 127.0.0.1 on an ephemeral port', () => {
    assert.equal(s.handle.address.address, '127.0.0.1');
    assert.ok(s.handle.port > 0);
  });

  it('missing Authorization → 401 JSON', async () => {
    const res = await fetch(`${s.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: initBody });
    assert.equal(res.status, 401);
    assert.match(res.headers.get('content-type'), /application\/json/);
    assert.equal(res.headers.get('www-authenticate'), 'Bearer');
    const body = await res.json();
    assert.equal(body.error.message, 'Unauthorized');
  });

  it('wrong key → 401 and the log never contains key material', async () => {
    const before = s.logs.length;
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: `Bearer ${WRONG_KEY}` }, body: initBody,
    });
    assert.equal(res.status, 401);
    await res.json();
    const newLogs = s.logs.slice(before).join('\n');
    assert.match(newLogs, /auth failed/);
    assert.ok(!newLogs.includes(WRONG_KEY), 'wrong key echoed to log');
    assert.ok(!newLogs.includes(KEY), 'real key echoed to log');
  });

  it('wrong key of a different length → 401 (hash compare, no length throw)', async () => {
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: 'Bearer x' }, body: initBody,
    });
    assert.equal(res.status, 401);
  });

  it('non-Bearer scheme → 401', async () => {
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: `Basic ${KEY}` }, body: initBody,
    });
    assert.equal(res.status, 401);
  });

  it('GET /health works unauthenticated and returns only "ok"', async () => {
    const res = await fetch(`${s.base}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });

  it('unknown paths → 404, including / and /mcp/', async () => {
    for (const p of ['/', '/nope', '/mcp/', '/health/x']) {
      const res = await fetch(`${s.base}${p}`, { headers: { Authorization: `Bearer ${KEY}` } });
      assert.equal(res.status, 404, p);
      await res.text();
    }
  });

  it('correct key → initialize succeeds (lowercase "bearer" accepted)', async () => {
    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: `bearer ${KEY}` }, body: initBody,
    });
    assert.equal(res.status, 200);
    const text = await res.text();
    assert.match(text, /"serverInfo"/);
    assert.equal(res.headers.get('mcp-session-id'), null, 'stateless mode must not issue session ids');
  });

  it('authenticated GET /mcp → 405 (stateless: no standalone SSE stream)', async () => {
    const res = await fetch(`${s.base}/mcp`, { headers: { Authorization: `Bearer ${KEY}`, Accept: 'text/event-stream' } });
    assert.equal(res.status, 405);
    await res.text();
  });
});

// ELI-756: tools that run arbitrary code or drive the desktop are stdio-only.
const HTTP_BLOCKED = ['ui_evaluate', 'tv_update', 'tv_launch', 'ui_type_text', 'ui_mouse_click', 'ui_keyboard'];

describe('http mode — tools/list versus stdio', () => {
  let s;
  let httpTools;
  let stdioTools;
  before(async () => {
    s = await startTestServer();
    const httpClient = new Client({ name: 'http-test', version: '0' });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }));
    httpTools = (await httpClient.listTools()).tools.map((t) => t.name).sort();
    await httpClient.close();

    const stdioClient = new Client({ name: 'stdio-test', version: '0' });
    await stdioClient.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER_JS], cwd: ROOT, stderr: 'ignore',
    }));
    stdioTools = (await stdioClient.listTools()).tools.map((t) => t.name).sort();
    await stdioClient.close();
  });
  after(async () => { await s.handle.close(); });

  it('HTTP mode does not register ui_evaluate, tv_update, tv_launch, ui_type_text, ui_mouse_click or ui_keyboard', () => {
    for (const name of HTTP_BLOCKED) assert.ok(!httpTools.includes(name), `${name} is exposed over HTTP`);
  });

  it('stdio mode still registers all six', () => {
    for (const name of HTTP_BLOCKED) assert.ok(stdioTools.includes(name), `${name} missing from stdio`);
  });

  it('HTTP mode registers every other stdio tool', () => {
    assert.ok(stdioTools.length > HTTP_BLOCKED.length);
    assert.deepEqual(httpTools, stdioTools.filter((n) => !HTTP_BLOCKED.includes(n)));
  });

  it('createServer() builds a fresh server each call', () => {
    assert.notEqual(createServer(), createServer());
  });
});

describe('http mode — idle shutdown', () => {
  it('fires after the idle window and an authenticated request resets it', async () => {
    const s = await startTestServer();
    s.clock.advance(14 * MINUTE);
    assert.deepEqual(s.exits, []);

    const res = await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: `Bearer ${KEY}` }, body: initBody,
    });
    await res.text();
    await new Promise((r) => setTimeout(r, 50)); // let the server see the response close
    s.clock.advance(14 * MINUTE); // 28 min since start, 14 since the request
    assert.deepEqual(s.exits, [], 'request did not reset the idle timer');

    s.clock.advance(1 * MINUTE + 1);
    assert.deepEqual(s.exits, [0]);
    assert.equal(s.handle.server.listening, false);
    assert.ok(s.logs.some((l) => /idle/.test(l)));
  });

  it('unauthenticated and /health requests do not reset the idle timer', async () => {
    const s = await startTestServer();
    s.clock.advance(14 * MINUTE);
    await (await fetch(`${s.base}/health`)).text();
    await (await fetch(`${s.base}/mcp`, { method: 'POST', headers: mcpHeaders, body: initBody })).text();
    await (await fetch(`${s.base}/mcp`, {
      method: 'POST', headers: { ...mcpHeaders, Authorization: 'Bearer wrong' }, body: initBody,
    })).text();
    await new Promise((r) => setTimeout(r, 50));
    s.clock.advance(1 * MINUTE + 1);
    assert.deepEqual(s.exits, [0], 'scanner traffic kept the server alive');
  });

  it('does not exit while a request is still in flight', async () => {
    let release;
    let entered;
    const gate = new Promise((r) => { release = r; });
    const inTool = new Promise((r) => { entered = r; });
    const slowServer = () => {
      const srv = new McpServer({ name: 'slow', version: '0' });
      srv.tool('slow', 'waits for the test', {}, async () => { entered(); await gate; return { content: [{ type: 'text', text: 'done' }] }; });
      return srv;
    };
    const s = await startTestServer({ createServer: slowServer });
    const pending = fetch(`${s.base}/mcp`, {
      method: 'POST',
      headers: { ...mcpHeaders, Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'slow', arguments: {} } }),
    });
    await inTool;
    s.clock.advance(16 * MINUTE);
    assert.deepEqual(s.exits, [], 'exited mid-request');
    release();
    const res = await pending;
    assert.equal(res.status, 200);
    assert.match(await res.text(), /done/);
    await new Promise((r) => setImmediate(r)); // let the response 'close' event land
    s.clock.advance(15 * MINUTE + 1);
    assert.deepEqual(s.exits, [0]);
  });
});

// ── ELI-756: turn off the Funnel that tv_up.js opened when the server stops ──

const DNS = 'box.tail0000.ts.net';
// Checked against tailscale v1.102.4 cmd/tailscale/cli/serve_v2.go: "off" needs
// no --bg (wantFg := !e.bg.Value && !turnOff) and removes only the --https port.
const FUNNEL_OFF = ['funnel', '--https=8443', 'off'];

/** `tailscale funnel status --json` as tv_up.js leaves it: :8443 funneled to loopback:<port>. */
function funnelStatus(port, { allowFunnel = true } = {}) {
  return {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } },
      [`${DNS}:8443`]: { Handlers: { '/': { Proxy: `http://127.0.0.1:${port}` } } },
    },
    ...(allowFunnel && { AllowFunnel: { [`${DNS}:8443`]: true } }),
  };
}

/**
 * Starts main() on an ephemeral port with every side effect faked. `status`
 * is called with the bound port each time the fake `tailscale funnel status`
 * runs. Nothing here runs the real tailscale CLI or touches process signals.
 */
async function startMain({ status = (port) => funnelStatus(port), tailscaleThrows = null } = {}) {
  const w = { logs: [], exits: [], tailscaleCalls: [], signals: new Map(), clock: fakeClock(), port: null };
  const tailscaleSync = (args) => {
    w.tailscaleCalls.push(args);
    if (tailscaleThrows) throw tailscaleThrows;
    if (args[0] === 'funnel' && args[1] === 'status') return JSON.stringify(status(w.port));
    return '';
  };
  w.handle = await main({
    env: { TV_MCP_API_KEY: KEY, TV_MCP_HTTP_PORT: '0', TV_MCP_IDLE_MINUTES: '15' },
    _deps: {
      setTimeout: w.clock.setTimeout,
      clearTimeout: w.clock.clearTimeout,
      exit: (code) => w.exits.push(code),
      log: (line) => w.logs.push(line),
      tailscaleSync,
      onSignal: (sig, fn) => w.signals.set(sig, fn),
    },
  });
  w.port = w.handle.port;
  return w;
}

const offCalls = (w) => w.tailscaleCalls.filter((a) => a.join(' ') === FUNNEL_OFF.join(' '));

describe('http mode — Funnel is turned off when the server stops', () => {
  it('idle shutdown turns off the :8443 Funnel that points at this server, then exits 0', async () => {
    const w = await startMain();
    try {
      assert.equal(offCalls(w).length, 0, 'turned the Funnel off at startup');
      w.clock.advance(15 * MINUTE + 1);
      assert.equal(offCalls(w).length, 1);
      assert.deepEqual(w.exits, [0]);
      assert.equal(w.handle.server.listening, false);
    } finally { await w.handle.close(); }
  });

  for (const sig of ['SIGINT', 'SIGTERM']) {
    it(`${sig} turns off the Funnel, stops the server and exits`, async () => {
      const w = await startMain();
      try {
        assert.equal(typeof w.signals.get(sig), 'function', `no ${sig} handler registered`);
        w.signals.get(sig)();
        assert.equal(offCalls(w).length, 1);
        assert.equal(w.exits.length, 1);
        await new Promise((r) => setImmediate(r));
        assert.equal(w.handle.server.listening, false);
      } finally { await w.handle.close(); }
    });
  }

  it('turns the Funnel off only once when a signal follows the idle shutdown', async () => {
    const w = await startMain();
    try {
      w.clock.advance(15 * MINUTE + 1);
      w.signals.get('SIGTERM')();
      assert.equal(offCalls(w).length, 1);
    } finally { await w.handle.close(); }
  });

  it('leaves :8443 alone when it points at a different port', async () => {
    const w = await startMain({ status: (port) => funnelStatus(port + 1) });
    try {
      w.clock.advance(15 * MINUTE + 1);
      assert.equal(offCalls(w).length, 0);
      assert.deepEqual(w.exits, [0]);
    } finally { await w.handle.close(); }
  });

  it('does nothing when no Funnel is on :8443', async () => {
    const w = await startMain({ status: () => ({ TCP: { 443: { HTTPS: true } } }) });
    try {
      w.clock.advance(15 * MINUTE + 1);
      assert.equal(offCalls(w).length, 0);
      assert.deepEqual(w.exits, [0]);
    } finally { await w.handle.close(); }
  });

  it('both tailscale calls (status, then off) fit inside Windows\' ~10 s SIGHUP grace period', () => {
    // Node docs (process.md, Signal events): after SIGHUP "Node.js will be
    // unconditionally terminated by Windows about 10 seconds later".
    const timeouts = [];
    const exec = (file, args, opts) => { timeouts.push(opts.timeout); return '{}'; };
    tailscaleSync(['funnel', 'status', '--json'], { exec });
    tailscaleSync(FUNNEL_OFF, { exec });
    assert.ok(timeouts.every((t) => Number.isFinite(t) && t > 0), 'every call needs a timeout');
    assert.ok(timeouts[0] + timeouts[1] < 10_000, `status + off can take ${timeouts[0] + timeouts[1]} ms`);
  });

  it('still exits 0 and logs when the tailscale CLI is missing', async () => {
    const err = Object.assign(new Error('spawnSync tailscale ENOENT'), { code: 'ENOENT' });
    const w = await startMain({ tailscaleThrows: err });
    try {
      w.clock.advance(15 * MINUTE + 1);
      assert.deepEqual(w.exits, [0]);
      assert.ok(w.logs.some((l) => /tailscale/i.test(l)), 'no log line about tailscale');
    } finally { await w.handle.close(); }
  });
});

describe('http mode — startup validation', () => {
  it('refuses a short key', async () => {
    await assert.rejects(
      () => startHttpServer({ apiKey: 'a'.repeat(31), port: 0, _deps: { exit: () => {}, log: () => {} } }),
      /at least 32 characters/,
    );
  });

  it('accepts a key of exactly 32 chars', () => {
    const cfg = readHttpConfig({ TV_MCP_API_KEY: 'a'.repeat(32) });
    assert.equal(cfg.port, 8765);
    assert.equal(cfg.idleMs, 15 * MINUTE);
  });

  it('refuses a missing or empty key', () => {
    assert.throws(() => readHttpConfig({}), /TV_MCP_API_KEY is not set/);
    assert.throws(() => readHttpConfig({ TV_MCP_API_KEY: '' }), /TV_MCP_API_KEY is not set/);
  });

  it('rejects a key with leading or trailing whitespace', () => {
    for (const bad of [` ${KEY}`, `${KEY} `, `${KEY}
`, ' '.repeat(40)]) {
      assert.throws(() => readHttpConfig({ TV_MCP_API_KEY: bad }), /leading or trailing whitespace/);
    }
  });

  it('reads port and idle minutes from env and rejects bad values', () => {
    const cfg = readHttpConfig({ TV_MCP_API_KEY: KEY, TV_MCP_HTTP_PORT: '9000', TV_MCP_IDLE_MINUTES: '2.5' });
    assert.equal(cfg.port, 9000);
    assert.equal(cfg.idleMs, 150_000);
    for (const bad of ['0', '-1', 'abc', '99999999', '0.000001']) {
      assert.throws(() => readHttpConfig({ TV_MCP_API_KEY: KEY, TV_MCP_IDLE_MINUTES: bad }), /TV_MCP_IDLE_MINUTES/, bad);
    }
    for (const bad of ['-1', '65536', '80.5', 'abc', ' ', '0x50', '1e3']) {
      assert.throws(() => readHttpConfig({ TV_MCP_API_KEY: KEY, TV_MCP_HTTP_PORT: bad }), /TV_MCP_HTTP_PORT/, bad);
    }
  });

  it('main() exits 1 with a clear message and does not echo the key', async () => {
    const logs = [];
    const exits = [];
    const short = 'shortsecret-123';
    await main({ env: { TV_MCP_API_KEY: short }, _deps: { exit: (c) => exits.push(c), log: (l) => logs.push(l) } });
    assert.deepEqual(exits, [1]);
    assert.match(logs.join('\n'), /at least 32 characters/);
    assert.ok(!logs.join('\n').includes(short));
  });

  it('`node src/server.js --http` with a short key exits 1', () => {
    const short = 'shortsecret-456';
    const r = spawnSync(process.execPath, [SERVER_JS, '--http'], {
      cwd: ROOT, env: { ...envWithout('ELECTRON_RUN_AS_NODE'), TV_MCP_API_KEY: short }, encoding: 'utf8', timeout: 20_000,
    });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /at least 32 characters/);
    assert.ok(!r.stderr.includes(short));
  });

  it('`node src/server.js --http` with no key exits 1', () => {
    const env = envWithout('ELECTRON_RUN_AS_NODE', 'TV_MCP_API_KEY');
    const r = spawnSync(process.execPath, [SERVER_JS, '--http'], { cwd: ROOT, env, encoding: 'utf8', timeout: 20_000 });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /TV_MCP_API_KEY is not set/);
  });
});
