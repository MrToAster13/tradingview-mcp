/**
 * Docs and CI must agree with each other (ELI-852): the Node version in
 * README, package.json engines and the CI matrix, the agent model rule, and
 * the upstream merge steps in CONTRIBUTING.md. Reads files only.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

/** Lowest major version in the CI node-version matrix. */
function ciMinNodeMajor() {
  const m = /node-version:\s*\[([^\]]+)\]/.exec(read('.github/workflows/ci.yml'));
  assert.ok(m, 'ci.yml has no node-version matrix');
  const majors = m[1].split(',').map((v) => Number(/(\d+)/.exec(v)[1]));
  return Math.min(...majors);
}

describe('Node version agrees across README, package.json and CI', () => {
  it('package.json engines.node is ">=N" with N the lowest CI major', () => {
    const pkg = JSON.parse(read('package.json'));
    assert.equal(pkg.engines?.node, `>=${ciMinNodeMajor()}`);
  });

  it('README states the lowest CI major as the Node requirement', () => {
    const versions = [...read('README.md').matchAll(/Node\.js (\d+)\+/g)].map((m) => Number(m[1]));
    assert.ok(versions.length > 0, 'README names no "Node.js N+" requirement');
    for (const v of versions) assert.equal(v, ciMinNodeMajor());
  });
});

describe('agent files', () => {
  it('no agent names a Sonnet model', () => {
    for (const f of readdirSync(join(ROOT, 'agents')).filter((n) => n.endsWith('.md'))) {
      const model = /^model:\s*(\S+)/m.exec(read(`agents/${f}`))?.[1];
      assert.ok(model, `agents/${f} names no model`);
      assert.doesNotMatch(model, /sonnet/i, `agents/${f}`);
    }
  });

  it('performance-analyst runs on Opus', () => {
    assert.match(read('agents/performance-analyst.md'), /^model:\s*opus\s*$/m);
  });
});

describe('CONTRIBUTING.md', () => {
  it('has a "Merging upstream" section with the remote, fetch, branch, test and PR steps', () => {
    const doc = read('CONTRIBUTING.md');
    const m = /^## Merging upstream$/m.exec(doc);
    assert.ok(m, 'no "## Merging upstream" heading');
    const rest = doc.slice(m.index + m[0].length);
    const end = rest.search(/^## /m);
    const body = end < 0 ? rest : rest.slice(0, end);
    for (const step of [/git remote add upstream/, /git fetch upstream/, /git (?:switch -c|checkout -b)/, /git merge upstream\/main/, /npm test/, /pull request/i]) {
      assert.match(body, step);
    }
  });
});

describe('lint scope', () => {
  it('npm run lint covers src/, scripts/ and tests/', () => {
    const lint = JSON.parse(read('package.json')).scripts.lint.split(/\s+/);
    assert.equal(lint[0], 'eslint');
    for (const dir of ['src/', 'scripts/', 'tests/']) assert.ok(lint.includes(dir), `lint skips ${dir}`);
  });
});
