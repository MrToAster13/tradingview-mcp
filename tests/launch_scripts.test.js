/**
 * The launch scripts (ELI-696, ELI-853). Each one is a thin wrapper over
 * `node scripts/tv_up.js --no-http`, so the one bring-up rule in
 * src/core/tv_process.js (check CDP first, never kill) covers them all.
 * The wrappers run against a copy beside a fake tv_up.js in a temp folder,
 * so these tests never start TradingView or touch port 9222.
 *
 * The process match now lives in isTvRunning(). Its pgrep command must find
 * a TradingView binary and never the MCP server, whose command line holds
 * "tradingview-mcp". That part runs pgrep against real processes, so it
 * needs pgrep and skips without it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdtempSync, copyFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tvProcessMatchCommand } from '../src/core/tv_process.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = {
  linux: { file: join(ROOT, 'scripts', 'launch_tv_debug_linux.sh'), binName: 'tradingview' },
  mac: { file: join(ROOT, 'scripts', 'launch_tv_debug_mac.sh'), binName: 'TradingView' },
};
const hasPgrep = process.platform !== 'win32'
  && spawnSync('pgrep', ['-x', 'no-such-process-name-xyz'], { stdio: 'ignore' }).status === 1;

const PLATFORM = { linux: 'linux', mac: 'darwin' };

// PIDs that isTvRunning()'s pgrep command matches on this platform.
function runTvPids(name) {
  const r = spawnSync('bash', ['-c', tvProcessMatchCommand(PLATFORM[name])], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}

const settle = () => new Promise((r) => setTimeout(r, 200));

const ALL_SCRIPTS = {
  linux: join(ROOT, 'scripts', 'launch_tv_debug_linux.sh'),
  mac: join(ROOT, 'scripts', 'launch_tv_debug_mac.sh'),
  windows: join(ROOT, 'scripts', 'launch_tv_debug.bat'),
};
const hasBash = spawnSync('bash', ['-c', 'exit 0'], { stdio: 'ignore' }).status === 0;

// A fake tv_up.js that prints what it got and exits with FAKE_TV_UP_EXIT.
// Plain CommonJS-safe code, since the temp folder has no package.json.
const FAKE_TV_UP = "console.log('FAKE ' + JSON.stringify({ argv: process.argv.slice(2), port: process.env.TV_CDP_PORT || null })); process.exit(Number(process.env.FAKE_TV_UP_EXIT || 0));\n";

// Copy a launch script next to a fake tv_up.js and run it. Never runs the real tv_up.js.
function runWrapper(name, args, extraEnv = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tvmcp-wrap-'));
  try {
    const src = ALL_SCRIPTS[name];
    const copy = join(dir, src.split(/[\\/]/).pop());
    // A Windows checkout with core.autocrlf gives the .sh files CRLF; macOS and Linux get LF.
    const text = readFileSync(src, 'utf8');
    writeFileSync(copy, name === 'windows' ? text : text.replace(/\r\n/g, '\n'));
    writeFileSync(join(dir, 'tv_up.js'), FAKE_TV_UP);
    const env = { ...process.env, ...extraEnv };
    delete env.TV_CDP_PORT;
    delete env.CDP_PORT;
    Object.assign(env, extraEnv);
    const r = name === 'windows'
      ? spawnSync('cmd.exe', ['/d', '/c', copy, ...args], { encoding: 'utf8', env, timeout: 30000, windowsHide: true })
      : spawnSync('bash', [copy, ...args], { encoding: 'utf8', env, timeout: 30000 });
    const line = (r.stdout || '').split(/\r?\n/).find((l) => l.startsWith('FAKE '));
    return { status: r.status, got: line ? JSON.parse(line.slice(5)) : null, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('ELI-853: launch scripts are thin wrappers over tv_up.js --no-http', () => {
  for (const [name, file] of Object.entries(ALL_SCRIPTS)) {
    describe(`${name} launch script`, () => {
      it('calls tv_up.js with --no-http', () => {
        const src = readFileSync(file, 'utf8');
        assert.match(src, /tv_up\.js"?\s+--no-http/);
      });

      it('has no CDP probe, process check or kill of its own', () => {
        const src = readFileSync(file, 'utf8').split(/\r?\n/)
          .filter((l) => !/^\s*(#|REM\b|rem\b|::)/.test(l)).join('\n');
        for (const re of [/curl/, /json\/version/, /tasklist/, /taskkill/, /pgrep/, /pkill/, /\bkill\b/, /KILL_EXISTING/, /--remote-debugging-port/]) {
          assert.ok(!re.test(src), `${name} script still has ${re}`);
        }
      });

      const canRun = name === 'windows' ? process.platform === 'win32' : hasBash;
      it('passes the port argument as TV_CDP_PORT and exits with tv_up.js status', { skip: !canRun }, () => {
        const r = runWrapper(name, ['9333'], { FAKE_TV_UP_EXIT: '3' });
        assert.deepEqual(r.got, { argv: ['--no-http'], port: '9333' }, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(r.status, 3);
      });

      it('defaults the port to 9222 and exits 0 when tv_up.js does', { skip: !canRun }, () => {
        const r = runWrapper(name, []);
        assert.deepEqual(r.got, { argv: ['--no-http'], port: '9222' }, `stdout: ${r.stdout} stderr: ${r.stderr}`);
        assert.equal(r.status, 0);
      });
    });
  }
});

describe('ELI-853: launch_tv_debug.vbs', () => {
  it('is removed: it started TradingView with no CDP or running check', () => {
    assert.equal(existsSync(join(ROOT, 'scripts', 'launch_tv_debug.vbs')), false);
  });

  it('is named in no doc', () => {
    for (const doc of ['README.md', 'SETUP_GUIDE.md']) {
      assert.ok(!readFileSync(join(ROOT, doc), 'utf8').includes('launch_tv_debug.vbs'), `${doc} names launch_tv_debug.vbs`);
    }
  });

  it('README no longer offers KILL_EXISTING for the scripts', () => {
    assert.ok(!readFileSync(join(ROOT, 'README.md'), 'utf8').includes('KILL_EXISTING'));
  });
});

for (const [name, { file, binName }] of Object.entries(SCRIPTS)) {
  describe(`${name} launch script`, () => {
    it('never matches processes by full command line', () => {
      const src = readFileSync(file, 'utf8');
      assert.ok(!/pkill\s+-f/.test(src), 'script runs pkill -f');
      assert.ok(!/pgrep[^\n]*\s-f/.test(src), 'script runs pgrep -f');
    });

    it('kills a running TradingView only when KILL_EXISTING=1', () => {
      const src = readFileSync(file, 'utf8');
      const killAt = src.search(/pkill|xargs kill/);
      if (killAt < 0) return;
      assert.match(src.slice(0, killAt), /KILL_EXISTING/);
    });

    describe('tv_pids() against live processes', { skip: !hasPgrep }, () => {
      let dir; let server; let tv;
      before(async () => {
        dir = mkdtempSync(join(tmpdir(), 'tvmcp-pgrep-'));
        // Shaped like the MCP server: the name is node, the argv names tradingview-mcp.
        mkdirSync(join(dir, 'tradingview-mcp', 'src'), { recursive: true });
        server = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', join(dir, 'tradingview-mcp', 'src', 'server.js')], { stdio: 'ignore' });
        // A process whose name is the TradingView binary. Node runs under any
        // file name. A copy of sleep does not always: on Ubuntu 26.04 sleep is
        // a multi-call coreutils binary that picks its tool by argv[0] and
        // exits. Linux names the process after the symlink. Other systems get
        // a copy, because they may name it after the symlink target.
        const fakeTv = join(dir, binName);
        if (process.platform === 'linux') symlinkSync(process.execPath, fakeTv);
        else copyFileSync(process.execPath, fakeTv);
        tv = spawn(fakeTv, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' });
        await settle();
      });
      after(() => {
        server?.kill();
        tv?.kill();
        rmSync(dir, { recursive: true, force: true });
      });

      it('keeps the fake TradingView process running until pgrep looks', () => {
        assert.equal(tv.exitCode, null, 'fake TradingView process exited');
        assert.equal(tv.signalCode, null, 'fake TradingView process was killed');
      });

      it('does not match the MCP server process', () => {
        assert.ok(!runTvPids(name).includes(server.pid), 'tv_pids matched the MCP server');
      });

      it('matches the TradingView binary', () => {
        assert.ok(runTvPids(name).includes(tv.pid), 'tv_pids missed the TradingView process');
      });
    });
  });
}
