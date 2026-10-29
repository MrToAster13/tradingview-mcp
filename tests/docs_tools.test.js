/**
 * The tool docs must match the registered tools (ELI-700 C081). Builds the
 * stdio server in memory and lists its tools; nothing connects to CDP.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/create_server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => readFileSync(join(ROOT, f), 'utf8');

async function registeredTools() {
  const server = createServer();
  const client = new Client({ name: 'docs-test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

function readmeToolReference() {
  const readme = read('README.md');
  const m = /^## Tool Reference \((\d+) MCP tools\)$/m.exec(readme);
  assert.ok(m, 'README has no "## Tool Reference (N MCP tools)" heading');
  const rest = readme.slice(m.index + m[0].length);
  const end = rest.search(/^## /m);
  return { count: Number(m[1]), body: end < 0 ? rest : rest.slice(0, end) };
}

describe('tool docs match the registry', () => {
  let tools;
  before(async () => { tools = await registeredTools(); });

  it('README tool reference heading gives the registered tool count', () => {
    assert.equal(readmeToolReference().count, tools.length);
  });

  it('README tool tables name exactly the registered tools', () => {
    const named = new Set();
    for (const line of readmeToolReference().body.split('\n')) {
      if (!line.startsWith('| `')) continue;
      for (const m of line.split('|')[1].matchAll(/`([a-z_]+)`/g)) named.add(m[1]);
    }
    const missing = tools.filter((t) => !named.has(t));
    const extra = [...named].filter((t) => !tools.includes(t));
    assert.deepEqual({ missing, extra }, { missing: [], extra: [] });
  });

  it('every "N tools" count in README, CLAUDE.md and the server instructions matches', () => {
    for (const file of ['README.md', 'CLAUDE.md', 'src/create_server.js']) {
      for (const m of read(file).matchAll(/\b(\d+) (?:MCP )?tools\b/g)) {
        assert.equal(Number(m[1]), tools.length, `${file}: "${m[0]}"`);
      }
    }
  });

  it('CLAUDE.md names every registered tool', () => {
    const claude = read('CLAUDE.md');
    assert.deepEqual(tools.filter((t) => !claude.includes(`\`${t}\``)), []);
  });
});
