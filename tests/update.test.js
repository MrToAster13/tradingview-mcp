/**
 * Tests for update() in src/core/update.js.
 * Covers guards (non-git, wrong branch, dirty tree, diverged) and the
 * update path (fast-forward, npm ci only when the lockfile changed).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { update } from '../src/core/update.js';

const OLD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const NEW = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

/**
 * Build DI deps simulating a git repo.
 * @param {object} opts — branch, dirty, remoteSha, ahead, behind, lockChanged
 */
function gitDeps({ branch = 'main', dirty = '', remoteSha = OLD, ahead = 0, behind = 0, lockChanged = false, npmFails = false, originUrl = 'https://github.com/MrToAster13/tradingview-mcp.git' } = {}) {
  const state = { merged: false, npmCi: 0, cmds: [] };
  const deps = {
    existsSync: () => true,
    repoRoot: 'C:/fake/repo',
    execSync: (cmd) => {
      state.cmds.push(cmd);
      if (cmd.includes('rev-parse --abbrev-ref')) return branch;
      if (cmd.includes('remote get-url origin')) return originUrl;
      if (cmd.includes('status --porcelain')) return dirty;
      if (cmd.includes('rev-parse HEAD')) return state.merged ? remoteSha : OLD;
      if (cmd.includes('fetch origin')) return '';
      if (cmd.includes('rev-parse origin/main')) return remoteSha;
      if (cmd.includes('rev-list --count origin/main..HEAD')) return String(ahead);
      if (cmd.includes('rev-list --count HEAD..origin/main')) return String(behind);
      if (cmd.includes('diff --name-only')) return lockChanged ? 'package-lock.json' : '';
      if (cmd.includes('merge --ff-only')) { state.merged = true; return ''; }
      if (cmd.startsWith('npm ci')) {
        state.npmCi++;
        if (npmFails) throw new Error('EACCES');
        return '';
      }
      throw new Error(`unexpected cmd: ${cmd}`);
    },
  };
  return { deps, state };
}

describe('update() — guards', () => {
  it('refuses non-git installs with a clone hint', async () => {
    const { deps } = gitDeps();
    deps.existsSync = () => false;
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /git clone/);
  });

  it('refuses on a non-main branch', async () => {
    const { deps, state } = gitDeps({ branch: 'fix/my-feature' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.branch, 'fix/my-feature');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses on a dirty working tree and lists changed files', async () => {
    const { deps, state } = gitDeps({ dirty: 'M src/core/data.js\n?? notes.txt' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.deepEqual(r.changed_files, ['M src/core/data.js', '?? notes.txt']);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('refuses when local main has commits not on origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, ahead: 2, behind: 5 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fast-forward is not possible/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('reports fetch failures without merging', async () => {
    const { deps, state } = gitDeps();
    const orig = deps.execSync;
    deps.execSync = (cmd) => { if (cmd.includes('fetch')) throw new Error('could not resolve host'); return orig(cmd); };
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.match(r.error, /fetch failed/);
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });
});

describe('update() — update paths', () => {
  it('reports up_to_date without merging when HEAD matches origin', async () => {
    const { deps, state } = gitDeps({ remoteSha: OLD });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, false);
    assert.equal(r.status, 'up_to_date');
    assert.ok(!state.cmds.some(c => c.includes('merge')), 'no merge attempted');
  });

  it('fast-forwards and skips npm ci when the lockfile is unchanged', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 3 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.commits_pulled, 3);
    assert.equal(r.from_commit, OLD.slice(0, 8));
    assert.equal(r.to_commit, NEW.slice(0, 8));
    assert.equal(r.deps_installed, false);
    assert.equal(state.npmCi, 0);
    assert.equal(r.restart_required, true);
  });

  it('runs npm ci when the lockfile changed', async () => {
    const { deps, state } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.deps_installed, true);
    assert.equal(state.npmCi, 1);
  });

  it('still reports the code update when npm ci fails, with a warning', async () => {
    const { deps } = gitDeps({ remoteSha: NEW, behind: 1, lockChanged: true, npmFails: true });
    const r = await update({ _deps: deps });
    assert.equal(r.success, true);
    assert.equal(r.updated, true);
    assert.equal(r.deps_installed, false);
    assert.match(r.warning, /npm ci failed/);
  });
});

describe('update() — origin must be this fork (ELI-695)', () => {
  const touchedRemote = (cmds) => cmds.some((c) => c.includes('fetch') || c.includes('merge'));

  it('refuses when origin is the upstream repo, and names the fork', async () => {
    const { deps, state } = gitDeps({ originUrl: 'https://github.com/tradesdontlie/tradingview-mcp.git', remoteSha: NEW, behind: 1 });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.equal(r.origin, 'https://github.com/tradesdontlie/tradingview-mcp.git');
    assert.match(r.error, /MrToAster13\/tradingview-mcp/);
    assert.match(r.error, /git remote set-url origin/);
    assert.ok(!touchedRemote(state.cmds), 'fetched or merged from the wrong origin');
  });

  it('refuses a look-alike repo name', async () => {
    const { deps, state } = gitDeps({ originUrl: 'https://github.com/MrToAster13/tradingview-mcp-old.git' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.ok(!touchedRemote(state.cmds));
  });

  for (const url of [
    'git@github.com:MrToAster13/tradingview-mcp.git',
    'https://github.com/MrToAster13/tradingview-mcp',
    'https://github.com/mrtoaster13/tradingview-mcp.git',
    'ssh://git@github.com/MrToAster13/tradingview-mcp.git',
  ]) {
    it(`accepts the fork as ${url}`, async () => {
      const { deps } = gitDeps({ originUrl: url });
      const r = await update({ _deps: deps });
      assert.equal(r.success, true);
      assert.equal(r.status, 'up_to_date');
    });
  }

  it('does not echo credentials from a refused origin (TVMCP-R7)', async () => {
    const { deps, state } = gitDeps({ originUrl: 'https://x-access-token:SECRET123@github.com/tradesdontlie/tradingview-mcp.git' });
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.ok(!JSON.stringify(r).includes('SECRET123'), 'tv_update returned the token in origin');
    assert.ok(!JSON.stringify(r).includes('x-access-token'), 'tv_update returned the user part of origin');
    assert.match(r.origin, /github\.com\/tradesdontlie\/tradingview-mcp/);
    assert.ok(!touchedRemote(state.cmds));
  });

  it('the non-git hint clones the fork', async () => {
    const { deps } = gitDeps();
    deps.existsSync = () => false;
    const r = await update({ _deps: deps });
    assert.match(r.error, /github\.com\/MrToAster13\/tradingview-mcp/);
    assert.ok(!/tradesdontlie/.test(r.error));
  });
});

// ELI-851 item 5: git failures after the guards return { success: false, error } in one line
// instead of throwing raw git output into the tool result.
describe('update() — git failures return one line (ELI-851)', () => {
  const gitError = (cmd, stderr) => Object.assign(new Error(`Command failed: git ${cmd}\n${stderr}`), { stderr: Buffer.from(stderr) });

  it('returns { success: false, error } with one line when merge --ff-only fails', async () => {
    const { deps } = gitDeps({ remoteSha: NEW, behind: 1 });
    const orig = deps.execSync;
    deps.execSync = (cmd) => {
      if (cmd.includes('merge --ff-only')) throw gitError('merge --ff-only origin/main', 'error: Your local changes to the following files would be overwritten by merge:\n\tsrc/server.js\nAborting\n');
      return orig(cmd);
    };
    const r = await update({ _deps: deps });
    assert.equal(r.success, false);
    assert.equal(typeof r.error, 'string');
    assert.doesNotMatch(r.error, /\n/);
    assert.match(r.error, /merge --ff-only/);
    assert.match(r.error, /would be overwritten by merge/);
  });

  for (const step of ['status --porcelain', 'rev-parse HEAD', 'rev-parse origin/main', 'rev-list --count origin/main..HEAD', 'rev-list --count HEAD..origin/main', 'diff --name-only']) {
    it(`returns { success: false } instead of throwing when git ${step} fails`, async () => {
      const { deps, state } = gitDeps({ remoteSha: NEW, behind: 1 });
      const orig = deps.execSync;
      deps.execSync = (cmd) => {
        if (cmd.includes(step) && !cmd.includes('--abbrev-ref')) throw gitError(step, 'fatal: bad object HEAD\nmore detail');
        return orig(cmd);
      };
      const r = await update({ _deps: deps });
      assert.equal(r.success, false);
      assert.doesNotMatch(r.error, /\n/);
      assert.match(r.error, /bad object HEAD/);
      assert.ok(!state.cmds.some((c) => c.includes('merge')), 'no merge attempted');
    });
  }
});
