/**
 * The README must name every TradingView host the code sends requests to
 * (ELI-697). Scans src/ and scripts/ for TradingView URLs and fails when one
 * names a host that the README's network calls section does not list.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SECTION_HEADING = '## Network calls to TradingView servers';
const URL_HOST_RE = /\b(?:https?|wss?):\/\/((?:[a-z0-9-]+\.)*tradingview\.com)\b/gi;
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts']);

function codeFiles(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...codeFiles(p));
    else if (CODE_EXT.has(extname(name))) out.push(p);
  }
  return out;
}

function hostsInCode() {
  const hosts = new Map();
  for (const file of [...codeFiles(join(ROOT, 'src')), ...codeFiles(join(ROOT, 'scripts'))]) {
    for (const m of readFileSync(file, 'utf8').matchAll(URL_HOST_RE)) {
      const host = m[1].toLowerCase();
      if (!hosts.has(host)) hosts.set(host, file.slice(ROOT.length + 1));
    }
  }
  return hosts;
}

function readmeSection() {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  const start = readme.indexOf(SECTION_HEADING);
  assert.ok(start >= 0, `README.md has no "${SECTION_HEADING}" section`);
  const rest = readme.slice(start + SECTION_HEADING.length);
  const end = rest.search(/^## /m);
  return end < 0 ? rest : rest.slice(0, end);
}

describe('README network calls section', () => {
  it('names every TradingView host that src/ and scripts/ send requests to', () => {
    const section = readmeSection().toLowerCase();
    const missing = [...hostsInCode()].filter(([host]) => !section.includes(`\`${host}\``));
    assert.deepEqual(missing.map(([h, f]) => `${h} (first seen in ${f})`), []);
  });

  it('finds the hosts the code is known to call, so the scan itself works', () => {
    const hosts = hostsInCode();
    for (const h of ['pricealerts.tradingview.com', 'pine-facade.tradingview.com', 'symbol-search.tradingview.com']) {
      assert.ok(hosts.has(h), `scan did not find ${h}`);
    }
  });

  it('says for each listed tool whether the call leaves from Node or the app session', () => {
    const rows = readmeSection().split('\n').filter((l) => /^\|\s*`[a-z_]+`/.test(l));
    assert.ok(rows.length > 0, 'no tool rows in the network table');
    for (const row of rows) assert.match(row, /Node process|app session/, row);
  });

  it('no longer claims the tool never contacts TradingView servers', () => {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    assert.ok(!/does not connect to TradingView's servers/i.test(readme));
    assert.ok(!/^- Connect to TradingView's servers or APIs$/m.test(readme));
  });
});
