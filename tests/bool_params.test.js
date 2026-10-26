/**
 * Tests for the shared strict boolean tool parameter (src/tools/_params.js).
 * Pure schema checks: no CDP, no network.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';
import { bool } from '../src/tools/_params.js';

describe('bool schema', () => {
  it('passes real booleans through', () => {
    assert.equal(bool.parse(true), true);
    assert.equal(bool.parse(false), false);
  });

  it('parses the accepted strings case-insensitively and trimmed', () => {
    assert.equal(bool.parse('true'), true);
    assert.equal(bool.parse('TRUE'), true);
    assert.equal(bool.parse('1'), true);
    assert.equal(bool.parse(' 1 '), true);
    assert.equal(bool.parse('false'), false);
    assert.equal(bool.parse('FALSE'), false);
    assert.equal(bool.parse(' false\t'), false);
    assert.equal(bool.parse('0'), false);
  });

  it('parses the numbers 1 and 0', () => {
    assert.equal(bool.parse(1), true);
    assert.equal(bool.parse(0), false);
  });

  it('never turns the string "false" into true', () => {
    assert.equal(bool.parse('false'), false);
    assert.equal(bool.parse('FALSE'), false);
  });

  it('rejects other strings instead of coercing them', () => {
    for (const bad of ['yes', 'no', 'on', 'off', '', '   ', '2', 'fasle', 'truee']) {
      assert.throws(() => bool.parse(bad), z.ZodError, `expected rejection of ${JSON.stringify(bad)}`);
    }
  });

  it('rejects other numbers, null and objects', () => {
    for (const bad of [2, -1, 0.5, NaN, null, {}, []]) {
      assert.throws(() => bool.parse(bad), z.ZodError, `expected rejection of ${String(bad)}`);
    }
  });

  it('rejects undefined when the parameter is required', () => {
    assert.throws(() => bool.parse(undefined), z.ZodError);
  });

  it('still allows undefined when wrapped in .optional()', () => {
    const schema = z.object({ flag: bool.optional().describe('test flag') });
    assert.deepEqual(schema.parse({}), {});
    assert.equal(bool.optional().parse(undefined), undefined);
  });

  it('rejects bad strings inside .optional() too', () => {
    const schema = z.object({ flag: bool.optional() });
    assert.throws(() => schema.parse({ flag: 'yes' }), z.ZodError);
    assert.throws(() => schema.parse({ flag: 'falsex' }), z.ZodError);
    assert.deepEqual(schema.parse({ flag: 'false' }), { flag: false });
  });
});
