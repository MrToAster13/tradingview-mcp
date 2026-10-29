/**
 * Tailscale Funnel on :8443, shared by scripts/tv_up.js (turns it on) and
 * src/http.js (turns it off when the HTTP server stops).
 */
import { execFileSync } from 'node:child_process';

export const FUNNEL_PORT = 8443;

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

// Shutdown runs two calls (status, then off). Windows kills node about 10 s
// after SIGHUP (console closed), so both must finish well inside that.
const TAILSCALE_TIMEOUT_MS = 4_000;

/** Runs the tailscale CLI synchronously and returns stdout. Safe inside an exit path. */
export function tailscaleSync(args, { exec = execFileSync } = {}) {
  return exec('tailscale', args, {
    encoding: 'utf8', windowsHide: true, timeout: TAILSCALE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'],
  });
}

/**
 * Turns off the :8443 Funnel if, and only if, it is funneled to loopback:<port>
 * (what tv_up.js sets up). Anything else on :8443 is left alone. Never throws.
 * @returns {{ closed: boolean, reason: string }}
 */
export function closeOwnFunnel({ port, run = tailscaleSync }) {
  let status;
  try {
    const out = run(['funnel', 'status', '--json']);
    status = String(out ?? '').trim() ? JSON.parse(out) : {};
  } catch (err) {
    if (err?.code === 'ENOENT') return { closed: false, reason: 'tailscale CLI not found' };
    return { closed: false, reason: `tailscale funnel status failed: ${String(err?.message || err).split('\n')[0]}` };
  }
  const { state } = parseFunnel8443(status, port);
  if (state !== 'ours') return { closed: false, reason: `:${FUNNEL_PORT} is ${state}, left alone` };
  try {
    run(['funnel', `--https=${FUNNEL_PORT}`, 'off']);
  } catch (err) {
    return { closed: false, reason: `tailscale funnel --https=${FUNNEL_PORT} off failed: ${String(err?.message || err).split('\n')[0]}` };
  }
  return { closed: true, reason: `:${FUNNEL_PORT} Funnel to 127.0.0.1:${port} turned off` };
}
