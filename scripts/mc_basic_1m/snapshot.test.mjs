import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as store from './store.mjs';
import { main } from './snapshot.mjs';
import { prepare, sha256Rows } from './sim.mjs';
import { fakeChart } from './fake_chart.mjs';

// 2026-10-01 14:00 UTC (10:00 ET). October is not a roll month. Aligned to 900 s.
const T0 = Date.UTC(2026, 9, 1, 14, 0) / 1000;
const SNAP_S = T0 + 108030; // the last closed 1m row closes at T0 + 108000
const PLOTS = Array.from({ length: 16 }, (_, k) => ({ id: `plot_${k + 1}`, type: 'line' }));

function freshDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc_basic_1m_test-'));
  store.__testSetStateDir(dir);
  return dir;
}

function barRow(t, base) {
  return [t, base, base + 0.25, base - 0.25, base, 100];
}

function bRow(t) {
  const r = [t];
  for (let p = 1; p <= 16; p++) r.push(0);
  r[2] = 50; // Blue Wave
  r[4] = 40; // Mny Flow
  r[15] = 50; // RSI
  r[16] = 50; // Sto RSI
  return r;
}

function srRow(t) {
  return [t, 0, 0, 0, 5010, 4990];
}

function series(step, n) {
  return Array.from({ length: n }, (_, i) => T0 + step * i);
}

/** 1801 1m bars (the last is forming at snapshot time) and 121 15m bars (the last is forming). */
function fixtures() {
  const bars1 = series(60, 1801).map((t, i) => barRow(t, 5000 + 0.25 * (i % 8)));
  const b1 = bars1.map((r) => bRow(r[0]));
  const sr1 = bars1.map((r) => srRow(r[0]));
  const bars15 = series(900, 121).map((t, i) => barRow(t, 5000 + 0.25 * (i % 8)));
  const b15 = bars15.map((r) => bRow(r[0]));
  return {
    history1: [bars1, b1, sr1, PLOTS, null, { v: '5', f: true, t: 'resolution' }],
    history2: [bars15, b15, null, PLOTS, null, null],
    shapes: [{ id: 'sh1', name: 'text', pts: [], linecolor: '#123456', text: 'note', stopLevel: null, profitLevel: null }],
  };
}

/** Shared fake chart. replies.history1, history2 and shapes answer the three reads. */
function mockDeps(replies, nowMs = SNAP_S * 1000) {
  const deps = fakeChart({
    now: nowMs,
    replies: {
      'read_history tab1': replies.history1,
      'read_history tab2': replies.history2,
      'read_shapes tab1': replies.shapes,
    },
  });
  return { deps, calls: deps.calls, outLines: deps.stdout, errLines: deps.stderr };
}

const fileSha = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

test('an error-code read returns 1 and writes nothing', async () => {
  for (const bad of [
    { history1: 'E_PATH' },
    { history2: 'E_NOSTUDY' },
    { shapes: 'E_RES' },
  ]) {
    const dir = freshDir();
    const f = fixtures();
    const { deps, errLines } = mockDeps({ ...f, ...bad });
    const code = await main([], deps);
    assert.equal(code, 1);
    assert.equal(errLines.length, 1);
    assert.match(errLines[0], /E_/);
    assert.equal(fs.existsSync(store.snapshotPath('current')), false);
    assert.equal(fs.existsSync(store.snapshotPath('forward')), false);
    assert.equal(fs.existsSync(path.join(dir, 'trade_log.json')), false);
  }
});

test('a valid read writes snapshot.json whose rows hash matches sha256', async () => {
  freshDir();
  const f = fixtures();
  const { deps, calls, outLines } = mockDeps(f);
  const code = await main([], deps);
  assert.equal(code, 0, outLines.join('\n'));
  assert.deepEqual(calls.map((c) => [c.name, c.tab]), [
    ['read_history', 'tab1'],
    ['read_history', 'tab2'],
    ['read_shapes', 'tab1'],
  ]);
  for (const c of calls) assert.deepEqual(c.args, {});

  const file = store.snapshotPath('current');
  assert.ok(fs.existsSync(file));
  const snap = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(snap.format, 'mc_basic_1m.snapshot.v1');
  assert.equal(snap.snapshot_time, SNAP_S);
  assert.equal(snap.symbol, 'CME_MINI:MES1!');
  assert.equal(snap.count_1m, 1800, 'forming 1m bar dropped');
  assert.equal(snap.last_1m, T0 + 107940);
  assert.equal(snap.count_15m, 120, 'forming 15m bar dropped');
  assert.equal(snap.last_15m, T0 + 107100);
  assert.equal(snap.rows.m1.b.length, 1800);
  assert.equal(snap.rows.m1.sr.length, 1800);
  assert.equal(snap.rows.m15.b.length, 120);
  assert.equal(snap.rows.m15.sr, undefined);
  assert.equal(snap.sr_period_s, 300, 'MarketCipher_SR Resolution "5" is 300 s');
  assert.equal(prepare(snap).info.srPeriodS, 300);
  assert.equal(snap.sha256, sha256Rows(snap.rows));
  assert.equal(snap.sha256, sha256Rows(JSON.parse(fs.readFileSync(file, 'utf8')).rows));
  assert.equal(fileSha(file), store.snapshotFileSha256('current'));
  assert.doesNotThrow(() => prepare(snap));
  assert.ok(outLines.some((l) => l.startsWith('snapshot current written')));
});

test('--forward writes snapshot_forward.json and leaves snapshot.json alone', async () => {
  freshDir();
  const { deps } = mockDeps(fixtures());
  const code = await main(['--forward'], deps);
  assert.equal(code, 0);
  assert.equal(fs.existsSync(store.snapshotPath('forward')), true);
  assert.equal(fs.existsSync(store.snapshotPath('current')), false);
  const snap = JSON.parse(fs.readFileSync(store.snapshotPath('forward'), 'utf8'));
  assert.equal(snap.sha256, sha256Rows(snap.rows));
});

test('usage: an unknown argument returns 2 and runs no reads', async () => {
  freshDir();
  const { deps, calls, errLines } = mockDeps(fixtures());
  assert.equal(await main(['--nope'], deps), 2);
  assert.equal(calls.length, 0);
  assert.equal(errLines.length, 1);
});

test('last shown is cleared in the log when the log exists', async () => {
  const dir = freshDir();
  store.takeLogLock();
  try {
    store.writeLog({ ...store.emptyLog(), last_shown: { snapshot_sha256: 'deadbeef', runs: { 'HTF-a': 'abc' } } });
  } finally {
    store.releaseLogLock();
  }
  const { deps } = mockDeps(fixtures());
  assert.equal(await main([], deps), 0);
  assert.equal(store.readLog().log.last_shown, null);
  assert.equal(store.logLockExists(), false);
  assert.equal(fs.existsSync(path.join(dir, 'trade.lock')), false);
});

test('a held trade-log lock refuses and writes no snapshot', async () => {
  freshDir();
  store.takeLogLock();
  try {
    store.writeLog(store.emptyLog());
  } finally {
    store.releaseLogLock();
  }
  store.takeLogLock();
  try {
    const { deps, errLines } = mockDeps(fixtures());
    assert.equal(await main([], deps), 1);
    assert.match(errLines[0], /E_LOCK_HELD/);
    assert.equal(fs.existsSync(store.snapshotPath('current')), false);
  } finally {
    store.releaseLogLock();
  }
});

test('a corrupt log refuses and writes no snapshot', async () => {
  const dir = freshDir();
  fs.writeFileSync(path.join(dir, 'trade_log.json'), 'not json');
  const { deps, errLines } = mockDeps(fixtures());
  assert.equal(await main([], deps), 1);
  assert.match(errLines[0], /E_LOG_CORRUPT/);
  assert.equal(fs.existsSync(store.snapshotPath('current')), false);
});

test('sim.prepare refusal (high below low) returns 1 and writes nothing', async () => {
  freshDir();
  const f = fixtures();
  f.history1[0][10] = [f.history1[0][10][0], 5000, 4999, 5001, 5000, 100];
  const { deps, errLines } = mockDeps(f);
  assert.equal(await main([], deps), 1);
  assert.match(errLines[0], /E_SNAPSHOT_ABORT/);
  assert.equal(fs.existsSync(store.snapshotPath('current')), false);
});

test('a MarketCipher_SR Resolution that is not a whole number of minutes refuses and writes nothing', async () => {
  for (const bad of [null, {}, { v: '1D' }, { v: '5d' }, { v: '1d' }, { v: '05' }, { v: '0' }, { v: '5.5' }, { v: 5 }, { v: '' }]) {
    freshDir();
    const f = fixtures();
    f.history1[5] = bad;
    const { deps, errLines } = mockDeps(f);
    assert.equal(await main([], deps), 1, JSON.stringify(bad));
    assert.match(errLines[0], /E_READ_SHAPE: .*Resolution/);
    assert.equal(fs.existsSync(store.snapshotPath('current')), false);
  }
});

test('a Resolution that sim.prepare rejects (7 minutes does not divide an hour) refuses and writes nothing', async () => {
  freshDir();
  const f = fixtures();
  f.history1[5] = { v: '7' };
  const { deps, errLines } = mockDeps(f);
  assert.equal(await main([], deps), 1);
  assert.match(errLines[0], /E_SNAPSHOT_ABORT: .*sr_period_s/);
  assert.equal(fs.existsSync(store.snapshotPath('current')), false);
});

test('a read_history reply with the old five-element shape refuses', async () => {
  freshDir();
  const f = fixtures();
  f.history1 = f.history1.slice(0, 5);
  const { deps, errLines } = mockDeps(f);
  assert.equal(await main([], deps), 1);
  assert.match(errLines[0], /E_READ_SHAPE/);
});

test('multi-digit Resolution values become seconds', async () => {
  for (const [v, want] of [['1', 60], ['10', 600], ['15', 900], ['30', 1800], ['60', 3600]]) {
    freshDir();
    const f = fixtures();
    f.history1[5] = { v, f: true, t: 'resolution' };
    const { deps, errLines } = mockDeps(f);
    assert.equal(await main([], deps), 0, errLines.join('\n'));
    const snap = JSON.parse(fs.readFileSync(store.snapshotPath('current'), 'utf8'));
    assert.equal(snap.sr_period_s, want, v);
  }
});
