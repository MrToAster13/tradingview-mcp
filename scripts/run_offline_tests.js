#!/usr/bin/env node
/**
 * Runs every offline test: each tests/*.test.js except e2e.test.js, which
 * needs a live TradingView with CDP (run it with `npm run test:e2e`).
 * Files are found by name, so a new test file runs in CI with no edit to
 * package.json. Works on Node 20, whose `node --test` takes no globs.
 *
 * Usage: node scripts/run_offline_tests.js [extra node --test flags]
 */
import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const TESTS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'tests');
const LIVE_ONLY = new Set(['e2e.test.js']);

/** Sorted paths of the offline test files directly under `dir`. */
export function listOfflineTests(dir = TESTS_DIR) {
  return readdirSync(dir)
    .filter((f) => f.endsWith('.test.js') && !LIVE_ONLY.has(f))
    .sort()
    .map((f) => join(dir, f));
}

if (import.meta.url === pathToFileURL(resolve(process.argv[1] || '')).href) {
  const files = listOfflineTests();
  if (!files.length) {
    console.error(`No test files found in ${TESTS_DIR}`);
    process.exit(1);
  }
  const r = spawnSync(process.execPath, ['--test', ...process.argv.slice(2), ...files], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}
