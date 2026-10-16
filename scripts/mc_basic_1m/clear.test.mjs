import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as store from './store.mjs';
import { main } from './clear.mjs';

const T0 = 1700000000;
const DEADLINE = 1700000100000;
const P1 = { time: T0, price: 100 };
const P2 = { time: T0 + 600, price: 102 };
const TEXT_TIME = T0 + 60;
const TEXT_TEXT = 'HTF-a BACKTEST 2026-01-01';
const KEY = 'HTF-a:1:0:1700000000:1';
const KEY2 = 'HTF-a:1:1:1700000000:1';
const KEY3 = 'HTF-a:1:2:1700000000:1';
const KEY_B = 'HTF-b:1:0:1700000000:1';

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
const POS_MOVED = { ...POS, pts: [{ time: T0 + 1, price: 100 }, P2] };
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

test('refuses while a pending record of the run is inside its 60 s window', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 59999, [[USR], [USR]]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 1);
  assert.equal(d.calls.length, 0);
  assert.equal(recordIn().state, 'pending');
  assert.equal(store.logLockExists(), false);
});

test('refuses a run with no records in the trade log', async () => {
  freshState();
  const digest = seed([makeRecord()]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main(['HTF-z', '--expect-guard', digest], d), 1);
  assert.equal(d.calls.length, 0);
  assert.equal(store.logLockExists(), false);
});

test('refuses while the stored position of the run is still on tab 1 with its entry point', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const before = JSON.stringify(store.readLog().log);
  const d = makeDeps(DEADLINE + 60000, [[POS, TXT], [POS, TXT]]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 1);
  assert.ok(d.stderr.some((l) => l.startsWith('still on tab 1: POS1')));
  assert.equal(JSON.stringify(store.readLog().log), before);
  assert.equal(d.calls.every((c) => c.name === 'read_shapes'), true);
  assert.equal(store.logLockExists(), false);
});

test('refuses while the stored text label of the run is still on tab 1', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const d = makeDeps(DEADLINE + 60000, [[TXT], [TXT]]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 1);
  assert.ok(d.stderr.some((l) => l.startsWith('still on tab 1: TXT1')));
  assert.equal(recordIn().state, 'drawn');
  assert.equal(store.logLockExists(), false);
});

test('a stored ID with other attributes is reported, not blocking, and the record is cleared', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1' })]);
  const d = makeDeps(DEADLINE + 60000, [[POS_MOVED], [POS_MOVED]]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 0);
  assert.ok(d.stdout.some((l) => l.startsWith('reported, not blocking: POS1')));
  assert.equal(recordIn().state, 'cleared');
});

test('marks the run pending and drawn records cleared and leaves other records alone', async () => {
  freshState();
  const digest = seed([
    makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' }),
    makeRecord({ key: KEY2, index: 1, state: 'pending' }),
    makeRecord({ key: KEY3, index: 2, state: 'not drawn' }),
    makeRecord({ key: KEY_B, run: 'HTF-b', state: 'drawn', position_id: 'POS9', text_id: 'TXT9' }),
  ]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 0);
  assert.equal(recordIn(KEY).state, 'cleared');
  assert.equal(recordIn(KEY).written_at, DEADLINE + 60000);
  assert.equal(recordIn(KEY2).state, 'cleared');
  assert.equal(recordIn(KEY3).state, 'not drawn');
  assert.equal(recordIn(KEY_B).state, 'drawn');
  assert.deepEqual(d.sleeps, [2000]);
  assert.equal(d.calls.length, 2);
  assert.ok(d.calls.every((c) => c.name === 'read_shapes' && c.tab === 'tab1'));
  assert.ok(d.stdout.some((l) => l === 'cleared 2 record(s) of run HTF-a'));
  assert.equal(store.logLockExists(), false);
});

test('an empty tab 1 is refused unless --chart-empty-ok is given', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const refused = makeDeps(DEADLINE + 60000, [[], []]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], refused), 1);
  assert.equal(recordIn().state, 'drawn');
  assert.equal(store.logLockExists(), false);

  const allowed = makeDeps(DEADLINE + 60000, [[], []]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest, '--chart-empty-ok'], allowed), 0);
  assert.equal(recordIn().state, 'cleared');
});

test('two tab 1 reads that differ refuse and change nothing', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const before = JSON.stringify(store.readLog().log);
  const d = makeDeps(DEADLINE + 60000, [[USR], []]);
  assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 1);
  assert.equal(JSON.stringify(store.readLog().log), before);
  assert.equal(store.logLockExists(), false);
});

test('a guard digest that does not match refuses before any read', async () => {
  freshState();
  seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main(['HTF-a', '--expect-guard', 'missing+0'], d), 1);
  assert.equal(d.calls.length, 0);
  assert.equal(recordIn().state, 'drawn');
  assert.equal(store.logLockExists(), false);
});

test('a trade lock held by someone else refuses before any read', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  store.takeLogLock();
  try {
    const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
    assert.equal(await main(['HTF-a', '--expect-guard', digest], d), 1);
    assert.equal(d.calls.length, 0);
  } finally {
    store.releaseLogLock();
  }
  assert.equal(store.logLockExists(), false);
});

test('bad usage returns 2 without touching the state', async () => {
  freshState();
  const digest = seed([makeRecord({ state: 'drawn', position_id: 'POS1', text_id: 'TXT1' })]);
  const d = makeDeps(DEADLINE + 60000, [[USR], [USR]]);
  assert.equal(await main([], d), 2);
  assert.equal(await main(['HTF-a'], d), 2);
  assert.equal(await main(['HTF-a', 'HTF-b', '--expect-guard', digest], d), 2);
  assert.equal(await main(['HTF-a', '--expect-guard', digest, '--bogus'], d), 2);
  assert.equal(d.calls.length, 0);
  assert.equal(recordIn().state, 'drawn');
});
