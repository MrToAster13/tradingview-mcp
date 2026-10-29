/**
 * Test wiring (ELI-700 C080, C090): npm test runs every offline test file
 * found by name, CI cannot skip a new file, e2e reads the CDP address from
 * connection.js, and the CI audit step can fail the job.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { listOfflineTests } from '../scripts/run_offline_tests.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));

describe('offline test runner', () => {
  it('lists every tests/*.test.js file except e2e', () => {
    const expected = readdirSync(join(ROOT, 'tests')).filter((f) => f.endsWith('.test.js') && f !== 'e2e.test.js').sort();
    assert.deepEqual(listOfflineTests(join(ROOT, 'tests')).map((p) => basename(p)), expected);
  });

  it('picks up a new test file with no other change', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tvmcp-runner-'));
    try {
      for (const f of ['a.test.js', 'e2e.test.js', 'brand_new.test.js', 'helper.js']) writeFileSync(join(dir, f), '');
      assert.deepEqual(listOfflineTests(dir).map((p) => basename(p)), ['a.test.js', 'brand_new.test.js']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('npm test and test:unit use the runner and name no test file by hand', () => {
    for (const name of ['test', 'test:unit']) {
      const script = pkg.scripts[name];
      assert.match(script, /scripts\/run_offline_tests\.js/, `${name}: ${script}`);
      assert.ok(!/tests\/[a-z_]+\.test\.js/.test(script), `${name} lists test files: ${script}`);
    }
  });

  it('e2e stays an explicit script', () => {
    assert.match(pkg.scripts['test:e2e'], /tests\/e2e\.test\.js/);
  });
});

describe('e2e CDP address', () => {
  it('reads host and port from connection.js instead of hard-coding localhost:9222', () => {
    const src = readFileSync(join(ROOT, 'tests', 'e2e.test.js'), 'utf8');
    assert.match(src, /import \{[^}]*CDP_HOST[^}]*\} from '\.\.\/src\/connection\.js'/);
    assert.ok(!/host: 'localhost'/.test(src), 'e2e still connects to localhost');
    assert.ok(!/port: 9222/.test(src), 'e2e still hard-codes port 9222');
  });
});

describe('CI audit step', () => {
  it('can fail the job', () => {
    const ci = readFileSync(join(ROOT, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.ok(ci.includes('npm audit'), 'no audit step');
    const step = ci.slice(ci.indexOf('npm audit')).split(/\n\s*- name:/)[0];
    assert.ok(!/continue-on-error:\s*true/.test(step), 'audit step has continue-on-error: true');
  });
});
