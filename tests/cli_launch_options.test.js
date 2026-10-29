/**
 * Maps `tv launch` flags to launch() options (review finding TVMCP-R6).
 * The router parses with strict: false, so `--kill=false` arrives as the
 * string "false". Only an explicit yes may turn kill_existing on.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { launchOptions } from '../src/cli/commands/health.js';

describe('tv launch flag mapping (TVMCP-R6)', () => {
  it('kills nothing by default', () => {
    assert.equal(launchOptions({}).kill_existing, false);
  });

  it('--kill turns kill_existing on', () => {
    assert.equal(launchOptions({ kill: true }).kill_existing, true);
  });

  it('--kill=true and --kill=1 turn kill_existing on', () => {
    assert.equal(launchOptions({ kill: 'true' }).kill_existing, true);
    assert.equal(launchOptions({ kill: '1' }).kill_existing, true);
  });

  for (const v of ['false', '0', 'no', 'off', '']) {
    it(`--kill=${v} kills nothing`, () => {
      assert.equal(launchOptions({ kill: v }).kill_existing, false);
    });
  }

  it('--no-kill wins over --kill', () => {
    assert.equal(launchOptions({ kill: true, 'no-kill': true }).kill_existing, false);
  });

  it('passes the port as a number', () => {
    assert.equal(launchOptions({ port: '9333' }).port, 9333);
    assert.equal(launchOptions({}).port, undefined);
  });
});
