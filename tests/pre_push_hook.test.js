/**
 * scripts/hooks/pre-push refuses a push that carries a commit whose message
 * says not to push it (ELI-694). Builds throwaway git repos in a temp dir and
 * pushes to a local bare remote; nothing touches the network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_DIR = join(ROOT, 'scripts', 'hooks');
const HOOK = join(HOOKS_DIR, 'pre-push');
const hasGit = spawnSync('git', ['--version']).status === 0;
const onWindows = process.platform === 'win32';

function git(cwd, ...args) {
  const r = spawnSync('git', args, {
    cwd, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function commit(cwd, message) {
  writeFileSync(join(cwd, 'f.txt'), `${Math.random()}\n`);
  git(cwd, 'add', 'f.txt');
  assert.equal(git(cwd, 'commit', '-q', '-m', message).status, 0);
}

describe('pre-push hook', { skip: !hasGit || onWindows }, () => {
  let dir; let work;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tvmcp-hook-'));
    const remote = join(dir, 'remote.git');
    work = join(dir, 'work');
    git(dir, 'init', '-q', '--bare', remote);
    git(dir, 'init', '-q', '-b', 'main', work);
    git(work, 'config', 'core.hooksPath', HOOKS_DIR);
    git(work, 'remote', 'add', 'origin', remote);
    commit(work, 'First commit');
    assert.equal(git(work, 'push', '-q', 'origin', 'main').status, 0);
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is tracked as executable', () => {
    assert.ok(statSync(HOOK).mode & 0o111, 'pre-push is not executable');
    assert.match(readFileSync(HOOK, 'utf8'), /^#!/);
  });

  it('allows an ordinary push', () => {
    commit(work, 'Ordinary change');
    assert.equal(git(work, 'push', '-q', 'origin', 'main').status, 0);
  });

  for (const message of [
    'Add backtest reports\n\nContains a local home path and chart layout id; do not push',
    'WIP: DO NOT PUSH',
    "Scratch notes, don't push",
    'do-not-push: local config',
  ]) {
    it(`refuses a commit that says ${JSON.stringify(message.split('\n').pop())}`, () => {
      git(work, 'checkout', '-q', '-B', 'side', 'main');
      commit(work, message);
      const r = git(work, 'push', 'origin', 'side');
      assert.notEqual(r.status, 0, 'push went through');
      assert.match(r.out, /do not push/i);
      assert.equal(git(work, 'ls-remote', '--exit-code', 'origin', 'refs/heads/side').status, 2, 'branch reached the remote');
      git(work, 'checkout', '-q', 'main');
      git(work, 'branch', '-q', '-D', 'side');
    });
  }

  it('refuses when the marked commit is buried under a later clean one', () => {
    git(work, 'checkout', '-q', '-B', 'buried', 'main');
    commit(work, 'Private paths, do not push');
    commit(work, 'Later clean commit');
    const r = git(work, 'push', 'origin', 'buried');
    assert.notEqual(r.status, 0);
    git(work, 'checkout', '-q', 'main');
  });

  it('allows a branch delete', () => {
    git(work, 'push', '-q', 'origin', 'main:to-delete');
    assert.equal(git(work, 'push', '-q', 'origin', '--delete', 'to-delete').status, 0);
  });
});

describe('CI guard', () => {
  it('ci.yml checks pull request commits for a do-not-push marker', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.match(ci, /scripts\/hooks\/check-no-push/);
  });
});

// Review finding TVMCP-R1: the check refused the commit that added it,
// because that commit's message quoted the marker spellings.
describe('check-no-push on messages that only describe the hook', { skip: !hasGit || onWindows }, () => {
  const CHECK = join(HOOKS_DIR, 'check-no-push');

  it('passes a commit whose message describes the hook without the marker', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-check-'));
    try {
      git(dir, 'init', '-q', '-b', 'main');
      commit(dir, 'Base');
      commit(dir, 'ELI-694: Refuse pushes of commits that carry the no-push marker');
      const r = spawnSync(CHECK, ['HEAD~1..HEAD'], { cwd: dir, encoding: 'utf8' });
      assert.equal(r.status, 0, r.stderr);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  // The no-push-marker CI job checks pull request commits. The suite does not
  // check this clone's own branch, because a local branch may carry a marked
  // commit (TVMCP-R4).
});

// Review finding TVMCP-R3: the check failed open. A range git could not
// resolve gave an empty loop and exit 0, so nothing was checked.
describe('check-no-push on a range git cannot resolve', { skip: !hasGit || onWindows }, () => {
  const CHECK = join(HOOKS_DIR, 'check-no-push');
  let dir;
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tvmcp-range-'));
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'Base');
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('exits non-zero on an unresolvable range', () => {
    const r = spawnSync(CHECK, ['bogus..HEAD'], { cwd: dir, encoding: 'utf8' });
    assert.notEqual(r.status, 0, 'check passed a range it could not resolve');
    assert.match(r.stderr, /cannot resolve/);
  });

  it('pre-push still checks the pushed commits when the remote tip is missing locally', () => {
    git(dir, 'checkout', '-q', '-B', 'marked', 'main');
    commit(dir, 'Private paths, do not push');
    const localSha = git(dir, 'rev-parse', 'HEAD').out.trim();
    const missing = 'deadbeef'.repeat(5);
    const r = spawnSync(HOOK, ['origin', 'unused-url'], {
      cwd: dir, encoding: 'utf8',
      input: `refs/heads/marked ${localSha} refs/heads/marked ${missing}\n`,
    });
    assert.notEqual(r.status, 0, 'pre-push passed a marked commit');
    assert.match(r.stderr, /do not push/i);
    git(dir, 'checkout', '-q', 'main');
  });
});

// Review finding TVMCP-R4: a test ran check-no-push on this clone's own
// origin/main..HEAD, so the suite failed on any local branch carrying a
// marked commit, which is the workflow the hook allows. This copies the test
// file and hooks into a scratch repo with such a commit and runs the file.
// The inner run sets TVMCP_HOOK_INNER so it does not recurse.
describe('suite on a local branch carrying a marked commit', { skip: !hasGit || onWindows || !!process.env.TVMCP_HOOK_INNER }, () => {
  it('pre_push_hook.test.js passes when the developer branch holds a marked commit', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-self-'));
    try {
      mkdirSync(join(dir, 'tests'));
      mkdirSync(join(dir, 'scripts'));
      mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
      cpSync(join(ROOT, 'tests', 'pre_push_hook.test.js'), join(dir, 'tests', 'pre_push_hook.test.js'));
      cpSync(HOOKS_DIR, join(dir, 'scripts', 'hooks'), { recursive: true });
      cpSync(join(ROOT, '.github', 'workflows', 'ci.yml'), join(dir, '.github', 'workflows', 'ci.yml'));
      git(dir, 'init', '-q', '-b', 'main');
      git(dir, 'add', '-A');
      assert.equal(git(dir, 'commit', '-q', '-m', 'Base').status, 0);
      git(dir, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
      commit(dir, 'WIP local paths, do not push');
      // node:test skips a nested --test run while NODE_TEST_CONTEXT is set.
      const env = { ...process.env, TVMCP_HOOK_INNER: '1' };
      delete env.NODE_TEST_CONTEXT;
      const r = spawnSync(process.execPath, ['--test', join('tests', 'pre_push_hook.test.js')], {
        cwd: dir, encoding: 'utf8', env,
      });
      assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
