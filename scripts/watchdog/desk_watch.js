#!/usr/bin/env node
// Desktop watchdog (ELI-754). Hermes runs this every 5 minutes on the Windows desktop through
// a thin no-agent cron wrapper. Each run checks, and repairs where it safely can:
//   - TradingView answering CDP on :9222. Down -> run `scripts/tv_up.js --no-http`, which
//     launches TradingView only when none runs (it never kills one). The watchdog leaves the
//     MCP HTTP server and the Funnel alone, so their idle shutdown keeps the Funnel closed
//     (ELI-848, ELI-756). Start a remote session with `node scripts/tv_up.js`.
//   - The combo tester (docs/combo-tester.md). Lock holder dead -> start it again, detached.
//     No successful "stored" cycle for over 35 minutes -> alert. Skip and failure lines do not
//     count, so a frozen chart, the wrong tab, changed history or a corrupt store all show up.
//   - C: free space and memory use against limits.
// It messages Telegram, relayed through the Mac mini's `hermes send`, only when a state changes
// or a repair runs, and writes a heartbeat to the Mac every run so the Mac can tell when the
// desktop goes quiet. Usage: node scripts/watchdog/desk_watch.js (settings below, env overrides).
import { readFileSync, writeFileSync, existsSync, statfsSync, statSync, openSync, renameSync, rmSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { freemem, totalmem } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { probeCdp } from '../../src/core/tv_process.js';

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const STORED = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) stored /;

// Minutes since the last "stored" line of the tester log (UTC stamps), or null when there is none.
export function lastStoredAgeMin(logText, nowMs) {
  const lines = String(logText).split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = STORED.exec(lines[i]);
    if (m) return Math.round((nowMs - Date.parse(`${m[1]}T${m[2]}Z`)) / 60000);
  }
  return null;
}

// storeAgeMin, when given, is the age of combo-data/store.json, which the tester saves only after a
// successful cycle; the fresher of it and the log's last stored line counts.
export function checkTester({ lockPid, alive, logText, now, staleMin, restart, storeAgeMin = null }) {
  if (!lockPid || !alive(lockPid)) {
    let pid;
    try {
      pid = restart();
    } catch (e) {
      return { state: 'failed', msg: `Combo tester was not running and would not start again: ${e.message}` };
    }
    return { state: 'ok', repaired: true, msg: `Combo tester was not running; started it again (pid ${pid}).` };
  }
  const ages = [lastStoredAgeMin(logText, now), storeAgeMin].filter((a) => a !== null && a !== undefined);
  const age = ages.length ? Math.min(...ages) : null;
  if (age === null || age > staleMin) {
    const since = age === null ? 'in its log' : `for ${age} minutes`;
    return { state: 'stale', msg: `Combo tester (pid ${lockPid}) is running but has had no successful cycle ${since}. Its log says why: skips, timeouts or errors.` };
  }
  return { state: 'ok' };
}

export function checkDevice({ freeGb, memPct, diskMinGb, memMaxPct }) {
  const problems = [];
  if (freeGb < diskMinGb) problems.push(`C: has ${freeGb.toFixed(1)} GB free`);
  if (memPct > memMaxPct) problems.push(`memory is ${Math.round(memPct)}% used`);
  return problems.length ? { state: 'low', msg: `Desktop: ${problems.join(' and ')}.` } : { state: 'ok' };
}

const CDP_HOST = '127.0.0.1';
const CDP_PORT = 9222;
const CDP_URL = `http://${CDP_HOST}:${CDP_PORT}/json/version`;
// CDP-only bring-up: no API key, no HTTP server, no Funnel (ELI-848).
export const TV_UP_ARGS = ['scripts/tv_up.js', '--no-http'];

export async function checkTradingView({ up, tvUp, sleep }) {
  if (await up(CDP_URL)) return { state: 'ok' };
  const r = await tvUp();
  await sleep();
  if (await up(CDP_URL)) {
    return { state: 'ok', repaired: true, msg: 'TradingView was not answering CDP; tv_up brought it back.' };
  }
  return { state: 'down', msg: `TradingView is not answering CDP and tv_up did not fix it (exit ${r?.code}: ${r?.tail ?? ''}). If TradingView is open without debugging, close it.` };
}

const RECOVERED = {
  tradingview: 'TradingView is answering CDP again.',
  tester: 'Combo tester is logging again: its last cycle succeeded.',
  device: 'Desktop disk and memory are back within limits.',
};

// New state and the messages worth sending: changes, repairs and recoveries.
export function diffEvents(prev, results) {
  const state = {};
  const events = [];
  for (const [name, r] of Object.entries(results)) {
    state[name] = r.state;
    if (r.repaired) events.push(r.msg);
    else if (r.state !== 'ok' && r.state !== prev[name]) events.push(r.msg);
    else if (r.state === 'ok' && prev[name] && prev[name] !== 'ok') events.push(RECOVERED[name] ?? `${name} is ok again.`);
  }
  return { state, events };
}

// Whether pid is a live process this account can signal. EPERM means another account owns the pid,
// so it is not our tester: a reused pid from a stale lock.
export function pidAlive(pid, kill = process.kill) {
  try {
    kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function parseState(text) {
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

const TV_UP_TIMEOUT_MS = 180000;
const SETTLE_MS = 20000;
const PROBE_MS = 5000;
const SSH_TIMEOUT_MS = 20000;
const RESTART_WAIT_MS = 5000;
// Worst case for one run: tv_up, the settle wait, two CDP probes, the restart check, relay and heartbeat.
export const RUN_BUDGET_MS = TV_UP_TIMEOUT_MS + SETTLE_MS + 2 * PROBE_MS + RESTART_WAIT_MS + 2 * SSH_TIMEOUT_MS;

export async function runWatch({ checks, prev, relay, heartbeat }) {
  const results = {};
  for (const [name, fn] of Object.entries(checks)) {
    try {
      results[name] = await fn();
    } catch (e) {
      results[name] = { state: 'error', msg: `${name} check failed: ${e.message}` };
    }
  }
  const out = diffEvents(prev, results);
  if (out.events.length) {
    try {
      await relay(`Desktop watchdog:\n- ${out.events.join('\n- ')}`);
    } catch {
      // Not delivered: keep the old state where it changed, so the next run sends it again. A check
      // with no old state (the first run) keeps its new one.
      for (const name of Object.keys(out.state)) if (name in prev && out.state[name] !== prev[name]) out.state[name] = prev[name];
    }
  }
  try { await heartbeat(); } catch { /* the Mac alerts when heartbeats stop */ }
  return out;
}

// ---- real probes and actions ----

// Settings from the environment. A number setting that does not parse keeps its default and logs
// one warning, so a typo cannot turn a check off: with NaN every comparison is false.
export function readSettings(env = process.env, warn = (line) => console.log(line)) {
  const num = (name, fallback, { positive = false } = {}) => {
    const raw = env[name];
    if (raw === undefined || String(raw).trim() === '') return fallback;
    const n = Number(raw);
    if (Number.isFinite(n) && (positive ? n > 0 : n >= 0)) return n;
    warn(`Desktop watchdog: ${name} is "${raw}", not a number ${positive ? 'above 0' : 'of 0 or more'}; using ${fallback}.`);
    return fallback;
  };
  return {
    state: env.DESK_WATCH_STATE || join(env.LOCALAPPDATA || '.', 'hermes', 'scripts', 'desk_watch.state.json'),
    mcpRepo: env.DESK_WATCH_MCP_REPO || REPO,
    testerRepo: env.DESK_WATCH_TESTER_REPO || REPO,
    testerConfig: env.DESK_WATCH_TESTER_CONFIG || 'scripts/combo/signals.example.json',
    testerOut: env.DESK_WATCH_TESTER_OUT || 'combo-data',
    testerEvery: num('DESK_WATCH_TESTER_EVERY', 15, { positive: true }),
    staleMin: num('DESK_WATCH_STALE_MIN', 35, { positive: true }),
    diskMinGb: num('DESK_WATCH_DISK_MIN_GB', 10),
    memMaxPct: num('DESK_WATCH_MEM_MAX_PCT', 90),
    relay: env.DESK_WATCH_RELAY !== '0',
  };
}

// Arguments for the restarted combo tester.
export function testerArgs(s) {
  return ['scripts/combo/run.js', '--config', s.testerConfig, '--out', s.testerOut, '--every', String(s.testerEvery)];
}

// Whether TradingView answers CDP, through the shared probe in src/core/tv_process.js (ELI-853).
export async function cdpAnswers(probe = probeCdp) {
  return (await probe(CDP_PORT, CDP_HOST, { timeoutMs: PROBE_MS })) != null;
}

const up = () => cdpAnswers();

function ssh(command, input = '') {
  const r = spawnSync('ssh', ['-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'macmini', command], { input, timeout: SSH_TIMEOUT_MS, windowsHide: true });
  if (r.status !== 0) throw new Error(`ssh exit ${r.status}`);
}

const MAC_PATH = 'export PATH="$HOME/.local/bin:$PATH"; ';

function realChecks(s) {
  const outDir = resolve(s.testerRepo, s.testerOut);
  return {
    tradingview: () => checkTradingView({
      up,
      tvUp: async () => {
        const r = spawnSync(process.execPath, TV_UP_ARGS, { cwd: s.mcpRepo, encoding: 'utf8', timeout: TV_UP_TIMEOUT_MS, windowsHide: true });
        return { code: r.status, tail: (r.stdout || '').trim().split(/\r?\n/).pop()?.slice(0, 200) };
      },
      sleep: () => new Promise((r) => setTimeout(r, SETTLE_MS)),
    }),
    tester: () => {
      let lockPid = null;
      try { lockPid = Number(readFileSync(join(outDir, 'lock'), 'utf8').trim()) || null; } catch { lockPid = null; }
      let logText = '';
      try { logText = readFileSync(join(outDir, 'run.log'), 'utf8').slice(-20000); } catch { logText = ''; }
      let storeAgeMin = null;
      try { storeAgeMin = Math.round((Date.now() - statSync(join(outDir, 'store.json')).mtimeMs) / 60000); } catch { storeAgeMin = null; }
      return checkTester({
        lockPid, alive: pidAlive, logText, storeAgeMin, now: Date.now(), staleMin: s.staleMin,
        restart: () => {
          rmSync(join(outDir, 'lock'), { force: true }); // its holder is dead or not ours
          const log = openSync(join(outDir, 'run.log'), 'a');
          const child = spawn(process.execPath, testerArgs(s),
            { cwd: s.testerRepo, detached: true, stdio: ['ignore', log, log], windowsHide: true });
          child.unref();
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RESTART_WAIT_MS);
          if (!pidAlive(child.pid)) throw new Error('it exited at once; see combo-data/run.log');
          return child.pid;
        },
      });
    },
    device: () => {
      const fs = statfsSync('C:\\');
      return checkDevice({ freeGb: (fs.bavail * fs.bsize) / 1e9, memPct: 100 * (1 - freemem() / totalmem()), diskMinGb: s.diskMinGb, memMaxPct: s.memMaxPct });
    },
  };
}

async function main() {
  const s = readSettings();
  const prev = existsSync(s.state) ? parseState(readFileSync(s.state, 'utf8')) : {};
  const out = await runWatch({
    checks: realChecks(s),
    prev,
    relay: async (text) => {
      console.log(text);
      if (s.relay) ssh(`${MAC_PATH}hermes send -t telegram -q -f -`, text);
    },
    heartbeat: async () => { if (s.relay) ssh('date +%s > ~/.desk_watch_heartbeat'); },
  });
  writeFileSync(`${s.state}.tmp`, JSON.stringify(out.state));
  renameSync(`${s.state}.tmp`, s.state);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.log(`Desktop watchdog error: ${e.message}`);
  });
}
