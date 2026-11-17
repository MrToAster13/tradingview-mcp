/**
 * npm runs the `prepare` script on `npm install` and `npm ci`. It points
 * core.hooksPath at scripts/hooks, so a fresh clone gets the pre-push guard
 * with no manual step (ELI-694). Each test copies package.json, the install
 * script and the hooks into a temp dir. GIT_CEILING_DIRECTORIES stops git
 * from finding a repo above that dir, and the global and system git config
 * are switched off so the host's settings cannot leak in.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, cpSync, rmSync, writeFileSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const hasGit = spawnSync('git', ['--version']).status === 0;
const onWindows = process.platform === 'win32';

let scratch;
let seq = 0;

function env(extra = {}) {
  return {
    ...process.env,
    GIT_CEILING_DIRECTORIES: scratch,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com',
    GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com',
    ...extra,
  };
}

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8', env: env() });
  return { status: r.status, out: `${r.stdout}${r.stderr}`.trim() };
}

/** A fresh dir under the scratch dir, with this package's install files copied in. */
function makePackage(dir = join(scratch, `pkg${++seq}`)) {
  mkdirSync(join(dir, 'scripts'), { recursive: true });
  cpSync(join(ROOT, 'package.json'), join(dir, 'package.json'));
  cpSync(join(ROOT, 'scripts', 'hooks'), join(dir, 'scripts', 'hooks'), { recursive: true });
  cpSync(join(ROOT, 'scripts', 'install_hooks.js'), join(dir, 'scripts', 'install_hooks.js'));
  return dir;
}

/** Runs the package's prepare script in `dir` the way npm does: a shell in the package root. */
function prepare(dir, extraEnv = {}) {
  const r = spawnSync(PKG.scripts.prepare, { cwd: dir, shell: true, encoding: 'utf8', env: env(extraEnv) });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

function hooksPath(dir) {
  const r = git(dir, 'config', '--local', '--get', 'core.hooksPath');
  return r.status === 0 ? r.out : null;
}

describe('package.json prepare script', () => {
  it('runs scripts/install_hooks.js', () => {
    assert.match(PKG.scripts?.prepare ?? '', /\bnode scripts\/install_hooks\.js\b/);
  });
});

describe('hook install on npm install', { skip: !hasGit || onWindows }, () => {
  before(() => { scratch = realpathSync(mkdtempSync(join(tmpdir(), 'tvmcp-install-'))); });
  after(() => { rmSync(scratch, { recursive: true, force: true }); });

  it('sets core.hooksPath to scripts/hooks in a fresh clone', () => {
    const dir = makePackage();
    git(dir, 'init', '-q', '-b', 'main');
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(dir), 'scripts/hooks');
  });

  it('makes the clone refuse a push of a commit marked do not push', () => {
    const work = makePackage();
    const remote = join(scratch, `remote${seq}.git`);
    git(scratch, 'init', '-q', '--bare', remote);
    git(work, 'init', '-q', '-b', 'main');
    git(work, 'remote', 'add', 'origin', remote);
    assert.equal(prepare(work).status, 0);
    git(work, 'add', '-A');
    assert.equal(git(work, 'commit', '-q', '-m', 'Base').status, 0);
    assert.equal(git(work, 'push', '-q', 'origin', 'main').status, 0, 'an ordinary push was refused');
    writeFileSync(join(work, 'notes.txt'), 'local\n');
    git(work, 'add', 'notes.txt');
    assert.equal(git(work, 'commit', '-q', '-m', 'Local notes, do not push').status, 0);
    const r = git(work, 'push', 'origin', 'main');
    assert.notEqual(r.status, 0, 'the marked commit was pushed');
    assert.match(r.out, /do not push/i);
    assert.notEqual(git(work, 'rev-parse', 'HEAD').out, git(remote, 'rev-parse', 'main').out);
  });

  it('runs a second time without error and keeps scripts/hooks', () => {
    const dir = makePackage();
    git(dir, 'init', '-q', '-b', 'main');
    assert.equal(prepare(dir).status, 0);
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(dir), 'scripts/hooks');
  });

  it('exits 0 and creates no repo outside a git work tree', () => {
    const dir = makePackage();
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(existsSync(join(dir, '.git')), false);
  });

  it('exits 0 when git is not on PATH', (t) => {
    const nodeDir = dirname(process.execPath);
    if (spawnSync('git', ['--version'], { env: { PATH: nodeDir } }).status === 0) {
      t.skip('git sits next to node, so PATH cannot drop it');
      return;
    }
    const dir = makePackage();
    git(dir, 'init', '-q', '-b', 'main');
    const r = prepare(dir, { PATH: nodeDir });
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(dir), null);
  });

  it('leaves the config of an enclosing repo alone when the package sits in its subdirectory', () => {
    const outer = join(scratch, `outer${++seq}`);
    mkdirSync(outer);
    git(outer, 'init', '-q', '-b', 'main');
    const dir = makePackage(join(outer, 'vendor', 'tradingview-mcp'));
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(outer), null);
  });

  it('keeps a core.hooksPath that points somewhere else, and says so', () => {
    const dir = makePackage();
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'core.hooksPath', '.husky');
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(dir), '.husky');
    assert.match(r.out, /core\.hooksPath/);
  });

  it('keeps hooks already active in .git/hooks, and says so', () => {
    const dir = makePackage();
    git(dir, 'init', '-q', '-b', 'main');
    writeFileSync(join(dir, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const r = prepare(dir);
    assert.equal(r.status, 0, r.out);
    assert.equal(hooksPath(dir), null);
    assert.match(r.out, /pre-commit/);
  });
});
