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
  const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8').replace(/\r\n/g, '\n');
  const job = ci.slice(ci.indexOf('\n  no-push-marker:'));

  it('ci.yml checks pull request commits for a do-not-push marker', () => {
    assert.match(job, /scripts\/hooks\/check-event/);
    assert.match(job, /github\.event\.pull_request\.base\.sha/);
    assert.match(job, /github\.event\.pull_request\.head\.sha/);
  });

  // ELI-694 follow-up: the job ran only on pull requests, so a direct push to
  // main skipped it.
  it('ci.yml also checks the commits of a push to main, from github.event.before to github.sha', () => {
    assert.match(ci, /^on:\n {2}push:\n {4}branches: \[main\]/m);
    assert.doesNotMatch(job, /^ {4}if:/m, 'the no-push-marker job is limited by an if: condition');
    assert.match(job, /github\.event\.before/);
    assert.match(job, /github\.sha/);
  });
});

// ELI-694 follow-up: CI picks the range per event. A push checks
// before..after. An all-zero before (the push created the branch) or a before
// missing from the clone (a force-push) checks every commit reachable from the
// new tip, so the check never passes a range it could not bound.
describe('check-event picks the commits a GitHub event added', { skip: !hasGit || onWindows }, () => {
  const CHECK_EVENT = join(HOOKS_DIR, 'check-event');
  const ZERO = '0'.repeat(40);
  const MISSING = 'deadbeef'.repeat(5);
  let dir; let base; let marked; let tip;
  const sha = () => git(dir, 'rev-parse', 'HEAD').out.trim();
  const run = (...args) => spawnSync(CHECK_EVENT, args, { cwd: dir, encoding: 'utf8' });
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tvmcp-event-'));
    git(dir, 'init', '-q', '-b', 'main');
    commit(dir, 'Base'); base = sha();
    commit(dir, 'Private paths, do not push'); marked = sha();
    commit(dir, 'Clean change'); tip = sha();
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('is tracked as executable', () => {
    assert.ok(statSync(CHECK_EVENT).mode & 0o111, 'check-event is not executable');
  });

  it('push: passes when every new commit is clean', () => {
    const r = run('push', marked, tip);
    assert.equal(r.status, 0, r.stderr);
  });

  it('push: fails when a new commit is marked', () => {
    const r = run('push', base, tip);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /do not push/i);
  });

  it('push with an all-zero before: checks every commit reachable from the new tip', () => {
    assert.equal(run('push', ZERO, tip).status, 1);
    const r = run('push', ZERO, base);
    assert.equal(r.status, 0, r.stderr);
  });

  it('push with a before sha missing from the clone: checks every commit reachable from the new tip', () => {
    assert.equal(run('push', MISSING, tip).status, 1);
    const r = run('push', MISSING, base);
    assert.equal(r.status, 0, r.stderr);
  });

  it('pull_request: checks base..head', () => {
    assert.equal(run('pull_request', base, tip).status, 1);
    const r = run('pull_request', marked, tip);
    assert.equal(r.status, 0, r.stderr);
  });

  it('fails closed on a pull request range it cannot resolve', () => {
    const r = run('pull_request', MISSING, tip);
    assert.equal(r.status, 2, r.stderr);
  });

  it('fails closed on an unknown event or a missing argument', () => {
    assert.equal(run('workflow_dispatch', base, tip).status, 2);
    assert.equal(run('push', base).status, 2);
    assert.equal(run('push', base, '').status, 2);
  });
});

// Review finding TVMCP-R5: GitHub's merge commit carries the PR title in its
// body. A title that names the guard ("the do-not-push hook") passed the pull
// request run, which checks only the branch commits, then failed the push run
// on main, and every later fallback scan of main failed on that merge commit.
describe('check-event on a push that adds a merge commit', { skip: !hasGit || onWindows }, () => {
  const CHECK_EVENT = join(HOOKS_DIR, 'check-event');
  const ZERO = '0'.repeat(40);
  const MISSING = 'deadbeef'.repeat(5);
  let dir; let base; let merge; let badMerge;
  const sha = () => git(dir, 'rev-parse', 'HEAD').out.trim();
  const run = (...args) => spawnSync(CHECK_EVENT, args, { cwd: dir, encoding: 'utf8' });
  const commitFile = (file, message) => {
    writeFileSync(join(dir, file), `${Math.random()}\n`);
    git(dir, 'add', file);
    assert.equal(git(dir, 'commit', '-q', '-m', message).status, 0);
  };
  before(() => {
    dir = mkdtempSync(join(tmpdir(), 'tvmcp-merge-'));
    git(dir, 'init', '-q', '-b', 'main');
    commitFile('a.txt', 'Base'); base = sha();
    git(dir, 'checkout', '-q', '-b', 'feature');
    commitFile('b.txt', 'Install the pre-push hook on npm install');
    git(dir, 'checkout', '-q', 'main');
    assert.equal(git(dir, 'merge', '-q', '--no-ff', 'feature', '-m',
      'Merge pull request #1 from feature', '-m', 'ci(hooks): install the do-not-push hook on npm install').status, 0);
    merge = sha();
    git(dir, 'checkout', '-q', '-b', 'private', base);
    commitFile('c.txt', 'Private paths, do not push');
    git(dir, 'checkout', '-q', 'main');
    assert.equal(git(dir, 'merge', '-q', '--no-ff', 'private', '-m', 'Merge pull request #2 from private').status, 0);
    badMerge = sha();
  });
  after(() => { rmSync(dir, { recursive: true, force: true }); });

  it('passes when only the merge commit message names the marker', () => {
    const r = run('push', base, merge);
    assert.equal(r.status, 0, r.stderr);
  });

  it('passes a later full-history scan of that main', () => {
    for (const from of [ZERO, MISSING, '']) {
      const r = run('push', from, merge);
      assert.equal(r.status, 0, `before=${from || '(empty)'}: ${r.stderr}`);
    }
  });

  it('still fails when the merge brings in a marked commit', () => {
    const r = run('push', merge, badMerge);
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /do not push/i);
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
