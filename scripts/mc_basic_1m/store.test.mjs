import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import * as store from './store.mjs';

let dir;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc_basic_1m_test-'));
  store.__testSetStateDir(dir);
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const has = (name) => fs.existsSync(path.join(dir, name));
const read = (name) => fs.readFileSync(path.join(dir, name));
const tmpFiles = () => fs.readdirSync(dir).filter((n) => n.includes('.tmp-'));
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const sampleLog = () => ({ ...store.emptyLog(), reset_count: 3 });

describe('__testSetStateDir', () => {
  it('refuses a folder whose name lacks the test prefix', () => {
    assert.throws(() => store.__testSetStateDir(path.join(os.tmpdir(), 'not_the_prefix')), { code: 'E_TEST_DIR' });
    assert.throws(() => store.__testSetStateDir(os.tmpdir()), { code: 'E_TEST_DIR' });
    assert.throws(() => store.__testSetStateDir(undefined), { code: 'E_TEST_DIR' });
  });

  it('accepts a folder with the prefix, after which writes land there', () => {
    store.takeLogLock();
    assert.equal(has('trade.lock'), true);
  });
});

describe('trade lock', () => {
  it('takes the lock with this pid as content', () => {
    assert.equal(store.logLockExists(), false);
    store.takeLogLock();
    assert.equal(store.logLockExists(), true);
    assert.equal(read('trade.lock').toString('utf8'), String(process.pid));
  });

  it('refuses a second take with E_LOCK_HELD', () => {
    store.takeLogLock();
    assert.throws(() => store.takeLogLock(), { code: 'E_LOCK_HELD' });
  });

  it('releases only its own lock', () => {
    store.takeLogLock();
    assert.equal(store.releaseLogLock(), true);
    assert.equal(store.logLockExists(), false);
    assert.equal(store.releaseLogLock(), false);
  });

  it('does not delete a lock that holds another pid', () => {
    fs.writeFileSync(path.join(dir, 'trade.lock'), '999999');
    assert.equal(store.releaseLogLock(), false);
    assert.equal(store.logLockExists(), true);
  });
});

describe('trade log writes', () => {
  it('refuses writeLog with E_NO_LOCK and writes nothing', () => {
    assert.throws(() => store.writeLog(sampleLog()), { code: 'E_NO_LOCK' });
    assert.equal(has('trade_log.json'), false);
  });

  it('refuses writeLog when the lock file holds another pid', () => {
    fs.writeFileSync(path.join(dir, 'trade.lock'), '999999');
    assert.throws(() => store.writeLog(sampleLog()), { code: 'E_NO_LOCK' });
    assert.equal(has('trade_log.json'), false);
  });

  it('writes the log atomically and leaves no tmp file', () => {
    store.takeLogLock();
    store.writeLog(sampleLog());
    assert.equal(has('trade_log.json'), true);
    assert.deepEqual(tmpFiles(), []);
    assert.equal(store.readLog().state, 'ok');
    assert.equal(store.readLog().log.reset_count, 3);
  });

  it('copies the previous log to log.bak on the next write', () => {
    store.takeLogLock();
    store.writeLog(sampleLog());
    const before = read('trade_log.json');
    assert.equal(store.logBakExists(), false);
    store.writeLog({ ...sampleLog(), reset_count: 4 });
    assert.equal(store.logBakExists(), true);
    assert.deepEqual(read('trade_log.json.bak'), before);
    assert.equal(store.readLog().log.reset_count, 4);
    assert.deepEqual(tmpFiles(), []);
  });

  it('refuses to replace log.bak when the current log is corrupt', () => {
    store.takeLogLock();
    store.writeLog(sampleLog());
    store.writeLog({ ...sampleLog(), reset_count: 4 });
    const bak = read('trade_log.json.bak');
    fs.writeFileSync(path.join(dir, 'trade_log.json'), '{ broken');
    assert.throws(() => store.writeLog(sampleLog()), { code: 'E_LOG_CORRUPT' });
    assert.deepEqual(read('trade_log.json.bak'), bak);
  });

  it('removes the temp file and keeps the target when the rename keeps failing', () => {
    // A directory at the target name makes rename fail on every try; the retries take about 300 ms.
    fs.mkdirSync(path.join(dir, 'snapshot.json'));
    assert.throws(() => store.writeSnapshot({ a: 1 }, 'current'));
    assert.deepEqual(tmpFiles(), []);
    assert.equal(fs.statSync(path.join(dir, 'snapshot.json')).isDirectory(), true);
  });
});

describe('readLog', () => {
  it('reports missing, then ok, then corrupt', () => {
    assert.deepEqual(store.readLog(), { state: 'missing', log: null });
    store.takeLogLock();
    store.writeLog(sampleLog());
    assert.equal(store.readLog().state, 'ok');
    fs.writeFileSync(path.join(dir, 'trade_log.json'), '{"version":');
    assert.deepEqual(store.readLog(), { state: 'corrupt', log: null });
    fs.writeFileSync(path.join(dir, 'trade_log.json'), '[1,2]');
    assert.equal(store.readLog().state, 'corrupt');
  });
});

describe('createEmptyLog', () => {
  it('refuses without the lock', () => {
    assert.throws(() => store.createEmptyLog(), { code: 'E_NO_LOCK' });
    assert.equal(has('trade_log.json'), false);
  });

  it('creates the empty log under the lock', () => {
    store.takeLogLock();
    store.createEmptyLog();
    assert.deepEqual(store.readLog(), { state: 'ok', log: store.emptyLog() });
  });

  it('refuses when the log exists', () => {
    store.takeLogLock();
    store.createEmptyLog();
    assert.throws(() => store.createEmptyLog(), { code: 'E_LOG_EXISTS' });
  });

  it('refuses when log.bak exists without a log', () => {
    store.takeLogLock();
    fs.writeFileSync(path.join(dir, 'trade_log.json.bak'), '{}');
    assert.throws(() => store.createEmptyLog(), { code: 'E_BAK_EXISTS' });
    assert.equal(has('trade_log.json'), false);
  });
});

describe('emptyLog', () => {
  it('returns the design shape', () => {
    assert.deepEqual(store.emptyLog(), {
      version: 1,
      reset_count: 0,
      probes: [],
      records: {},
      last_shown: null,
      colour_ok: [],
      consumed_flags: [],
    });
  });
});

describe('guard.json', () => {
  it('readGuard reports missing, ok and corrupt', () => {
    assert.deepEqual(store.readGuard(), { state: 'missing', guard: null, bytes: null });
    store.takeLogLock();
    store.writeGuard({ broker_check: 'none', reset_count: 0 });
    const ok = store.readGuard();
    assert.equal(ok.state, 'ok');
    assert.equal(ok.guard.broker_check, 'none');
    assert.deepEqual(ok.bytes, read('guard.json'));
    fs.writeFileSync(path.join(dir, 'guard.json'), 'not json');
    const bad = store.readGuard();
    assert.equal(bad.state, 'corrupt');
    assert.equal(bad.guard, null);
    assert.equal(bad.bytes.toString('utf8'), 'not json');
  });

  it('writeGuard refuses without the lock and writes nothing', () => {
    assert.throws(() => store.writeGuard({ broker_check: 'none' }), { code: 'E_NO_LOCK' });
    assert.equal(has('guard.json'), false);
  });

  it('writeGuard writes atomically', () => {
    store.takeLogLock();
    store.writeGuard({ broker_check: 'none' });
    assert.deepEqual(tmpFiles(), []);
    assert.equal(has('guard.json.bak'), false);
  });

  it('copyGuardCorrupt copies with a new name each time and keeps guard.json', () => {
    store.takeLogLock();
    fs.writeFileSync(path.join(dir, 'guard.json'), '{ bad');
    const first = store.copyGuardCorrupt();
    assert.match(first, /^guard\.json\.corrupt-\d+\.\d+$/);
    assert.equal(fs.readFileSync(path.join(dir, first), 'utf8'), '{ bad');
    const second = store.copyGuardCorrupt();
    assert.notEqual(second, first);
    assert.equal(has('guard.json'), true);
    assert.equal(fs.readFileSync(path.join(dir, first), 'utf8'), '{ bad');
  });

  it('copyGuardCorrupt refuses without the lock, on a missing file, and on a valid file', () => {
    fs.writeFileSync(path.join(dir, 'guard.json'), '{ bad');
    assert.throws(() => store.copyGuardCorrupt(), { code: 'E_NO_LOCK' });
    store.takeLogLock();
    store.writeGuard({ broker_check: 'none' });
    assert.throws(() => store.copyGuardCorrupt(), { code: 'E_GUARD_NOT_CORRUPT' });
    fs.rmSync(path.join(dir, 'guard.json'));
    assert.throws(() => store.copyGuardCorrupt(), { code: 'E_NO_GUARD' });
  });
});

describe('flags and guardDigest', () => {
  it('creates flag files with the design name and lists them sorted', () => {
    assert.deepEqual(store.listFlagFiles(), []);
    const a = store.createBrokerFailedFlag();
    const b = store.createBrokerFailedFlag();
    assert.match(a, /^broker_failed\.\d+\.\d+\.flag$/);
    assert.notEqual(a, b);
    assert.equal(has(a), true);
    assert.deepEqual(store.listFlagFiles(), [a, b].sort());
  });

  it('never deletes a flag file', () => {
    const a = store.createBrokerFailedFlag();
    store.takeLogLock();
    store.writeLog(sampleLog());
    store.writeLog(sampleLog());
    store.releaseLogLock();
    assert.equal(has(a), true);
    assert.deepEqual(store.listFlagFiles(), [a]);
  });

  it('guardDigest is missing+0 on a fresh folder, and tracks guard.json and flags', () => {
    assert.equal(store.guardDigest(), 'missing+0');
    store.takeLogLock();
    store.writeGuard({ broker_check: 'none' });
    const digest = store.guardDigest();
    assert.equal(digest, `${sha(read('guard.json')).slice(0, 8)}+0`);
    assert.match(digest, /^[0-9a-f]{8}\+0$/);
    store.createBrokerFailedFlag();
    assert.equal(store.guardDigest(), `${sha(read('guard.json')).slice(0, 8)}+1`);
  });

  it('ignores files that are not broker_failed flags', () => {
    fs.writeFileSync(path.join(dir, 'broker_failed.txt'), '');
    fs.writeFileSync(path.join(dir, 'guard.json.corrupt-1.2'), '');
    assert.deepEqual(store.listFlagFiles(), []);
  });
});

describe('recorder lock and recorder.json', () => {
  it('takes, holds and releases the recorder lock', () => {
    assert.equal(store.recorderLockPid(), null);
    store.takeRecorderLock();
    assert.equal(store.recorderLockPid(), process.pid);
    assert.throws(() => store.takeRecorderLock(), { code: 'E_LOCK_HELD' });
    assert.equal(store.releaseRecorderLock(), true);
    assert.equal(store.recorderLockPid(), null);
    assert.equal(store.releaseRecorderLock(), false);
  });

  it('does not treat the trade lock as the recorder lock', () => {
    store.takeLogLock();
    assert.throws(() => store.writeRecorder({ rows: {} }), { code: 'E_NO_LOCK' });
  });

  it('writeRecorder refuses without the lock and writes nothing', () => {
    assert.throws(() => store.writeRecorder({ rows: {} }), { code: 'E_NO_LOCK' });
    assert.equal(has('recorder.json'), false);
  });

  it('readRecorder reports missing, ok and corrupt', () => {
    assert.deepEqual(store.readRecorder(), { state: 'missing', data: null });
    store.takeRecorderLock();
    store.writeRecorder({ rows: {}, status: 'verified' });
    assert.deepEqual(store.readRecorder(), { state: 'ok', data: { rows: {}, status: 'verified' } });
    fs.writeFileSync(path.join(dir, 'recorder.json'), '{');
    assert.equal(store.readRecorder().state, 'corrupt');
  });

  it('keeps the previous recorder.json as recorder.json.bak and leaves no tmp file', () => {
    store.takeRecorderLock();
    store.writeRecorder({ n: 1 });
    const first = read('recorder.json');
    store.writeRecorder({ n: 2 });
    assert.deepEqual(read('recorder.json.bak'), first);
    assert.deepEqual(store.readRecorder().data, { n: 2 });
    assert.deepEqual(tmpFiles(), []);
  });

  it('refuses to replace recorder.json.bak when recorder.json is corrupt', () => {
    store.takeRecorderLock();
    store.writeRecorder({ n: 1 });
    store.writeRecorder({ n: 2 });
    const bak = read('recorder.json.bak');
    fs.writeFileSync(path.join(dir, 'recorder.json'), '{');
    assert.throws(() => store.writeRecorder({ n: 3 }), { code: 'E_RECORDER_CORRUPT' });
    assert.deepEqual(read('recorder.json.bak'), bak);
  });
});

describe('mismatch history', () => {
  it('readMismatchHistory reports missing, ok and corrupt', () => {
    assert.deepEqual(store.readMismatchHistory(), { state: 'missing', data: null });
    store.takeRecorderLock();
    store.createMismatchHistory({ kind: 'start', detected_at: 1 });
    assert.equal(store.readMismatchHistory().state, 'ok');
    fs.writeFileSync(path.join(dir, 'mismatch_history.json'), '{"entries": 5}');
    assert.equal(store.readMismatchHistory().state, 'corrupt');
  });

  it('appendMismatchHistory refuses without the recorder lock', () => {
    assert.throws(() => store.appendMismatchHistory({ kind: 'mismatch' }), { code: 'E_NO_LOCK' });
  });

  it('createMismatchHistory writes one entry and refuses when the file exists', () => {
    assert.throws(() => store.createMismatchHistory({ kind: 'start' }), { code: 'E_NO_LOCK' });
    store.takeRecorderLock();
    store.createMismatchHistory({ kind: 'start', detected_at: 1 });
    assert.deepEqual(store.readMismatchHistory().data, { entries: [{ kind: 'start', detected_at: 1 }] });
    assert.throws(() => store.createMismatchHistory({ kind: 'start' }), { code: 'E_HISTORY_EXISTS' });
    assert.deepEqual(tmpFiles(), []);
  });

  it('appendMismatchHistory re-reads the file and appends', () => {
    store.takeRecorderLock();
    store.createMismatchHistory({ kind: 'start', detected_at: 1 });
    store.appendMismatchHistory({ kind: 'mismatch', tab: 'tab1', row_time: 5, values: 'absent', detected_at: 2 });
    store.appendMismatchHistory({ kind: 'mismatch', tab: 'tab2', row_time: 6, values: {}, detected_at: 3 });
    const { data } = store.readMismatchHistory();
    assert.equal(data.entries.length, 3);
    assert.equal(data.entries[2].row_time, 6);
    assert.deepEqual(tmpFiles(), []);
  });

  it('appendMismatchHistory refuses a missing or corrupt file and leaves it unchanged', () => {
    store.takeRecorderLock();
    assert.throws(() => store.appendMismatchHistory({ kind: 'mismatch' }), { code: 'E_HISTORY_MISSING' });
    assert.equal(has('mismatch_history.json'), false);
    fs.writeFileSync(path.join(dir, 'mismatch_history.json'), 'garbage');
    assert.throws(() => store.appendMismatchHistory({ kind: 'mismatch' }), { code: 'E_HISTORY_CORRUPT' });
    assert.equal(read('mismatch_history.json').toString('utf8'), 'garbage');
  });

  it('copyMismatchHistoryCorrupt keeps a copy, removes the original, and then create works', () => {
    store.takeRecorderLock();
    fs.writeFileSync(path.join(dir, 'mismatch_history.json'), 'garbage');
    const name = store.copyMismatchHistoryCorrupt();
    assert.match(name, /^mismatch_history\.json\.corrupt-\d+\.\d+$/);
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'garbage');
    assert.equal(has('mismatch_history.json'), false);
    store.createMismatchHistory({ kind: 'history_lost', detected_at: 9 });
    assert.deepEqual(store.readMismatchHistory().data, { entries: [{ kind: 'history_lost', detected_at: 9 }] });
    assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'garbage');
  });

  it('copyMismatchHistoryCorrupt refuses a parsing file and a missing file, and needs the lock', () => {
    store.takeRecorderLock();
    store.createMismatchHistory({ kind: 'start' });
    assert.throws(() => store.copyMismatchHistoryCorrupt(), { code: 'E_HISTORY_NOT_CORRUPT' });
    assert.equal(has('mismatch_history.json'), true);
    fs.rmSync(path.join(dir, 'mismatch_history.json'));
    assert.throws(() => store.copyMismatchHistoryCorrupt(), { code: 'E_HISTORY_MISSING' });
    store.releaseRecorderLock();
    fs.writeFileSync(path.join(dir, 'mismatch_history.json'), 'garbage');
    assert.throws(() => store.copyMismatchHistoryCorrupt(), { code: 'E_NO_LOCK' });
    assert.equal(has('mismatch_history.json'), true);
  });

  it('recorderFilesExist is true when either recorder file exists', () => {
    assert.equal(store.recorderFilesExist(), false);
    store.takeRecorderLock();
    store.writeRecorder({ rows: {} });
    assert.equal(store.recorderFilesExist(), true);
    fs.rmSync(path.join(dir, 'recorder.json'));
    assert.equal(store.recorderFilesExist(), false);
    store.createMismatchHistory({ kind: 'start' });
    assert.equal(store.recorderFilesExist(), true);
  });
});

describe('snapshots', () => {
  it('writes current and forward files with the sha256 of the bytes written', () => {
    const obj = { a: 1, b: [2, 3] };
    const cur = store.writeSnapshot(obj, 'current');
    assert.equal(cur.file, store.snapshotPath('current'));
    assert.equal(path.basename(cur.file), 'snapshot.json');
    assert.equal(cur.sha256, sha(read('snapshot.json')));
    assert.deepEqual(JSON.parse(read('snapshot.json').toString('utf8')), obj);
    const fwd = store.writeSnapshot({ f: true }, 'forward');
    assert.equal(path.basename(fwd.file), 'snapshot_forward.json');
    assert.equal(store.snapshotFileSha256('forward'), fwd.sha256);
    assert.deepEqual(tmpFiles(), []);
  });

  it('snapshotFileSha256 is null when the file is missing', () => {
    assert.equal(store.snapshotFileSha256('current'), null);
  });

  it('refuses an unknown kind', () => {
    assert.throws(() => store.writeSnapshot({}, 'other'), { code: 'E_USAGE' });
    assert.throws(() => store.snapshotPath('other'), { code: 'E_USAGE' });
  });

  it('readSnapshot still reads a snapshot written by writeSnapshot', () => {
    store.writeSnapshot({ x: 7 }, 'current');
    assert.deepEqual(store.readSnapshot(store.snapshotPath('current')), { x: 7 });
  });
});
