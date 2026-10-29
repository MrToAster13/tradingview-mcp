/**
 * scripts/hooks/pre-push refuses a push that carries a commit whose message
 * says not to push it (ELI-694). Builds throwaway git repos in a temp dir and
 * pushes to a local bare remote; nothing touches the network.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
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
