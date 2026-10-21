/**
 * TradingView process bring-up: is it running, does CDP answer, and may this
 * call launch it. The one rule: never kill a TradingView this code did not
 * start. launch() in health.js holds the platform launch paths; this module
 * decides whether to call it. See docs/adr/0002-tv-process-bring-up.md.
 */
import { execSync as _execSync } from 'node:child_process';
import http from 'node:http';

const LOCAL = '127.0.0.1';
const CDP_RETRY_TRIES = 5;
const CDP_RETRY_MS = 2000;

/**
 * Whether a TradingView process is running. A check that cannot run counts
 * as running, so callers that must not kill a user's TradingView refuse.
 */
export function isTvRunning({ execSync = _execSync, platform = process.platform } = {}) {
  if (platform === 'win32') {
    try {
      const out = execSync('tasklist /FI "IMAGENAME eq TradingView.exe" /NH', { timeout: 5000, windowsHide: true }).toString();
      return /TradingView\.exe/i.test(out);
    } catch { return true; }
  }
  // Exact process-name match; -f would also match this repo's own path.
  const cmd = platform === 'darwin' ? 'pgrep -x TradingView' : 'pgrep -i -x tradingview';
  try {
    execSync(cmd, { timeout: 5000, stdio: 'ignore' });
    return true;
  } catch (e) {
    return e?.status !== 1; // pgrep exits 1 when nothing matches
  }
}

/** GET http://<host>:<port>/json/version. Resolves the body on HTTP 200, else null. */
export function probeCdp(port, host = LOCAL) {
  return new Promise((done) => {
    const req = http.request(`http://${host}:${port}/json/version`, { timeout: 2000, agent: false }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { if (data.length < 65536) data += c; });
      res.on('end', () => done(res.statusCode === 200 ? data : null));
      res.on('error', () => done(null));
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', () => done(null));
    req.end();
  });
}

/**
 * Make sure a local TradingView answers CDP on `port`.
 *   CDP answers                         -> { state: 'up' }
 *   running without CDP, after ~10s     -> throws; TradingView is left alone
 *   not running                         -> launch({ kill_existing: false }),
 *                                          { state: 'launched', ready, warning }
 * A failed launch throws "launch failed: ...".
 *
 * _deps: { probeCdp(port, host), isTvRunning(), launch(opts), delay(ms) }
 */
export async function ensureTradingView({ port, _deps } = {}) {
  const probe = _deps?.probeCdp || probeCdp;
  const running = _deps?.isTvRunning || (() => isTvRunning());
  const delay = _deps?.delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const cdpUp = async () => !!(await probe(port, LOCAL));

  let up = await cdpUp();
  if (!up && await running()) {
    // A single probe can stall past its timeout, so retry before deciding.
    // Never launch here: TradingView is already running.
    for (let i = 0; i < CDP_RETRY_TRIES && !up; i++) {
      await delay(CDP_RETRY_MS);
      up = await cdpUp();
    }
    if (!up) {
      throw new Error(`TradingView is running without CDP on ${LOCAL}:${port} (no answer within ${(CDP_RETRY_TRIES * CDP_RETRY_MS) / 1000}s). Not killing it. Close TradingView yourself and re-run (or start it with --remote-debugging-port=${port}).`);
    }
  }
  if (up) return { state: 'up' };

  // No TradingView process. kill_existing: false so launch() skips its
  // up-front kill of any TradingView started since the check above.
  const launch = _deps?.launch || (await import('./health.js')).launch;
  let result;
  try {
    result = await launch({ port, kill_existing: false });
  } catch (err) {
    throw new Error(`launch failed: ${err.message}`);
  }
  return { state: 'launched', ready: await cdpUp(), warning: result?.warning };
}
