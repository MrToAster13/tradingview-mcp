import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.mjs';
import { main } from './resolve.mjs';

const T0 = 1700000000;
const DEADLINE = 1700000100000;
const P1 = { time: T0, price: 100 };
const P2 = { time: T0 + 600, price: 102 };
const TEXT_TIME = T0 + 60;
const TEXT_TEXT = 'HTF-a BACKTEST 2026-01-01';
const KEY = 'HTF-a:1:0:1700000000:1';

const GUARD = {
  broker_check: 'passed',
  baseline_count: 33,
  probe_key: null,
  count_refused: false,
  reset_count: 0,
  colour_ok: [],
  consumed_flags: [],
  draw_mismatches: [],
  lost_at: null,
  reset_stamps: [],
};

const POS = { id: 'POS1', name: 'long_position', pts: [P1, P2], linecolor: '#9c27b0', text: null, stopLevel: 99, profitLevel: 102 };
const POS_INEXACT = { ...POS, id: 'POSX', stopLevel: 98 };
const TXT = { id: 'TXT1', name: 'text', pts: [{ time: TEXT_TIME, price: 101 }], linecolor: '#000000', text: TEXT_TEXT, stopLevel: null, profitLevel: null };
const USR = { id: 'USR1', name: 'trend_line', pts: [{ time: T0 - 3600, price: 95 }, { time: T0, price: 96 }], linecolor: '#ff0000', text: null, stopLevel: null, profitLevel: null };

function freshState() {
  store.__testSetStateDir(fs.mkdtempSync(path.join(os.tmpdir(), 'mc_basic_1m_test-')));
}

function makeRecord(over = {}) {
  return {
    key: KEY, run: 'HTF-a', cycle: 1, index: 0, attempt: 1,
    snapshot_sha256: 'a'.repeat(64), side: 'long', entry_time: T0, entry_price: 100,
    p1: P1, p2: P2, stop: 99, target: 102, text: TEXT_TEXT, text_time: TEXT_TIME, text_price: 101,
    stop_level: 99, profit_level: 102, deadline: DEADLINE, pre_draw_ids: [],
    position_id: null, text_id: null, state: 'pending', mismatch: false, seen_position: false,
    written_at: 0, ...over,
  };
}

/** Writes a trade log holding these records and a guard, returns the guard digest on disk. */
function seed(records) {
  store.takeLogLock();
  try {
    store.createEmptyLog();
    const { log } = store.readLog();
    log.records = Object.fromEntries(records.map((r) => [r.key, r]));
    store.writeLog(log);
    store.writeGuard(GUARD);
  } finally {
    store.releaseLogLock();
  }
  return store.guardDigest();
}

/** Mock deps: reads[i] is returned by the i-th read_shapes call; an Error entry is thrown. */
function makeDeps(now, reads) {
  const d = { calls: [], sleeps: [], stdout: [], stderr: [], clock: { t: now } };
  let i = 0;
  d.now = () => d.clock.t;
  d.sleep = async (ms) => { d.sleeps.push(ms); };
  d.out = (line) => { d.stdout.push(line); };
  d.err = (line) => { d.stderr.push(line); };
  d.run = async (name, args, tab) => {
    d.calls.push({ name, args, tab });
    const r = reads[Math.min(i, reads.length - 1)];
    i++;
    if (r instanceof Error) throw r;
    return r;
  };
  return d;
}

function recordIn(key = KEY) {
  return store.readLog().log.records[key];
}

test('refuses before the deadline plus 60 s and does not touch the chart', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 59999, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.equal(d.calls.length, 0);
  assert.equal(store.logLockExists(), false);
  assert.equal(recordIn().state, 'pending');
});

test('drawn: two reads 5 s apart settle the record with its IDs and release the lock', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 0);
  assert.equal(recordIn().state, 'drawn');
  assert.equal(recordIn().position_id, 'POS1');
  assert.equal(recordIn().text_id, 'TXT1');
  assert.equal(recordIn().written_at, DEADLINE + 60000);
  assert.deepEqual(d.sleeps, [5000]);
  assert.equal(d.calls.length, 2);
  assert.ok(d.calls.every((c) => c.name === 'read_shapes' && c.tab === 'tab1'));
  assert.ok(d.stdout.some((l) => l.includes('drawn:') && l.includes('POS1') && l.includes('TXT1')));
  assert.equal(store.logLockExists(), false);
});

test('not drawn: no candidate in either read settles the record as not drawn', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 0);
  assert.equal(recordIn().state, 'not drawn');
  assert.equal(recordIn().seen_position, false);
  assert.equal(store.logLockExists(), false);
});

test('not drawn keeps seen_position when it was already set', async () => {
  freshState();
  const digest = seed([makeRecord({ seen_position: true })]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 0);
  assert.equal(recordIn().state, 'not drawn');
  assert.equal(recordIn().seen_position, true);
});

test('undecided: an inexact position is printed, stays pending, and sets seen_position', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[POS_INEXACT, TXT], [POS_INEXACT, TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.equal(recordIn().state, 'pending');
  assert.equal(recordIn().seen_position, true);
  assert.ok(d.stdout.some((l) => l.startsWith('candidate POSX')));
  assert.equal(store.logLockExists(), false);
});

test('undecided with no position candidate writes nothing', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const before = JSON.stringify(store.readLog().log);
  const d = makeDeps(DEADLINE + 60000, [[TXT], [TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.equal(JSON.stringify(store.readLog().log), before);
  assert.equal(store.logLockExists(), false);
});

test('two reads that differ refuse and write nothing', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const before = JSON.stringify(store.readLog().log);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.equal(JSON.stringify(store.readLog().log), before);
  assert.equal(store.logLockExists(), false);
});

test('an empty chart is refused unless --chart-empty-ok is given', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const refused = makeDeps(DEADLINE + 60000, [[], []]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], refused), 1);
  assert.equal(recordIn().state, 'pending');

  const allowed = makeDeps(DEADLINE + 60000, [[], []]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest, '--chart-empty-ok'], allowed), 0);
  assert.equal(recordIn().state, 'not drawn');
});

test('a failed read refuses and releases the lock', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const lost = Object.assign(new Error('target lost'), { code: 'E_CDP_LOST' });
  const d = makeDeps(DEADLINE + 60000, [lost]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.ok(d.stderr.some((l) => l.startsWith('E_CDP_LOST')));
  assert.equal(store.logLockExists(), false);
  assert.equal(recordIn().state, 'pending');
});

test('a trade lock held by someone else refuses before any read', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  store.takeLogLock();
  try {
    const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
    assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
    assert.equal(d.calls.length, 0);
  } finally {
    store.releaseLogLock();
  }
  assert.equal(store.logLockExists(), false);
});

test('a guard digest that does not match refuses before any read and prints the digest on disk', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', 'missing+0'], d), 1);
  assert.equal(d.calls.length, 0);
  assert.ok(d.stdout.some((l) => l === `guard_digest = ${digest}`));
  assert.equal(recordIn().state, 'pending');
  assert.equal(store.logLockExists(), false);
});

test('--colour-ok IDs are stored in the log and guard and ignored by the match', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const ghost = { ...POS_INEXACT, id: 'ZZ9' };
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT, ghost], [POS, TXT, ghost]]);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest, '--colour-ok', 'ZZ9'], d), 0);
  assert.equal(recordIn().state, 'drawn');
  assert.ok(store.readLog().log.colour_ok.includes('ZZ9'));
  assert.ok(store.readGuard().guard.colour_ok.includes('ZZ9'));
});

test('a record that belongs to another run is refused', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-b', KEY, '--expect-guard', digest], d), 1);
  assert.equal(d.calls.length, 0);
  assert.equal(recordIn().state, 'pending');
});

test('an unknown key and a record that is not pending are refused', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn' })]);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a', 'HTF-a:9:9:9:1', '--expect-guard', digest], d), 1);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest], d), 1);
  assert.equal(d.calls.length, 0);
});

test('bad usage returns 2 without touching the state', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a'], d), 2);
  assert.equal(await main(['HTF-a', KEY], d), 2);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', 'not-a-digest'], d), 2);
  assert.equal(await main(['HTF-a', KEY, '--expect-guard', digest, '--bogus'], d), 2);
  assert.equal(d.calls.length, 0);
});
