/**
 * Tests for launch() in src/core/health.js.
 * Covers Windows MSIX handling: direct WindowsApps spawn, local-copy fallback
 * when spawn fails or CDP never binds, copy reuse, and classic-path launches.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { launch, msixPackageFamilyName, envWithoutElectronRunAsNode } from '../src/core/health.js';

const MSIX_EXE = 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe';
const LOCAL_COPY_EXE = `${process.env.LOCALAPPDATA || ''}\\tradingview-mcp\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\\TradingView.exe`;
const MSIX_PROFILE_DIR = join(process.env.LOCALAPPDATA || '', 'Packages', 'TradingView.Desktop_n534cwy3pjxzj', 'LocalCache', 'Roaming', 'TradingView');
const CDP_VERSION = JSON.stringify({ Browser: 'Chrome/140', 'User-Agent': 'TVDesktop/3.1.0' });

// ── Mock helpers ─────────────────────────────────────────────────────────

function mockChild(opts = {}) {
  const { failWith, exitAfterSpawn = false } = opts;
  const child = new EventEmitter();
  child.pid = 'pid' in opts ? opts.pid : 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  else if (exitAfterSpawn) queueMicrotask(() => child.emit('exit', 0));
  return child;
}

/**
 * Build a _deps bundle simulating a win32 MSIX environment.
 * @param {object} opts
 *   spawnFailures — spawn paths (substring) that emit EACCES
 *   cdpBindsFor  — spawn paths (substring) after which probeCdp starts succeeding
 *   copyExists   — local copy already present
 *   profileExists — the MSIX roaming profile dir exists under %LOCALAPPDATA%Packages
 *   tvRunning    — what the injected isTvRunning check reports
 *   tasklistOut  — when set, isTvRunning is not injected and execSync answers
 *                  tasklist with this text (exercises the default check)
 *   directPid    — pid of the direct WindowsApps child (undefined = no pid)
 *   directExits  — the direct WindowsApps child emits 'exit' right after spawn
 *   runningSeq   — successive isTvRunning answers (last one repeats)
 */
function msixDeps({ spawnFailures = [], cdpBindsFor = [], copyExists = false, profileExists = false, tvRunning = false, tasklistOut, directExits = false, runningSeq, ...rest } = {}) {
  const directPid = 'directPid' in rest ? rest.directPid : 12345;
  const state = { spawned: [], spawnCalls: [], copies: [], removed: [], killed: 0, killCmds: [], processKills: [], cdpUp: false, runningChecks: 0 };
  const deps = {
    existsSync: (p) => {
      if (p === MSIX_EXE) return true;
      if (p === MSIX_PROFILE_DIR) return profileExists;
      if (p.includes('tradingview-mcp')) return copyExists || state.copies.length > 0;
      return false;
    },
    execSync: (cmd) => {
      if (cmd.includes('Get-AppxPackage')) {
        return 'C:\\Program Files\\WindowsApps\\TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj\n';
      }
      if (cmd.includes('taskkill') || cmd.includes('pkill') || /^kill\b/.test(cmd)) { state.killed++; state.killCmds.push(cmd); return ''; }
      if (tasklistOut !== undefined && cmd.includes('tasklist')) { state.runningChecks++; return tasklistOut; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe, args, opts) => {
      state.spawned.push(exe);
      state.spawnCalls.push({ exe, args, opts });
      const fail = spawnFailures.some((s) => exe.includes(s));
      if (!fail && cdpBindsFor.some((s) => exe.includes(s))) state.cdpUp = true;
      if (fail) return mockChild({ failWith: 'EACCES' });
      if (exe.includes('WindowsApps')) return mockChild({ pid: directPid, exitAfterSpawn: directExits });
      return mockChild();
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    processKill: (pid, sig) => { state.killed++; state.processKills.push({ pid, sig }); },
  };
  if (tasklistOut === undefined) {
    deps.isTvRunning = async () => {
      const i = state.runningChecks++;
      if (!runningSeq) return tvRunning;
      return runningSeq[Math.min(i, runningSeq.length - 1)];
    };
  }
  return { deps, state };
}

// launch() only takes the MSIX code path on win32; skip elsewhere.
const onWindows = process.platform === 'win32';

describe('launch() — MSIX WindowsApps handling', { skip: !onWindows }, () => {
  it('direct WindowsApps spawn that binds CDP does not copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['WindowsApps'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, MSIX_EXE);
    assert.equal(result.msix_local_copy, undefined);
    assert.equal(state.copies.length, 0);
    assert.equal(result.cdp_url, 'http://127.0.0.1:9222');
  });

  it('EACCES on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ kill_existing: true, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.binary, LOCAL_COPY_EXE);
    assert.equal(state.copies.length, 1);
    assert.match(state.copies[0].src, /WindowsApps/);
    // stale cached version of another release is cleaned up first
    assert.equal(state.removed.length, 1);
    assert.match(state.removed[0], /3\.0\.0\.7652/);
    // the CDP-less direct instance is killed before relaunching from the copy
    assert.ok(state.killed >= 2);
  });

  it('CDP never binding on direct spawn falls back to local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.spawned.length, 2);
    assert.match(state.spawned[0], /WindowsApps/);
    assert.match(state.spawned[1], /tradingview-mcp/);
  });

  it('reuses an existing local copy without re-copying', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], copyExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.copies.length, 0);
  });

  it('returns cdp_ready:false warning when nothing binds', async () => {
    const { deps } = msixDeps({});
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.cdp_ready, false);
    assert.equal(result.msix_local_copy, true);
    assert.ok(result.warning);
  });
});

// ── kill_existing: false must not kill a TradingView the user has open ───

describe('launch() — MSIX fallback honours kill_existing: false', { skip: !onWindows }, () => {
  it('nothing running at start: kills only its own copy once, then spawns the local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: false });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.runningChecks, 1);
    assert.equal(state.killed, 1, 'no up-front kill, one kill before the local copy');
    assert.equal(state.spawned.length, 2);
    assert.match(state.spawned[1], /tradingview-mcp/);
  });

  it('TradingView running at start: does not kill and reports the failure', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: true });
    await assert.rejects(
      () => launch({ kill_existing: false, _deps: deps }),
      (err) => {
        assert.match(err.message, /did not bind CDP/);
        assert.match(err.message, /not killed because kill_existing is false/);
        return true;
      },
    );
    assert.equal(state.killed, 0);
    assert.equal(state.copies.length, 0);
    assert.equal(state.spawned.length, 1, 'local copy must not spawn');
  });

  it('TradingView running at start, direct spawn EACCES: still no kill', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], tvRunning: true });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /not killed because kill_existing is false/);
    assert.equal(state.killed, 0);
  });

  it('TradingView running at start, direct spawn binds CDP: succeeds without killing', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['WindowsApps'], tvRunning: true });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, undefined);
    assert.equal(state.killed, 0);
  });

  it('default kill_existing is false (ELI-696): a running TradingView is not killed', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: true });
    await assert.rejects(() => launch({ _deps: deps }), /not killed because kill_existing is false/);
    assert.equal(state.killed, 0);
  });

  it('kill_existing: true kills up front and in the fallback, with no running check', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: true });
    const result = await launch({ kill_existing: true, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.runningChecks, 0);
    assert.equal(state.killed, 2);
  });

  it('default running check reads tasklist through execSync: TradingView listed means no kill', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tasklistOut: 'TradingView.exe   4242 Console  1  250,000 K\r\n' });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /not killed/);
    assert.equal(state.runningChecks, 1);
    assert.equal(state.killed, 0);
  });

  it('default running check: tasklist with no match allows the fallback kill', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tasklistOut: 'INFO: No tasks are running which match the specified criteria.\r\n' });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.equal(state.killed, 1);
  });

  it('default running check: a failing tasklist counts as running, so no kill', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tasklistOut: '' });
    const execSync = deps.execSync;
    deps.execSync = (cmd, opts) => {
      if (cmd.includes('tasklist')) throw new Error('tasklist unavailable');
      return execSync(cmd, opts);
    };
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /not killed/);
    assert.equal(state.killed, 0);
  });
});

// ── kill_existing: false kills only its own spawn, by PID ────────────────

const killsByName = (cmds) => cmds.filter((c) => /\/IM\b/i.test(c) || /pkill/.test(c));

describe('launch() — kill_existing: false never kills by image name', { skip: !onWindows }, () => {
  it('nothing running, CDP never answers, child pid 4242: kills PID 4242 only', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: false, directPid: 4242 });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.msix_local_copy, true);
    assert.deepEqual(state.killCmds, ['taskkill /F /T /PID 4242']);
    assert.deepEqual(killsByName(state.killCmds), []);
    assert.equal(state.processKills.length, 0);
  });

  it('nothing running, CDP never answers, child has no pid: throws and kills nothing', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], tvRunning: false, directPid: undefined });
    await assert.rejects(
      () => launch({ kill_existing: false, _deps: deps }),
      (err) => {
        assert.match(err.message, /did not bind CDP/);
        assert.match(err.message, /not killed because kill_existing is false/);
        assert.match(err.message, /PID .* unknown/);
        return true;
      },
    );
    assert.deepEqual(state.killCmds, []);
    assert.equal(state.processKills.length, 0);
    assert.equal(state.copies.length, 0);
    assert.equal(state.spawned.length, 1, 'local copy must not spawn');
  });

  it('non-integer pid counts as unknown: throws and kills nothing', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], directPid: 0 });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /unknown/);
    assert.deepEqual(state.killCmds, []);
  });

  it('own child exited (possible MSIX hand-off) and TradingView now running: throws, kills nothing', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], directPid: 4242, directExits: true, runningSeq: [false, true] });
    await assert.rejects(() => launch({ kill_existing: false, _deps: deps }), /process this call started is gone/);
    assert.deepEqual(state.killCmds, []);
    assert.equal(state.spawned.length, 1);
  });

  it('own child exited and nothing running now: no kill, falls back to local copy', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], directPid: 4242, directExits: true, runningSeq: [false, false] });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.deepEqual(state.killCmds, [], 'an exited PID may be reused; never kill it');
    assert.equal(state.runningChecks, 2);
  });

  it('direct spawn EACCES, nothing running: no kill, falls back to local copy', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], tvRunning: false });
    const result = await launch({ kill_existing: false, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.deepEqual(state.killCmds, []);
  });

  it('kill_existing: true still kills by image name, before and in the fallback', async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'], directPid: 4242 });
    const result = await launch({ kill_existing: true, _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.deepEqual(state.killCmds, ['taskkill /F /IM TradingView.exe', 'taskkill /F /IM TradingView.exe']);
    assert.ok(!state.killCmds.some((c) => c.includes('/PID')));
  });
});

describe('launch() — classic install path', { skip: !onWindows }, () => {
  it('launches classic LOCALAPPDATA install without MSIX logic', async () => {
    const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const state = { spawned: [], cdpUp: false };
    const deps = {
      existsSync: (p) => p === classicExe,
      execSync: (cmd) => { if (cmd.includes('taskkill')) return ''; throw new Error(`unexpected: ${cmd}`); },
      spawn: (exe) => { state.spawned.push(exe); state.cdpUp = true; return mockChild(); },
      cpSync: () => { throw new Error('should not copy'); },
      rmSync: () => {},
      readdirSync: () => [],
      delay: async () => {},
      probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    };
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.binary, classicExe);
    assert.equal(result.msix_local_copy, undefined);
    assert.deepEqual(state.spawned, [classicExe]);
  });

  it('throws a helpful error when TradingView is not found', async () => {
    const deps = {
      existsSync: () => false,
      execSync: () => { throw new Error('not found'); },
      spawn: () => { throw new Error('should not spawn'); },
      cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
      delay: async () => {}, probeCdp: async () => null,
    };
    await assert.rejects(() => launch({ _deps: deps }), /TradingView not found/);
  });
});

// ── ELECTRON_RUN_AS_NODE scrubbing ───────────────────────────────────────
// Claude Code / T3 Code set ELECTRON_RUN_AS_NODE=1. If it leaks into the
// spawned TradingView.exe, Electron runs as plain Node and exits with
// "bad option: --remote-debugging-port=9222".

describe('envWithoutElectronRunAsNode()', () => {
  it('drops the variable case-insensitively and keeps everything else', () => {
    const input = { ELECTRON_RUN_AS_NODE: '1', electron_run_as_node: '1', PATH: 'p', LOCALAPPDATA: 'l' };
    const out = envWithoutElectronRunAsNode(input);
    assert.deepEqual(out, { PATH: 'p', LOCALAPPDATA: 'l' });
    assert.equal(input.ELECTRON_RUN_AS_NODE, '1', 'input must not be mutated');
  });

  it('handles an env without the variable', () => {
    assert.deepEqual(envWithoutElectronRunAsNode({ A: 'b' }), { A: 'b' });
    assert.deepEqual(envWithoutElectronRunAsNode({}), {});
  });
});

function withElectronRunAsNode(fn) {
  return async () => {
    const prev = process.env.ELECTRON_RUN_AS_NODE;
    process.env.ELECTRON_RUN_AS_NODE = '1';
    try { await fn(); }
    finally {
      if (prev === undefined) delete process.env.ELECTRON_RUN_AS_NODE;
      else process.env.ELECTRON_RUN_AS_NODE = prev;
    }
  };
}

function assertScrubbed(calls) {
  assert.ok(calls.length > 0);
  for (const { exe, opts } of calls) {
    assert.ok(opts && opts.env, `spawn of ${exe} passed no env (would inherit ELECTRON_RUN_AS_NODE)`);
    const leaked = Object.keys(opts.env).filter((k) => k.toUpperCase() === 'ELECTRON_RUN_AS_NODE');
    assert.deepEqual(leaked, [], `spawn of ${exe} leaked ELECTRON_RUN_AS_NODE`);
    assert.ok(Object.keys(opts.env).length > 0, 'env copy should keep the rest of the environment');
  }
}

describe('launch() — scrubs ELECTRON_RUN_AS_NODE from every spawn', { skip: !onWindows }, () => {
  it('direct WindowsApps spawn', withElectronRunAsNode(async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['WindowsApps'] });
    await launch({ _deps: deps });
    assertScrubbed(state.spawnCalls);
    assert.equal(process.env.ELECTRON_RUN_AS_NODE, '1', 'parent env must be left alone');
  }));

  it('direct spawn and local-copy fallback spawn', withElectronRunAsNode(async () => {
    const { deps, state } = msixDeps({ cdpBindsFor: ['tradingview-mcp'] });
    await launch({ _deps: deps });
    assert.equal(state.spawnCalls.length, 2);
    assertScrubbed(state.spawnCalls);
  }));

  it('classic install spawn', withElectronRunAsNode(async () => {
    const classicExe = `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`;
    const calls = [];
    let up = false;
    const deps = {
      existsSync: (p) => p === classicExe,
      execSync: () => '',
      spawn: (exe, args, opts) => { calls.push({ exe, args, opts }); up = true; return mockChild(); },
      cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
      delay: async () => {}, probeCdp: async () => (up ? CDP_VERSION : null),
    };
    await launch({ _deps: deps });
    assertScrubbed(calls);
  }));
});

// ── MSIX profile for the local-copy fallback ─────────────────────────────

describe('msixPackageFamilyName()', () => {
  it('derives name_publisherId from an install folder name', () => {
    assert.equal(msixPackageFamilyName('TradingView.Desktop_3.4.1.8194_x64__n534cwy3pjxzj'), 'TradingView.Desktop_n534cwy3pjxzj');
    assert.equal(msixPackageFamilyName('TradingView.Desktop_3.1.0.7818_x64__n534cwy3pjxzj'), 'TradingView.Desktop_n534cwy3pjxzj');
  });

  it('handles a non-empty resource id', () => {
    assert.equal(msixPackageFamilyName('Contoso.App_1.0.0.0_neutral_split.scale-100_8wekyb3d8bbwe'), 'Contoso.App_8wekyb3d8bbwe');
  });

  it('returns null for names that are not MSIX full names', () => {
    for (const bad of ['', 'TradingView', 'TradingView.Desktop_3.4.1.8194_x64', 'a__b', '_1_x64__pub', 'Name_1_x64__', undefined, null]) {
      assert.equal(msixPackageFamilyName(bad), null, String(bad));
    }
  });
});

describe('launch() — MSIX local copy uses the packaged profile', { skip: !onWindows }, () => {
  it('passes --user-data-dir when the MSIX roaming profile exists', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'], profileExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.user_data_dir, MSIX_PROFILE_DIR);
    const [direct, local] = state.spawnCalls;
    assert.ok(!direct.args.some((a) => a.startsWith('--user-data-dir')), 'direct MSIX spawn runs in its container; no override');
    assert.deepEqual(local.args, ['--remote-debugging-port=9222', `--user-data-dir=${MSIX_PROFILE_DIR}`]);
  });

  it('omits --user-data-dir when the profile dir does not exist', async () => {
    const { deps, state } = msixDeps({ spawnFailures: ['WindowsApps'], cdpBindsFor: ['tradingview-mcp'] });
    const result = await launch({ _deps: deps });
    assert.equal(result.msix_local_copy, true);
    assert.equal(result.user_data_dir, undefined);
    assert.deepEqual(state.spawnCalls[1].args, ['--remote-debugging-port=9222']);
  });

  it('keeps the profile flag on the cdp_ready:false path too', async () => {
    const { deps } = msixDeps({ profileExists: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.cdp_ready, false);
    assert.equal(result.user_data_dir, MSIX_PROFILE_DIR);
  });
});

// ── ELI-696: no kill by default, check CDP first, kill by exact name ─────

const HOST_TV_PATH = {
  linux: '/opt/TradingView/tradingview',
  darwin: '/Applications/TradingView.app/Contents/MacOS/TradingView',
  win32: `${process.env.LOCALAPPDATA}\\TradingView\\TradingView.exe`,
}[process.platform] || '/opt/TradingView/tradingview';

function hostDeps({ cdpUpAtStart = false } = {}) {
  const state = { spawned: [], killCmds: [], processKills: [], cdpUp: cdpUpAtStart };
  const deps = {
    existsSync: (p) => p === HOST_TV_PATH,
    execSync: (cmd) => {
      if (/taskkill|pkill|^kill\b/.test(cmd)) { state.killCmds.push(cmd); return ''; }
      return '';
    },
    spawn: (exe) => { state.spawned.push(exe); state.cdpUp = true; return mockChild(); },
    cpSync: () => {}, rmSync: () => {}, readdirSync: () => [],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
    processKill: (pid, sig) => { state.processKills.push({ pid, sig }); },
    isTvRunning: async () => false,
  };
  return { deps, state };
}

describe('launch() — default never kills TradingView (ELI-696)', () => {
  it('kill_existing defaults to false: no kill command runs', async () => {
    const { deps, state } = hostDeps();
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.deepEqual(state.killCmds, []);
    assert.deepEqual(state.processKills, []);
    assert.deepEqual(state.spawned, [HOST_TV_PATH]);
  });

  it('returns the running TradingView when CDP already answers, and spawns nothing', async () => {
    const { deps, state } = hostDeps({ cdpUpAtStart: true });
    const result = await launch({ _deps: deps });
    assert.equal(result.success, true);
    assert.equal(result.already_running, true);
    assert.deepEqual(state.spawned, []);
    assert.deepEqual(state.killCmds, []);
  });

  it('kill_existing: true on Linux and Mac kills by exact process name, never pkill -f', { skip: onWindows }, async () => {
    const { deps, state } = hostDeps();
    await launch({ kill_existing: true, _deps: deps });
    assert.equal(state.killCmds.length, 1);
    assert.match(state.killCmds[0], /^pkill .*-x /);
    assert.ok(!/-f\b/.test(state.killCmds[0]), `kill command matches full command lines: ${state.killCmds[0]}`);
  });
});
