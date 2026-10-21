/**
 * Streamable HTTP mode: `node src/server.js --http`.
 *
 * Listens on 127.0.0.1 only. Exposure to the outside (e.g. Tailscale Funnel)
 * is a separate, explicit step; see scripts/tv_up.js.
 *
 *   POST /mcp    MCP Streamable HTTP, stateless (new server + transport per
 *                request, sessionIdGenerator: undefined). Bearer auth required.
 *   GET  /health 200 "ok", no auth.
 *   anything else 404.
 *
 * Env: TV_MCP_API_KEY (required, >= 32 chars), TV_MCP_HTTP_PORT (default 8765),
 * TV_MCP_IDLE_MINUTES (default 15; the process exits after this long with no
 * authenticated /mcp requests).
 */
import http from 'node:http';
import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as defaultCreateServer } from './create_server.js';

export const HOST = '127.0.0.1';
export const DEFAULT_HTTP_PORT = 8765;
export const DEFAULT_IDLE_MINUTES = 15;
export const MIN_KEY_LENGTH = 32;
const MAX_TIMER_MS = 2 ** 31 - 1; // setTimeout overflows above this and fires immediately

/** Throws a clear error (never containing the key) if the key is unusable. */
export function validateApiKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new Error('TV_MCP_API_KEY is not set. HTTP mode requires a bearer key of at least 32 characters.');
  }
  if (key.trim() !== key) {
    throw new Error('TV_MCP_API_KEY has leading or trailing whitespace; remove it.');
  }
  if (key.length < MIN_KEY_LENGTH) {
    throw new Error(`TV_MCP_API_KEY is too short (${key.length} chars); it must be at least ${MIN_KEY_LENGTH} characters.`);
  }
}

/** Reads and validates HTTP-mode config from an env object. Throws on bad values. */
export function readHttpConfig(env = process.env) {
  const apiKey = env.TV_MCP_API_KEY;
  validateApiKey(apiKey);

  let port = DEFAULT_HTTP_PORT;
  if (env.TV_MCP_HTTP_PORT !== undefined && env.TV_MCP_HTTP_PORT !== '') {
    port = /^\d+$/.test(env.TV_MCP_HTTP_PORT) ? Number(env.TV_MCP_HTTP_PORT) : NaN;
    if (!Number.isInteger(port) || port < 0 || port > 65535) {
      throw new Error(`TV_MCP_HTTP_PORT must be an integer 0-65535, got "${env.TV_MCP_HTTP_PORT}".`);
    }
  }

  let idleMs = DEFAULT_IDLE_MINUTES * 60_000;
  if (env.TV_MCP_IDLE_MINUTES !== undefined && env.TV_MCP_IDLE_MINUTES !== '') {
    const minutes = Number(env.TV_MCP_IDLE_MINUTES);
    idleMs = Math.round(minutes * 60_000);
    if (!Number.isFinite(minutes) || minutes <= 0 || idleMs < 1 || idleMs > MAX_TIMER_MS) {
      throw new Error(`TV_MCP_IDLE_MINUTES must be a positive number of minutes (max ${Math.floor(MAX_TIMER_MS / 60_000)}), got "${env.TV_MCP_IDLE_MINUTES}".`);
    }
  }

  return { apiKey, port, idleMs };
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest();

function sendJson(res, status, body, headers = {}) {
  if (res.headersSent) { res.end(); return; }
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
}

const rpcError = (code, message) => ({ jsonrpc: '2.0', error: { code, message }, id: null });

/**
 * Starts the HTTP server. Resolves once listening.
 * @returns {{ server: http.Server, port: number, address: object, close: () => Promise<void> }}
 */
export async function startHttpServer({
  apiKey,
  port = DEFAULT_HTTP_PORT,
  host = HOST,
  idleMs = DEFAULT_IDLE_MINUTES * 60_000,
  createServer = defaultCreateServer,
  _deps = {},
} = {}) {
  validateApiKey(apiKey);
  const setTimer = _deps.setTimeout || setTimeout;
  const clearTimer = _deps.clearTimeout || clearTimeout;
  const exit = _deps.exit || ((code) => process.exit(code));
  const log = _deps.log || ((line) => process.stderr.write(`${line}\n`));

  const expectedDigest = sha256(apiKey);
  const authorize = (req) => {
    const header = req.headers.authorization;
    if (!header) return 'missing Authorization header';
    const m = /^Bearer[ \t]+(\S.*)$/i.exec(header);
    if (!m) return 'malformed Authorization header';
    return timingSafeEqual(sha256(m[1]), expectedDigest) ? null : 'invalid key';
  };

  let inFlight = 0;
  let idleTimer = null;
  let shuttingDown = false;

  // Only authenticated /mcp requests count as activity. Funnel makes the port
  // public, and scanner traffic must not keep the server alive.
  const server = http.createServer((req, res) => {
    inFlight++;
    res.on('close', () => { inFlight--; if (req.authenticated) resetIdle(); });
    handle(req, res).catch((err) => {
      log(`[tv-mcp http] request error: ${err?.message || err}`);
      sendJson(res, 500, rpcError(-32603, 'Internal server error'));
    });
  });

  async function handle(req, res) {
    let pathname;
    try { pathname = new URL(req.url, 'http://localhost').pathname; } catch { pathname = ''; }

    if (pathname === '/health') {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        res.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end(req.method === 'HEAD' ? undefined : 'ok');
      return;
    }

    if (pathname !== '/mcp') {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('not found');
      return;
    }

    const authError = authorize(req);
    if (authError) {
      log(`[tv-mcp http] auth failed (${authError}): ${req.method} /mcp from ${req.socket.remoteAddress}`);
      sendJson(res, 401, rpcError(-32001, 'Unauthorized'), { 'WWW-Authenticate': 'Bearer' });
      return;
    }
    req.authenticated = true;
    resetIdle();

    // Stateless mode serves only POST. A GET would open a standalone SSE
    // stream that nothing ever writes to; DELETE has no session to end.
    if (req.method !== 'POST') {
      sendJson(res, 405, rpcError(-32000, 'Method not allowed.'), { Allow: 'POST' });
      return;
    }

    // SDK stateless pattern: fresh server + transport per request.
    const mcp = createServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => { transport.close(); mcp.close(); });
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  }

  function resetIdle() {
    if (shuttingDown) return;
    if (idleTimer !== null) clearTimer(idleTimer);
    idleTimer = setTimer(onIdle, idleMs);
  }

  function onIdle() {
    idleTimer = null;
    if (inFlight > 0) { resetIdle(); return; }
    shuttingDown = true;
    log(`[tv-mcp http] idle for ${Math.round(idleMs / 60_000 * 10) / 10} min, shutting down`);
    server.close();
    server.closeAllConnections();
    exit(0);
  }

  await new Promise((resolve, reject) => {
    const onError = (err) => { server.off('listening', onListening); reject(err); };
    const onListening = () => { server.off('error', onError); resolve(); };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
  server.on('error', (err) => log(`[tv-mcp http] server error: ${err.message}`));
  resetIdle();

  const address = server.address();
  return {
    server,
    address,
    port: address.port,
    close: () => new Promise((resolve) => {
      shuttingDown = true;
      if (idleTimer !== null) clearTimer(idleTimer);
      idleTimer = null;
      server.close(() => resolve());
      server.closeAllConnections();
    }),
  };
}

/** Entry point for `node src/server.js --http`. Exits 1 on bad config or bind failure. */
export async function main({ env = process.env, _deps = {} } = {}) {
  const exit = _deps.exit || ((code) => process.exit(code));
  const log = _deps.log || ((line) => process.stderr.write(`${line}\n`));
  let cfg;
  try {
    cfg = readHttpConfig(env);
  } catch (err) {
    log(`[tv-mcp http] refusing to start: ${err.message}`);
    exit(1);
    return null;
  }
  try {
    const handle = await startHttpServer({ ...cfg, _deps: { ...(_deps || {}), exit, log } });
    log(`[tv-mcp http] listening on http://${HOST}:${handle.port}/mcp (idle shutdown after ${Math.round(cfg.idleMs / 60_000 * 10) / 10} min)`);
    return handle;
  } catch (err) {
    log(`[tv-mcp http] failed to start on ${HOST}:${cfg.port}: ${err.message}`);
    exit(1);
    return null;
  }
}
