/**
 * The Linux and Mac launch scripts (ELI-696). Their process match must find
 * a TradingView binary and never the MCP server, whose command line holds
 * "tradingview-mcp". Runs each script's tv_pids function with pgrep against
 * real processes, so that part needs pgrep and skips without it.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, mkdtempSync, copyFileSync, symlinkSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPTS = {
  linux: { file: join(ROOT, 'scripts', 'launch_tv_debug_linux.sh'), binName: 'tradingview' },
  mac: { file: join(ROOT, 'scripts', 'launch_tv_debug_mac.sh'), binName: 'TradingView' },
};
const hasPgrep = process.platform !== 'win32'
  && spawnSync('pgrep', ['-x', 'no-such-process-name-xyz'], { stdio: 'ignore' }).status === 1;

function tvPidsFunction(file) {
  const src = readFileSync(file, 'utf8');
  const m = /^tv_pids\(\) \{[\s\S]*?^\}/m.exec(src);
  assert.ok(m, `${file} defines no tv_pids() function`);
  return m[0];
}

function runTvPids(file) {
  const r = spawnSync('bash', ['-c', `${tvPidsFunction(file)}\ntv_pids`], { encoding: 'utf8' });
  return r.stdout.split(/\s+/).filter(Boolean).map(Number);
}

const settle = () => new Promise((r) => setTimeout(r, 200));

for (const [name, { file, binName }] of Object.entries(SCRIPTS)) {
  describe(`${name} launch script`, () => {
    it('never matches processes by full command line', () => {
      const src = readFileSync(file, 'utf8');
      assert.ok(!/pkill\s+-f/.test(src), 'script runs pkill -f');
      assert.ok(!/pgrep[^\n]*\s-f/.test(src), 'script runs pgrep -f');
    });

    it('checks CDP before it starts or kills anything', () => {
      const src = readFileSync(file, 'utf8');
      const probe = src.search(/curl[^\n]*json\/version/);
      const launchAt = src.search(/"\$APP" --remote-debugging-port/);
      assert.ok(probe >= 0 && probe < launchAt, 'no CDP probe before the launch');
      const killAt = src.search(/pkill|xargs kill/);
      if (killAt >= 0) assert.ok(probe < killAt, 'kill comes before the CDP probe');
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
        assert.ok(!runTvPids(file).includes(server.pid), 'tv_pids matched the MCP server');
      });

      it('matches the TradingView binary', () => {
        assert.ok(runTvPids(file).includes(tv.pid), 'tv_pids missed the TradingView process');
      });
    });
  });
}
