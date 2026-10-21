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

describe('http mode — tools/list parity with stdio', () => {
  let s;
  before(async () => { s = await startTestServer(); });
  after(async () => { await s.handle.close(); });

  it('correct key → tools/list returns the same tools as the stdio server', async () => {
    const httpClient = new Client({ name: 'http-test', version: '0' });
    await httpClient.connect(new StreamableHTTPClientTransport(new URL(`${s.base}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${KEY}` } },
    }));
    const httpTools = (await httpClient.listTools()).tools.map((t) => t.name).sort();
    await httpClient.close();

    const stdioClient = new Client({ name: 'stdio-test', version: '0' });
    await stdioClient.connect(new StdioClientTransport({
      command: process.execPath, args: [SERVER_JS], cwd: ROOT, stderr: 'ignore',
    }));
    const stdioTools = (await stdioClient.listTools()).tools.map((t) => t.name).sort();
    await stdioClient.close();

    assert.ok(stdioTools.length > 0);
    assert.equal(httpTools.length, stdioTools.length);
    assert.deepEqual(httpTools, stdioTools);
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
