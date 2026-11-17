/**
 * HTTP mode's tool allow list (ELI-849). HTTP mode can be public through
 * Tailscale Funnel, so it registers only HTTP_ALLOWED_TOOLS, the tools that
 * read the chart or draw on it. Every tool in src/tools/*.js has to sit in
 * HTTP_ALLOWED_TOOLS or in STDIO_ONLY_TOOLS, so a tool that an upstream merge
 * adds cannot reach HTTP mode before someone classifies it.
 *
 * Offline: builds servers in memory and reads source files. No CDP.
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import {
  createServer, HTTP_ALLOWED_TOOLS, STDIO_ONLY_TOOLS, applyHttpAllowList,
} from '../src/create_server.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const TOOLS_DIR = join(ROOT, 'src', 'tools');

const allowed = () => Object.keys(HTTP_ALLOWED_TOOLS).sort();
const stdioOnly = () => Object.keys(STDIO_ONLY_TOOLS).sort();

/** Map of tool name to the src/tools file that registers it, by source scan. */
function scanToolSources() {
  const found = new Map();
  for (const file of readdirSync(TOOLS_DIR).filter((f) => f.endsWith('.js')).sort()) {
    const src = readFileSync(join(TOOLS_DIR, file), 'utf8');
    for (const m of src.matchAll(/\.(?:tool|registerTool|registerToolTask)\(\s*['"`]([A-Za-z0-9_.-]+)['"`]/g)) {
      found.set(m[1], file);
    }
  }
  return found;
}

async function listTools(server) {
  const client = new Client({ name: 'http-tools-test', version: '0' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(a), client.connect(b)]);
  const { tools } = await client.listTools();
  await client.close();
  await server.close();
  return tools.map((t) => t.name).sort();
}

describe('every tool is classified for HTTP mode (ELI-849)', () => {
  let scanned;
  let registered;
  before(async () => {
    scanned = scanToolSources();
    registered = await listTools(createServer());
  });

  it('every tool in src/tools/*.js is in HTTP_ALLOWED_TOOLS or STDIO_ONLY_TOOLS', () => {
    const known = new Set([...allowed(), ...stdioOnly()]);
    const unclassified = [...new Set([...scanned.keys(), ...registered])].filter((n) => !known.has(n)).sort();
    assert.deepEqual(unclassified, [], `classify these in src/create_server.js: ${unclassified.join(', ')}`);
  });

  it('the source scan finds every tool the stdio server registers', () => {
    assert.deepEqual([...scanned.keys()].sort(), registered);
  });

  it('no tool is in both lists', () => {
    assert.deepEqual(allowed().filter((n) => Object.hasOwn(STDIO_ONLY_TOOLS, n)), []);
  });

  it('both lists name only tools that are registered', () => {
    const stale = [...allowed(), ...stdioOnly()].filter((n) => !registered.includes(n));
    assert.deepEqual(stale, []);
  });

  it('each stdio-only entry gives a reason', () => {
    for (const [name, why] of Object.entries(STDIO_ONLY_TOOLS)) {
      assert.ok(typeof why === 'string' && why.trim().length > 0, `${name} has no reason`);
    }
  });
});

describe('HTTP_ALLOWED_TOOLS holds only reads and drawing', () => {
  // A name token that marks a tool as one that changes something.
  const WRITE_VERBS = new Set([
    'set', 'add', 'remove', 'delete', 'create', 'save', 'close', 'new', 'switch', 'launch', 'update',
    'click', 'type', 'keyboard', 'start', 'stop', 'step', 'trade', 'compile', 'open', 'toggle',
    'scroll', 'hover', 'evaluate', 'focus', 'clear', 'copy', 'run', 'autoplay', 'manage', 'fullscreen',
  ]);

  it('each entry starts with "read:" or "draw:" and says what it touches', () => {
    for (const [name, why] of Object.entries(HTTP_ALLOWED_TOOLS)) {
      assert.match(why, /^(read|draw): \S/, name);
    }
  });

  it('every draw entry is a tool from src/tools/drawing.js', () => {
    const scanned = scanToolSources();
    for (const [name, why] of Object.entries(HTTP_ALLOWED_TOOLS)) {
      if (why.startsWith('draw:')) assert.equal(scanned.get(name), 'drawing.js', name);
    }
  });

  it('no read entry has a write verb in its name', () => {
    const writes = Object.entries(HTTP_ALLOWED_TOOLS)
      .filter(([, why]) => why.startsWith('read:'))
      .map(([name]) => name)
      .filter((name) => name.split('_').some((t) => WRITE_VERBS.has(t)));
    assert.deepEqual(writes, []);
  });
});

describe('order-capable and destructive tools are stdio-only', () => {
  // ELI-849 acceptance criterion 3, plus the six ELI-756 kept off HTTP.
  const MUST_BE_STDIO_ONLY = [
    'ui_click', 'ui_open_panel', 'pine_save', 'pine_set_source', 'alert_delete', 'watchlist_remove', 'tab_close',
    'ui_evaluate', 'tv_update', 'tv_launch', 'ui_type_text', 'ui_mouse_click', 'ui_keyboard',
  ];

  for (const name of MUST_BE_STDIO_ONLY) {
    it(`${name} is stdio-only`, () => {
      assert.ok(Object.hasOwn(STDIO_ONLY_TOOLS, name), `${name} is not in STDIO_ONLY_TOOLS`);
      assert.ok(!Object.hasOwn(HTTP_ALLOWED_TOOLS, name), `${name} is in HTTP_ALLOWED_TOOLS`);
    });
  }

  // Review finding: an HTTP client gets only a path on the host, and
  // method "api" calls TradingView's takeScreenshot(), which the Charting
  // Library docs say uploads the snapshot to TradingView's server.
  it('capture_screenshot is stdio-only', () => {
    assert.ok(Object.hasOwn(STDIO_ONLY_TOOLS, 'capture_screenshot'));
    assert.ok(!Object.hasOwn(HTTP_ALLOWED_TOOLS, 'capture_screenshot'));
  });
});

describe('docs point at the HTTP allow list', () => {
  const read = (f) => readFileSync(join(ROOT, f), 'utf8');

  // Review finding: CLAUDE.md tagged only the ELI-756 tools "(stdio only)",
  // which read as if every other tool worked over HTTP.
  it('CLAUDE.md says HTTP mode registers only HTTP_ALLOWED_TOOLS', () => {
    assert.match(read('CLAUDE.md'), /HTTP_ALLOWED_TOOLS/);
  });

  it('every tool that README.md or CLAUDE.md tags "(stdio only)" is in STDIO_ONLY_TOOLS', () => {
    for (const file of ['README.md', 'CLAUDE.md']) {
      for (const line of read(file).split('\n').filter((l) => /\(stdio only\)/i.test(l))) {
        for (const m of line.matchAll(/`([a-z_]+)`/g)) {
          if (!Object.hasOwn(HTTP_ALLOWED_TOOLS, m[1]) && !Object.hasOwn(STDIO_ONLY_TOOLS, m[1])) continue; // not a tool, e.g. `origin`
          assert.ok(Object.hasOwn(STDIO_ONLY_TOOLS, m[1]), `${file} tags ${m[1]} stdio only, but it is not in STDIO_ONLY_TOOLS`);
        }
      }
    }
  });
});

describe('applyHttpAllowList', () => {
  const ok = async () => ({ content: [{ type: 'text', text: 'ok' }] });

  it('drops tools registered with tool() or registerTool() unless allowed', async () => {
    const server = new McpServer({ name: 't', version: '0' });
    server.tool('chart_get_state', 'allowed', {}, ok);
    server.tool('upstream_new_tool', 'not classified', {}, ok);
    server.registerTool('upstream_registered_tool', { description: 'not classified' }, ok);
    applyHttpAllowList(server);
    assert.deepEqual(await listTools(server), ['chart_get_state']);
  });

  it('does not treat Object.prototype names as allowed', () => {
    // SDK 1.x keeps tools in a plain object and refuses these names, so a
    // null-prototype registry stands in for an SDK that does not.
    const registry = Object.assign(Object.create(null), { chart_get_state: {}, constructor: {}, toString: {} });
    applyHttpAllowList({ _registeredTools: registry });
    assert.deepEqual(Object.keys(registry), ['chart_get_state']);
  });

  it('throws instead of serving an unfiltered list when the SDK tool registry is missing', () => {
    assert.throws(() => applyHttpAllowList({}), /tool registry/);
  });

  it('throws when no allowed tool is left', () => {
    const server = new McpServer({ name: 't', version: '0' });
    server.tool('upstream_new_tool', 'not classified', {}, ok);
    assert.throws(() => applyHttpAllowList(server), /no allowed tool/);
  });
});

describe('README HTTP section names the allowed set', () => {
  function allowedTableNames() {
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const start = readme.search(/^## HTTP mode$/m);
    assert.ok(start >= 0, 'README has no "## HTTP mode" section');
    const rest = readme.slice(start);
    const next = rest.slice(3).search(/^## /m);
    const section = next < 0 ? rest : rest.slice(0, next + 3);
    const sub = section.search(/^### Allowed over HTTP$/m);
    assert.ok(sub >= 0, 'README HTTP section has no "### Allowed over HTTP" table');
    const names = new Set();
    for (const line of section.slice(sub).split('\n').slice(1)) {
      if (/^#{2,3} /.test(line)) break;
      if (!line.startsWith('| ')) continue;
      for (const m of line.matchAll(/`([a-z_]+)`/g)) names.add(m[1]);
    }
    return [...names].sort();
  }

  it('the "Allowed over HTTP" table names exactly HTTP_ALLOWED_TOOLS', () => {
    assert.deepEqual(allowedTableNames(), allowed());
  });
});
