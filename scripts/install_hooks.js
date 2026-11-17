#!/usr/bin/env node
/**
 * Points core.hooksPath at scripts/hooks, so the pre-push hook refuses
 * commits marked do not push (ELI-694). package.json runs this as the
 * `prepare` script on `npm install` and `npm ci`.
 *
 * It changes nothing and exits 0 when:
 * - git is missing, or the package root is not a git work tree (a tarball);
 * - the package root is a subdirectory of some other repo;
 * - core.hooksPath already points somewhere else;
 * - the default hooks dir already holds active hooks, which a hooksPath
 *   would switch off.
 * The last two print how to install the hook by hand. It never fails an
 * install.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HOOKS_PATH = 'scripts/hooks';
const MANUAL = `To install it by hand: git config core.hooksPath ${HOOKS_PATH}`;

function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' });
  return { ok: !r.error && r.status === 0, out: (r.stdout || '').trim() };
}

/** Names of the hooks git would run from `dir`, skipping the shipped *.sample files. */
function activeHooks(dir) {
  try {
    return readdirSync(dir).filter((f) => !f.endsWith('.sample') && statSync(join(dir, f)).isFile());
  } catch {
    return [];
  }
}

function install() {
  if (git('rev-parse', '--is-inside-work-tree').out !== 'true') return;
  const prefix = git('rev-parse', '--show-prefix');
  if (!prefix.ok || prefix.out !== '') return;

  const current = git('config', '--get', 'core.hooksPath');
  if (current.ok) {
    if (current.out !== HOOKS_PATH) {
      console.warn(`install_hooks: core.hooksPath is already ${current.out}, so the do-not-push pre-push hook is not installed. ${MANUAL}`);
    }
    return;
  }

  const hooksDir = git('rev-parse', '--git-path', 'hooks');
  const existing = hooksDir.ok ? activeHooks(resolve(ROOT, hooksDir.out)) : [];
  if (existing.length) {
    console.warn(`install_hooks: ${hooksDir.out} holds active hooks (${existing.join(', ')}). Setting core.hooksPath would switch them off, so the do-not-push pre-push hook is not installed. ${MANUAL}`);
    return;
  }

  if (git('config', 'core.hooksPath', HOOKS_PATH).ok) {
    console.log(`install_hooks: set core.hooksPath to ${HOOKS_PATH}`);
  } else {
    console.warn(`install_hooks: could not set core.hooksPath. ${MANUAL}`);
  }
}

try {
  install();
} catch (err) {
  console.warn(`install_hooks: skipped, ${err.message}. ${MANUAL}`);
}
