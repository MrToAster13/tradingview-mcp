/*
 * Checks the template pins in cdp.mjs. The test reads cdp.mjs as text and parses its
 * TEMPLATE_SHA256 block. It never imports cdp.mjs, so no chart client loads here.
 * Each digest is recomputed from the TEMPLATES text that templates.mjs exports.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TEMPLATES } from './templates.mjs';

const FOLDER = dirname(fileURLToPath(import.meta.url));
const NAMES = ['identity', 'discover', 'read_history', 'read_shapes', 'draw_trade'];

function pinnedDigests() {
  const text = readFileSync(join(FOLDER, 'cdp.mjs'), 'utf8');
  const block = /const TEMPLATE_SHA256 = Object\.freeze\(\{([^}]*)\}\);/.exec(text);
  assert.ok(block, 'cdp.mjs has no TEMPLATE_SHA256 block');
  const pins = {};
  for (const m of block[1].matchAll(/^\s*([A-Za-z_]\w*)\s*:\s*'([^']*)',?\s*$/gm)) pins[m[1]] = m[2];
  return pins;
}

const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex');

test('cdp.mjs pins exactly the five templates templates.mjs exports', () => {
  assert.deepEqual(Object.keys(pinnedDigests()).sort(), NAMES.slice().sort());
  assert.deepEqual(Object.keys(TEMPLATES).sort(), NAMES.slice().sort());
});

test('every pin is 64 lowercase hex characters', () => {
  for (const [name, digest] of Object.entries(pinnedDigests())) {
    assert.match(digest, /^[0-9a-f]{64}$/, `${name} pin is not a SHA-256 hex digest`);
  }
});

test('every pin equals the SHA-256 of its template text', () => {
  const pins = pinnedDigests();
  for (const name of NAMES) {
    assert.equal(typeof TEMPLATES[name], 'string', `${name} template is not a string`);
    assert.equal(pins[name], sha256(TEMPLATES[name]), `${name} pin does not match its template`);
  }
});
