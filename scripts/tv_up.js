#!/usr/bin/env node
/**
 * Bring up the remote TradingView MCP stack, one idempotent step at a time:
 *
 *   1/5 api key  TV_MCP_API_KEY must be set (>= 32 chars)
 *   2/5 cdp      TradingView answering on 127.0.0.1:<TV_CDP_PORT|9222>, else launch()
 *   3/5 http     `node src/server.js --http` answering /health, else spawn it detached
 *   4/5 funnel   tailscale funnel :8443 -> http://127.0.0.1:<port>, else add it
 *   5/5 url      print https://<MagicDNS name>:8443/mcp
 *
 * Every step probes first and only acts when the probe fails, so re-running
 * on a healthy stack changes nothing. The existing :443 serve mapping is
 * never read for writing or modified.
 *
 * Usage: node scripts/tv_up.js [--no-funnel]
 * Env:   TV_MCP_API_KEY (required), TV_MCP_HTTP_PORT (default 8765),
 *        TV_CDP_PORT / CDP_PORT (default 9222)
 */
import http from 'node:http';
import { spawn, execFile } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { validateApiKey, DEFAULT_HTTP_PORT } from '../src/http.js';
import { launch, envWithoutElectronRunAsNode } from '../src/core/health.js';

const FUNNEL_PORT = 8443;
const LOCAL = '127.0.0.1';
const HEALTH_WAIT_TRIES = 30;
const HEALTH_WAIT_MS = 500;
const SERVER_JS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'server.js');

const KEY_HELP = [
  'Generate a key:  node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"',
  'Set it (PowerShell, this session):  $env:TV_MCP_API_KEY = \'<key>\'',
  'Set it (Windows, persistent):       setx TV_MCP_API_KEY <key>   (then open a new terminal)',
  'Set it (bash/zsh):                  export TV_MCP_API_KEY=<key>',
];

// ── Funnel status parsing ──────────────────────────────────────────────────

const LOOPBACK_PROXY_RE = /^(?:http:\/\/)?(?:127\.0\.0\.1|localhost):(\d+)\/?$/i;

/**
 * Classify the :8443 entry of `tailscale funnel status --json`.
 *   absent    nothing on 8443
 *   ours      8443 "/" proxies to loopback:<port> and funnel is on
 *   served    8443 "/" proxies to loopback:<port> but funnel is off (tailnet only)
 *   conflict  8443 is used for something else; leave it alone
 */
export function parseFunnel8443(status, port) {
  if (!status || typeof status !== 'object') return { state: 'absent' };
  const tcp = status.TCP?.[FUNNEL_PORT] ?? status.TCP?.[String(FUNNEL_PORT)];
  if (tcp && (tcp.TCPForward || tcp.TerminateTLS)) {
    return { state: 'conflict', detail: `TCP forward to ${tcp.TCPForward || '?'}` };
  }
  const webKey = Object.keys(status.Web || {}).find((k) => k.endsWith(`:${FUNNEL_PORT}`));
  if (!webKey) return { state: 'absent' };

  const proxy = status.Web[webKey]?.Handlers?.['/']?.Proxy;
  const m = typeof proxy === 'string' ? proxy.match(LOOPBACK_PROXY_RE) : null;
  if (!m || Number(m[1]) !== port) {
    return { state: 'conflict', detail: proxy ? `proxies to ${proxy}` : 'serves something other than a "/" proxy' };
  }
  return { state: status.AllowFunnel?.[webKey] === true ? 'ours' : 'served' };
}

// ── Real side effects (replaced by _deps in tests) ─────────────────────────

/** GET/POST a URL. Resolves {status, body} or null when nothing answers. */
function httpRequest(url, { method = 'GET', headers = {}, body, timeoutMs = 2000 } = {}) {
  return new Promise((done) => {
    const req = http.request(url, { method, headers, timeout: timeoutMs, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 65536) data += c; });
      res.on('end', () => done({ status: res.statusCode, body: data }));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(null));
    req.end(body);
  });
}

const execFileP = promisify(execFile);

async function isTvRunning() {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execFileP('tasklist', ['/FI', 'IMAGENAME eq TradingView.exe', '/NH'], { windowsHide: true });
      return /TradingView\.exe/i.test(stdout);
    }
    // Exact process-name match; -f would also match this repo's own path.
    const name = process.platform === 'darwin' ? 'TradingView' : 'tradingview';
    await execFileP('pgrep', process.platform === 'darwin' ? ['-x', name] : ['-i', '-x', name]);
    return true;
  } catch {
    return false; // pgrep exits 1 when nothing matches
  }
}

function spawnHttpServer({ env }) {
  const child = spawn(process.execPath, [SERVER_JS, '--http'], {
    detached: true, stdio: 'ignore', env, windowsHide: true,
  });
  child.unref();
}

async function tailscale(args) {
  const { stdout } = await execFileP('tailscale', args, { windowsHide: true, timeout: 30_000 });
  return stdout;
}

const defaultDeps = {
  log: (line) => console.log(line),
  httpRequest,
  isTvRunning,
  launch,
  spawnHttpServer,
  tailscale,
  delay: (ms) => new Promise((r) => setTimeout(r, ms)),
};

// ── Steps ──────────────────────────────────────────────────────────────────

class StepError extends Error {}

function readPort(env) {
  const raw = env.TV_MCP_HTTP_PORT;
  if (raw === undefined || raw === '') return DEFAULT_HTTP_PORT;
  const port = /^\d+$/.test(raw) ? Number(raw) : NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new StepError(`TV_MCP_HTTP_PORT must be an integer 1-65535, got "${raw}".`);
  }
  return port;
}

const cdpPortFrom = (env) => Number(env.TV_CDP_PORT || env.CDP_PORT) || 9222;

async function healthOk(deps, port) {
  const r = await deps.httpRequest(`http://${LOCAL}:${port}/health`);
  return !!r && r.status === 200 && r.body.trim() === 'ok';
}

async function tailscaleJson(deps, args) {
  let out;
  try {
    out = await deps.tailscale(args);
  } catch (err) {
    if (err.code === 'ENOENT') throw new StepError('tailscale CLI not found on PATH (install Tailscale, or pass --no-funnel).');
    throw new StepError(`\`tailscale ${args.join(' ')}\` failed: ${err.message.split('\n')[0]}`);
  }
  try {
    return out.trim() ? JSON.parse(out) : {};
  } catch {
    throw new StepError(`\`tailscale ${args.join(' ')}\` did not return JSON.`);
  }
}

/**
 * Run all steps. Returns the process exit code (0 ok, 1 failed).
 * @param {{env?: object, argv?: string[], _deps?: object}} opts
 */
export async function tvUp({ env = process.env, argv = [], _deps } = {}) {
  const deps = { ...defaultDeps, ..._deps };
  const log = deps.log;
  let step = '1/5 api key';

  const unknown = argv.filter((a) => a !== '--no-funnel');
  if (unknown.length) {
    log(`unknown argument(s): ${unknown.join(' ')}. Usage: node scripts/tv_up.js [--no-funnel]`);
    return 1;
  }
  const noFunnel = argv.includes('--no-funnel');

  try {
    // 1. API key
    const apiKey = env.TV_MCP_API_KEY;
    try {
      validateApiKey(apiKey);
    } catch (err) {
      log(`${step}: FAILED. ${err.message}`);
      for (const line of KEY_HELP) log(`    ${line}`);
      return 1;
    }
    const port = readPort(env);
    log(`${step}: ok`);

    // 2. TradingView with CDP
    step = '2/5 cdp';
    const cdpPort = cdpPortFrom(env);
    const cdpUrl = `http://${LOCAL}:${cdpPort}/json/version`;
    const cdpUp = async () => { const r = await deps.httpRequest(cdpUrl); return !!r && r.status === 200; };
    if (await cdpUp()) {
      log(`${step}: TradingView already answering on ${LOCAL}:${cdpPort}`);
    } else {
      if (await deps.isTvRunning()) {
        log(`    warning: TradingView is running without CDP on port ${cdpPort}; launching will kill and restart it.`);
      }
      let result;
      try {
        result = await deps.launch({ port: cdpPort });
      } catch (err) {
        throw new StepError(`launch failed: ${err.message}`);
      }
      if (await cdpUp()) {
        log(`${step}: launched TradingView, CDP answering on ${LOCAL}:${cdpPort}`);
      } else {
        log(`${step}: launched TradingView, but CDP not answering yet on ${LOCAL}:${cdpPort}${result?.warning ? ` (${result.warning})` : ''}`);
      }
    }

    // 3. HTTP MCP server
    step = '3/5 http';
    if (await healthOk(deps, port)) {
      // Something already serves /health. Make sure it accepts *this* key, or the
      // public URL would point at a server the caller cannot use.
      const r = await deps.httpRequest(`http://${LOCAL}:${port}/mcp`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
        body: '{}',
      });
      if (!r) throw new StepError(`server on ${LOCAL}:${port} answers /health but not /mcp.`);
      if (r.status === 401) {
        throw new StepError(`server on ${LOCAL}:${port} is running with a different TV_MCP_API_KEY. Stop it (or wait for its idle shutdown) and re-run.`);
      }
      log(`${step}: already answering on ${LOCAL}:${port}`);
    } else {
      deps.spawnHttpServer({ env: envWithoutElectronRunAsNode(env), port });
      let up = false;
      for (let i = 0; i < HEALTH_WAIT_TRIES && !up; i++) {
        await deps.delay(HEALTH_WAIT_MS);
        up = await healthOk(deps, port);
      }
      if (!up) {
        throw new StepError(`started \`node src/server.js --http\` but ${LOCAL}:${port}/health did not answer within ${(HEALTH_WAIT_TRIES * HEALTH_WAIT_MS) / 1000}s (port in use? run it in the foreground to see errors).`);
      }
      log(`${step}: started, answering on ${LOCAL}:${port}`);
    }

    // 4. Tailscale Funnel on :8443
    step = '4/5 funnel';
    if (noFunnel) {
      log(`${step}: skipped (--no-funnel)`);
      log(`5/5 url: http://${LOCAL}:${port}/mcp (local only)`);
      return 0;
    }
    const target = `http://${LOCAL}:${port}`;
    const before = parseFunnel8443(await tailscaleJson(deps, ['funnel', 'status', '--json']), port);
    if (before.state === 'conflict') {
      throw new StepError(`:${FUNNEL_PORT} is already mapped (${before.detail}); not overwriting it. Remove that mapping or free the port, then re-run.`);
    }
    if (before.state === 'ours') {
      log(`${step}: :${FUNNEL_PORT} already funneled to ${target}`);
    } else {
      try {
        await deps.tailscale(['funnel', '--bg', `--https=${FUNNEL_PORT}`, target]);
      } catch (err) {
        throw new StepError(`\`tailscale funnel --bg --https=${FUNNEL_PORT} ${target}\` failed: ${err.message.split('\n')[0]}`);
      }
      const after = parseFunnel8443(await tailscaleJson(deps, ['funnel', 'status', '--json']), port);
      if (after.state !== 'ours') {
        throw new StepError(`ran tailscale funnel but :${FUNNEL_PORT} still is not funneled to ${target} (state: ${after.state}).`);
      }
      log(`${step}: :${FUNNEL_PORT} now funneled to ${target}`);
    }

    // 5. Public URL
    step = '5/5 url';
    const st = await tailscaleJson(deps, ['status', '--json']);
    const dnsName = String(st?.Self?.DNSName || '').replace(/\.$/, '');
    if (!dnsName) throw new StepError('tailscale status has no Self.DNSName (is MagicDNS enabled?).');
    log(`${step}: https://${dnsName}:${FUNNEL_PORT}/mcp`);
    return 0;
  } catch (err) {
    if (!(err instanceof StepError)) throw err;
    log(`${step}: FAILED. ${err.message}`);
    return 1;
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  tvUp({ env: process.env, argv: process.argv.slice(2) })
    .then((code) => process.exit(code))
    .catch((err) => { console.error(err); process.exit(1); });
}
