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

function mockChild({ failWith } = {}) {
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  if (failWith) queueMicrotask(() => child.emit('error', Object.assign(new Error(failWith), { code: failWith })));
  return child;
}

/**
 * Build a _deps bundle simulating a win32 MSIX environment.
 * @param {object} opts
 *   spawnFailures — spawn paths (substring) that emit EACCES
 *   cdpBindsFor  — spawn paths (substring) after which probeCdp starts succeeding
 *   copyExists   — local copy already present
 *   profileExists — the MSIX roaming profile dir exists under %LOCALAPPDATA%Packages
 */
function msixDeps({ spawnFailures = [], cdpBindsFor = [], copyExists = false, profileExists = false } = {}) {
  const state = { spawned: [], spawnCalls: [], copies: [], removed: [], killed: 0, cdpUp: false };
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
      if (cmd.includes('taskkill')) { state.killed++; return ''; }
      throw new Error(`unexpected execSync: ${cmd}`);
    },
    spawn: (exe, args, opts) => {
      state.spawned.push(exe);
      state.spawnCalls.push({ exe, args, opts });
      const fail = spawnFailures.some((s) => exe.includes(s));
      if (!fail && cdpBindsFor.some((s) => exe.includes(s))) state.cdpUp = true;
      return mockChild(fail ? { failWith: 'EACCES' } : {});
    },
    cpSync: (src, dst) => { state.copies.push({ src, dst }); },
    rmSync: (p) => { state.removed.push(p); },
    readdirSync: () => ['TradingView.Desktop_3.0.0.7652_x64__n534cwy3pjxzj'],
    delay: async () => {},
    probeCdp: async () => (state.cdpUp ? CDP_VERSION : null),
  };
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
    const result = await launch({ _deps: deps });
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
