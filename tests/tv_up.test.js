/**
 * Tests for scripts/tv_up.js step logic. Every probe and side effect is
 * injected; nothing here touches TradingView, the network, or tailscale.
 *
 * Run: node --test tests/tv_up.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tvUp, parseFunnel8443 } from '../scripts/tv_up.js';

const KEY = 'a'.repeat(40);
const DNS = 'box.tail0000.ts.net';
const PROXY_443 = { TCP: { 443: { HTTPS: true } }, Web: { [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } } } };

function funnelWith8443(proxy, { allowFunnel = true } = {}) {
  return {
    TCP: { 443: { HTTPS: true }, 8443: { HTTPS: true } },
    Web: {
      [`${DNS}:443`]: { Handlers: { '/': { Proxy: 'http://127.0.0.1:3773' } } },
      [`${DNS}:8443`]: { Handlers: { '/': { Proxy: proxy } } },
    },
    ...(allowFunnel && { AllowFunnel: { [`${DNS}:8443`]: true } }),
  };
}

/**
 * Fake world. Flags describe the starting state; side effects flip it so
 * post-action probes see the change.
 */
function world({
  cdpUp = false, tvRunning = false, httpUp = false, httpKeyMatches = true,
  httpComesUp = true, funnel = PROXY_443, launchBringsCdp = true, launchThrows = null,
  tailscaleMissing = false, dnsName = `${DNS}.`,
} = {}) {
  const s = { cdpUp, tvRunning, httpUp, funnel, calls: [], lines: [], spawnEnv: null, tailscaleArgs: [] };
  const deps = {
    log: (line) => { s.lines.push(line); s.calls.push(`log:${line}`); },
    httpRequest: async (url, opts = {}) => {
      s.calls.push(`http:${opts.method || 'GET'} ${url}`);
      if (url.endsWith('/json/version')) return s.cdpUp ? { status: 200, body: '{"Browser":"x"}' } : null;
      if (url.endsWith('/health')) return s.httpUp ? { status: 200, body: 'ok' } : null;
      if (url.endsWith('/mcp')) {
        if (!s.httpUp) return null;
        const ok = opts.headers?.Authorization === `Bearer ${KEY}` && httpKeyMatches;
        return { status: ok ? 406 : 401, body: '' };
      }
      throw new Error(`unexpected url ${url}`);
    },
    isTvRunning: async () => { s.calls.push('isTvRunning'); return s.tvRunning; },
    launch: async (opts) => {
      s.calls.push(`launch:${JSON.stringify(opts)}`);
      if (launchThrows) throw new Error(launchThrows);
      s.tvRunning = true;
      if (launchBringsCdp) { s.cdpUp = true; return { success: true, cdp_url: 'http://127.0.0.1:9222' }; }
      return { success: true, cdp_ready: false, warning: 'not yet' };
    },
    spawnHttpServer: ({ env }) => {
      s.calls.push('spawnHttpServer');
      s.spawnEnv = env;
      if (httpComesUp) s.httpUp = true;
    },
    tailscale: async (args) => {
      s.calls.push(`tailscale:${args.join(' ')}`);
      s.tailscaleArgs.push(args);
      if (tailscaleMissing) throw Object.assign(new Error('spawn tailscale ENOENT'), { code: 'ENOENT' });
      if (args[0] === 'funnel' && args[1] === 'status') return JSON.stringify(s.funnel);
      if (args[0] === 'funnel' && args[1] === '--bg') {
        s.funnel = funnelWith8443(args[3]);
        return 'Available on the internet';
      }
      if (args[0] === 'status') return JSON.stringify({ Self: { DNSName: dnsName, HostName: 'box' } });
      throw new Error(`unexpected tailscale ${args.join(' ')}`);
    },
    delay: async () => {},
  };
  return { s, deps };
}

const baseEnv = { TV_MCP_API_KEY: KEY, PATH: '/bin' };
const run = (deps, { env = baseEnv, argv = [] } = {}) => tvUp({ env, argv, _deps: deps });
const out = (s) => s.lines.join('\n');
const mutating = (s) => s.calls.filter((c) => c.startsWith('launch') || c === 'spawnHttpServer' || c.startsWith('tailscale:funnel --bg'));

describe('tv_up — step 1: api key', () => {
  for (const [label, env] of [['missing', { PATH: '/bin' }], ['empty', { TV_MCP_API_KEY: '' }], ['31 chars', { TV_MCP_API_KEY: 'x'.repeat(31) }]]) {
    it(`${label} key → exit 1 with setup help and no other step runs`, async () => {
      const { s, deps } = world();
      const code = await run(deps, { env });
      assert.equal(code, 1);
      assert.match(out(s), /TV_MCP_API_KEY/);
      assert.match(out(s), /randomBytes\(32\)/, 'should show how to generate a key');
      assert.ok(!s.calls.some((c) => c.startsWith('http:') || c.startsWith('tailscale') || c.startsWith('launch')));
      if (env.TV_MCP_API_KEY) assert.ok(!out(s).includes(env.TV_MCP_API_KEY), 'key echoed');
    });
  }

  it('never prints the key on success', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.ok(!out(s).includes(KEY));
  });

  it('bad TV_MCP_HTTP_PORT → exit 1', async () => {
    const { s, deps } = world();
    assert.equal(await run(deps, { env: { ...baseEnv, TV_MCP_HTTP_PORT: '70000' } }), 1);
    assert.match(out(s), /TV_MCP_HTTP_PORT/);
  });

  for (const bad of [' ', '0x50', '1e3']) {
    it(`non-decimal TV_MCP_HTTP_PORT ${JSON.stringify(bad)} → exit 1`, async () => {
      const { s, deps } = world();
      assert.equal(await run(deps, { env: { ...baseEnv, TV_MCP_HTTP_PORT: bad } }), 1);
      assert.match(out(s), /TV_MCP_HTTP_PORT/);
    });
  }
});

describe('tv_up — step 2: TradingView CDP', () => {
  it('CDP already answering → never launches', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.ok(!s.calls.some((c) => c.startsWith('launch')));
    assert.ok(!s.calls.includes('isTvRunning'));
    assert.ok(s.calls.includes('http:GET http://127.0.0.1:9222/json/version'));
  });

  it('CDP down and TradingView running → one-line warning printed before launch', async () => {
    const { s, deps } = world({ tvRunning: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    const warnIdx = s.calls.findIndex((c) => c.startsWith('log:') && /running without CDP/.test(c));
    const launchIdx = s.calls.findIndex((c) => c.startsWith('launch'));
    assert.ok(warnIdx >= 0, 'no warning');
    assert.ok(launchIdx > warnIdx, 'warning must precede launch');
    assert.ok(!s.calls[warnIdx].includes('\n'), 'warning must be one line');
  });

  it('CDP down and TradingView not running → launches without the kill warning', async () => {
    const { s, deps } = world({ httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.ok(!/running without CDP/.test(out(s)));
    assert.ok(s.calls.some((c) => c.startsWith('launch')));
  });

  it('honors TV_CDP_PORT for the probe and the launch', async () => {
    const { s, deps } = world({ httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    await run(deps, { env: { ...baseEnv, TV_CDP_PORT: '9333' } });
    assert.ok(s.calls.includes('http:GET http://127.0.0.1:9333/json/version'));
    assert.ok(s.calls.includes('launch:{"port":9333}'));
  });

  it('launch throws → exit 1, later steps do not run', async () => {
    const { s, deps } = world({ launchThrows: 'TradingView not found on win32' });
    assert.equal(await run(deps), 1);
    assert.match(out(s), /TradingView not found/);
    assert.ok(!s.calls.includes('spawnHttpServer'));
  });

  it('launched but CDP not answering yet → warns and continues', async () => {
    const { s, deps } = world({ launchBringsCdp: false, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.match(out(s), /CDP not answering yet/);
  });
});

describe('tv_up — step 3: HTTP server', () => {
  it('already answering with the same key → no spawn', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.ok(!s.calls.includes('spawnHttpServer'));
  });

  it('already answering but with a different key → exit 1, no funnel change', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, httpKeyMatches: false });
    assert.equal(await run(deps), 1);
    assert.match(out(s), /different TV_MCP_API_KEY/);
    assert.ok(!s.calls.some((c) => c.startsWith('tailscale')));
  });

  it('down → spawns with ELECTRON_RUN_AS_NODE stripped and waits for /health', async () => {
    const env = { ...baseEnv, ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1' };
    const { s, deps } = world({ cdpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps, { env }), 0);
    assert.ok(s.calls.includes('spawnHttpServer'));
    assert.equal(s.spawnEnv.TV_MCP_API_KEY, KEY, 'child needs the key');
    assert.deepEqual(Object.keys(s.spawnEnv).filter((k) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE'), []);
    const spawnIdx = s.calls.indexOf('spawnHttpServer');
    assert.ok(s.calls.slice(spawnIdx).includes('http:GET http://127.0.0.1:8765/health'));
  });

  it('never comes up → exit 1 and funnel is not touched', async () => {
    const { s, deps } = world({ cdpUp: true, httpComesUp: false });
    assert.equal(await run(deps), 1);
    assert.match(out(s), /did not answer/);
    assert.ok(!s.calls.some((c) => c.startsWith('tailscale')));
  });

  it('honors TV_MCP_HTTP_PORT', async () => {
    const { s, deps } = world({ cdpUp: true });
    assert.equal(await run(deps, { env: { ...baseEnv, TV_MCP_HTTP_PORT: '9100' } }), 0);
    assert.ok(s.calls.includes('http:GET http://127.0.0.1:9100/health'));
    assert.ok(s.calls.includes('tailscale:funnel --bg --https=8443 http://127.0.0.1:9100'));
  });
});

describe('tv_up — step 4: funnel', () => {
  it('no 8443 mapping → runs the exact funnel command, 443 mapping untouched', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true });
    assert.equal(await run(deps), 0);
    const bg = s.tailscaleArgs.filter((a) => a.includes('--bg'));
    assert.deepEqual(bg, [['funnel', '--bg', '--https=8443', 'http://127.0.0.1:8765']]);
    assert.ok(!s.tailscaleArgs.some((a) => a.some((x) => /443/.test(x) && !/8443/.test(x))), 'must not touch :443');
  });

  it('8443 already funneled to the port → no funnel command', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    assert.equal(await run(deps), 0);
    assert.deepEqual(mutating(s), []);
  });

  it('8443 served to the port but funnel off → turns funnel on', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765', { allowFunnel: false }) });
    assert.equal(await run(deps), 0);
    assert.ok(s.calls.includes('tailscale:funnel --bg --https=8443 http://127.0.0.1:8765'));
  });

  it('8443 mapped to something else → exit 1, mapping left alone', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:5000') });
    assert.equal(await run(deps), 1);
    assert.match(out(s), /8443/);
    assert.ok(!s.calls.some((c) => c.startsWith('tailscale:funnel --bg')));
  });

  it('--no-funnel → no tailscale calls at all, prints the local URL', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true });
    assert.equal(await run(deps, { argv: ['--no-funnel'] }), 0);
    assert.ok(!s.calls.some((c) => c.startsWith('tailscale')));
    assert.match(out(s), /http:\/\/127\.0\.0\.1:8765\/mcp/);
  });

  it('tailscale missing → exit 1 with a clear message', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, tailscaleMissing: true });
    assert.equal(await run(deps), 1);
    assert.match(out(s), /tailscale/i);
  });
});

describe('tv_up — step 5: public URL', () => {
  it('prints https://<MagicDNS>:8443/mcp with the trailing dot stripped', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true });
    assert.equal(await run(deps), 0);
    assert.ok(s.lines.some((l) => l.includes(`https://${DNS}:8443/mcp`)));
    assert.ok(!out(s).includes(`${DNS}.:8443`));
  });

  it('missing DNSName → exit 1', async () => {
    const { deps } = world({ cdpUp: true, httpUp: true, dnsName: '' });
    assert.equal(await run(deps), 1);
  });

  it('prints one status line per step', async () => {
    const { s, deps } = world({ cdpUp: true, httpUp: true, funnel: funnelWith8443('http://127.0.0.1:8765') });
    await run(deps);
    for (const n of [1, 2, 3, 4, 5]) {
      assert.equal(s.lines.filter((l) => l.includes(`${n}/5`)).length, 1, `step ${n}`);
    }
  });

  it('fully up → second run performs no actions (idempotent)', async () => {
    const { s, deps } = world();
    assert.equal(await run(deps), 0);
    const first = mutating(s).length;
    assert.ok(first >= 3);
    s.calls.length = 0;
    assert.equal(await run(deps), 0);
    assert.deepEqual(mutating(s), []);
  });
});

describe('parseFunnel8443()', () => {
  it('reads the live JSON shape (443 only) as no mapping', () => {
    assert.deepEqual(parseFunnel8443(PROXY_443, 8765), { state: 'absent' });
  });

  it('accepts localhost and 127.0.0.1 targets, with or without a trailing slash', () => {
    for (const p of ['http://127.0.0.1:8765', 'http://localhost:8765/', '127.0.0.1:8765']) {
      assert.equal(parseFunnel8443(funnelWith8443(p), 8765).state, 'ours', p);
    }
  });

  it('flags other targets and raw TCP forwards on 8443 as conflicts', () => {
    assert.equal(parseFunnel8443(funnelWith8443('http://127.0.0.1:87650'), 8765).state, 'conflict');
    assert.equal(parseFunnel8443({ TCP: { 8443: { TCPForward: '127.0.0.1:22' } } }, 8765).state, 'conflict');
  });

  it('handles empty / null status', () => {
    assert.deepEqual(parseFunnel8443({}, 8765), { state: 'absent' });
    assert.deepEqual(parseFunnel8443(null, 8765), { state: 'absent' });
  });
});
