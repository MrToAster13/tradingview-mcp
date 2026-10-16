/**
 * mc_basic_1m file access. The only non-test file in this folder that imports node:fs.
 * Every writer is synchronous, writes one fixed name in the state folder (no path argument),
 * and writes through a temp file named <name>.tmp-<pid> followed by fsync and rename.
 */
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createHash } from 'node:crypto';

/** Fixed state folder. Created on the first write. */
export const STATE_DIR = 'C:/Users/Elijah/AppData/Local/mc_basic_1m/state';

let stateDir = STATE_DIR;

const TEST_PREFIX = 'mc_basic_1m_test-';
const NAMES = {
  log: 'trade_log.json',
  logBak: 'trade_log.json.bak',
  tradeLock: 'trade.lock',
  guard: 'guard.json',
  recorder: 'recorder.json',
  recorderBak: 'recorder.json.bak',
  recorderLock: 'recorder.lock',
  history: 'mismatch_history.json',
  snapCurrent: 'snapshot.json',
  snapForward: 'snapshot_forward.json',
};
const FLAG_RE = /^broker_failed\.\d+\.\d+\.flag$/;

/** Read and parse a snapshot JSON file. Validation is the simulator's job (sim.prepare). */
export function readSnapshot(file) {
  if (typeof file !== 'string' || file.length === 0) {
    const e = new Error('snapshot path missing');
    e.code = 'E_USAGE';
    throw e;
  }
  const full = resolve(file);
  let text;
  try {
    text = readFileSync(full, 'utf8');
  } catch (err) {
    const e = new Error(`cannot read snapshot ${full}: ${err.message}`);
    e.code = 'E_SNAPSHOT_READ';
    throw e;
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    const e = new Error(`snapshot ${full} is not valid JSON: ${err.message}`);
    e.code = 'E_SNAPSHOT_PARSE';
    throw e;
  }
}

/* ---------- test hook ---------- */

/** Test-only: point the store at a temp folder. Refuses any folder whose name lacks the test prefix. */
export function __testSetStateDir(dir) {
  if (typeof dir !== 'string' || !basename(resolve(dir)).startsWith(TEST_PREFIX)) {
    throw fail('E_TEST_DIR', `state dir must be named ${TEST_PREFIX}*`);
  }
  stateDir = resolve(dir);
}

/* ---------- helpers ---------- */

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function filePath(name) {
  return join(stateDir, name);
}

function ensureDir() {
  mkdirSync(stateDir, { recursive: true });
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function sha256Hex(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function writeAll(fd, bytes) {
  let off = 0;
  while (off < bytes.length) {
    off += writeSync(fd, bytes, off, bytes.length - off);
  }
}

function jsonBytes(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Parse bytes as a JSON object (not array, not null). Returns null when the content is not one. */
function parseObject(bytes) {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    return isObject(value) ? value : null;
  } catch {
    return null;
  }
}

function parseHistory(bytes) {
  const data = parseObject(bytes);
  return data !== null && Array.isArray(data.entries) ? data : null;
}

/** Bytes of a file in the state folder, or null when it does not exist. */
function readBytes(name) {
  try {
    return readFileSync(filePath(name));
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw fail('E_READ', `cannot read ${name}: ${err.message}`);
  }
}

/** Rename, retried 3 times over 300 ms (a reader may hold the target open). */
function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (err) {
      if (attempt >= 3) throw err;
      sleepSync(100);
    }
  }
}

/** Atomic write: <name>.tmp-<pid>, fsync, close, rename over the target. */
function writeAtomic(name, bytes) {
  ensureDir();
  const target = filePath(name);
  const tmp = join(stateDir, `${name}.tmp-${process.pid}`);
  try {
    const fd = openSync(tmp, 'w');
    try {
      writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameWithRetry(tmp, target);
  } catch (err) {
    try {
      unlinkSync(tmp);
    } catch {
      // no temp file left behind
    }
    throw err;
  }
}

/**
 * Create a new file with flag "wx". The name comes from template(ms, pid); on a name clash
 * (same millisecond, same pid) it waits 1 ms and tries again. Returns the name.
 */
function createUniqueWx(template, bytes) {
  ensureDir();
  for (let tries = 0; tries < 1000; tries++) {
    const name = template(Date.now(), process.pid);
    let fd;
    try {
      fd = openSync(filePath(name), 'wx');
    } catch (err) {
      if (err.code === 'EEXIST') {
        sleepSync(1);
        continue;
      }
      throw fail('E_WRITE', `cannot create ${name}: ${err.message}`);
    }
    try {
      if (bytes) writeAll(fd, bytes);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    return name;
  }
  throw fail('E_WRITE', 'no free file name for a new file');
}

/** Read a JSON object file. valid() adds a shape check on top of "parses to an object". */
function readJson(name, valid = () => true) {
  const bytes = readBytes(name);
  if (bytes === null) return { state: 'missing', data: null, bytes: null };
  const data = parseObject(bytes);
  if (data === null || !valid(data)) return { state: 'corrupt', data: null, bytes };
  return { state: 'ok', data, bytes };
}

function holdsLock(name) {
  const bytes = readBytes(name);
  return bytes !== null && bytes.toString('utf8').trim() === String(process.pid);
}

function requireLock(name, what) {
  if (!holdsLock(name)) {
    throw fail('E_NO_LOCK', `${what} refused: ${name} does not hold this pid`);
  }
}

/** Exclusive create of a lock file holding this pid. Throws E_LOCK_HELD when it exists. */
function takeLock(name) {
  ensureDir();
  let fd;
  try {
    fd = openSync(filePath(name), 'wx');
  } catch (err) {
    if (err.code === 'EEXIST') throw fail('E_LOCK_HELD', `${name} is already held`);
    throw fail('E_WRITE', `cannot create ${name}: ${err.message}`);
  }
  let ok = false;
  try {
    writeAll(fd, Buffer.from(String(process.pid), 'utf8'));
    fsyncSync(fd);
    ok = true;
  } finally {
    closeSync(fd);
    if (!ok) {
      try {
        unlinkSync(filePath(name));
      } catch {
        // nothing to undo
      }
    }
  }
}

/** Delete the lock only when it holds this pid. Returns true when it deleted the file. */
function releaseLock(name) {
  if (!holdsLock(name)) return false;
  unlinkSync(filePath(name));
  return true;
}

function snapshotName(kind) {
  if (kind === 'current') return NAMES.snapCurrent;
  if (kind === 'forward') return NAMES.snapForward;
  throw fail('E_USAGE', `unknown snapshot kind ${String(kind)}`);
}

/* ---------- trade log and its lock ---------- */

/** Exclusive create of trade.lock holding this pid. Throws E_LOCK_HELD when it exists. */
export function takeLogLock() {
  takeLock(NAMES.tradeLock);
}

/** Delete trade.lock only when it holds this pid. */
export function releaseLogLock() {
  return releaseLock(NAMES.tradeLock);
}

export function logLockExists() {
  return existsSync(filePath(NAMES.tradeLock));
}

/** Empty trade log shape (design "Data shapes", log). */
export function emptyLog() {
  return {
    version: 1,
    reset_count: 0,
    probes: [],
    records: {},
    last_shown: null,
    colour_ok: [],
    consumed_flags: [],
  };
}

/** Returns { state: "missing"|"ok"|"corrupt", log }. */
export function readLog() {
  const r = readJson(NAMES.log);
  return { state: r.state, log: r.data };
}

export function logBakExists() {
  return existsSync(filePath(NAMES.logBak));
}

/**
 * Write the trade log. Refuses E_NO_LOCK unless trade.lock holds this pid, and E_LOG_CORRUPT
 * when the current log does not parse (so a good log.bak is never replaced by a bad copy).
 * Copies the current log to log.bak first, then writes the new log.
 */
export function writeLog(log) {
  requireLock(NAMES.tradeLock, 'writeLog');
  if (!isObject(log)) throw fail('E_ARGS', 'writeLog needs an object');
  const current = readBytes(NAMES.log);
  if (current !== null) {
    if (parseObject(current) === null) {
      throw fail('E_LOG_CORRUPT', 'trade_log.json does not parse; log.bak is not replaced');
    }
    writeAtomic(NAMES.logBak, current);
  }
  writeAtomic(NAMES.log, jsonBytes(log));
}

/**
 * Create an empty trade log. Under the lock. Refuses E_LOG_EXISTS when the log exists and
 * E_BAK_EXISTS when log.bak exists without a log (that case needs the user's manual restore).
 */
export function createEmptyLog() {
  requireLock(NAMES.tradeLock, 'createEmptyLog');
  if (existsSync(filePath(NAMES.log))) throw fail('E_LOG_EXISTS', 'trade_log.json already exists');
  if (existsSync(filePath(NAMES.logBak))) throw fail('E_BAK_EXISTS', 'log.bak exists; restore by hand');
  writeAtomic(NAMES.log, jsonBytes(emptyLog()));
}

/* ---------- guard.json ---------- */

/** Returns { state: "missing"|"ok"|"corrupt", guard, bytes } (bytes: the raw file, or null). */
export function readGuard() {
  const r = readJson(NAMES.guard);
  return { state: r.state, guard: r.data, bytes: r.bytes };
}

/** Atomic write of guard.json. Refuses E_NO_LOCK unless trade.lock holds this pid. */
export function writeGuard(guard) {
  requireLock(NAMES.tradeLock, 'writeGuard');
  if (!isObject(guard)) throw fail('E_ARGS', 'writeGuard needs an object');
  writeAtomic(NAMES.guard, jsonBytes(guard));
}

/**
 * Copy an unparseable guard.json to guard.json.corrupt-<ms>.<pid> (flag "wx"). Under the lock.
 * Refuses E_GUARD_NOT_CORRUPT when the file parses. Returns the copy's name.
 */
export function copyGuardCorrupt() {
  requireLock(NAMES.tradeLock, 'copyGuardCorrupt');
  const bytes = readBytes(NAMES.guard);
  if (bytes === null) throw fail('E_NO_GUARD', 'guard.json is missing; nothing to copy');
  if (parseObject(bytes) !== null) throw fail('E_GUARD_NOT_CORRUPT', 'guard.json parses; no corrupt copy');
  return createUniqueWx((ms, pid) => `guard.json.corrupt-${ms}.${pid}`, bytes);
}

/* ---------- flags ---------- */

/** Create broker_failed.<ms>.<pid>.flag (flag "wx"), fsync, close. Returns the name. */
export function createBrokerFailedFlag() {
  return createUniqueWx(
    (ms, pid) => `broker_failed.${ms}.${pid}.flag`,
    Buffer.from('broker_failed\n', 'utf8'),
  );
}

/** Sorted names of the broker_failed flag files. */
export function listFlagFiles() {
  let names;
  try {
    names = readdirSync(stateDir);
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw fail('E_READ', `cannot list ${stateDir}: ${err.message}`);
  }
  return names.filter((n) => FLAG_RE.test(n)).sort();
}

/** "<first 8 hex of sha256 of guard.json, or missing>+<flag file count>". */
export function guardDigest() {
  const bytes = readBytes(NAMES.guard);
  const part = bytes === null ? 'missing' : sha256Hex(bytes).slice(0, 8);
  return `${part}+${listFlagFiles().length}`;
}

/* ---------- recorder lock and files ---------- */

export function takeRecorderLock() {
  takeLock(NAMES.recorderLock);
}

export function releaseRecorderLock() {
  return releaseLock(NAMES.recorderLock);
}

/** The pid in recorder.lock, or null when there is no lock or its content is not a pid. */
export function recorderLockPid() {
  const bytes = readBytes(NAMES.recorderLock);
  if (bytes === null) return null;
  const text = bytes.toString('utf8').trim();
  return /^\d+$/.test(text) ? Number(text) : null;
}

/** Returns { state: "missing"|"ok"|"corrupt", data } for recorder.json. */
export function readRecorder() {
  const r = readJson(NAMES.recorder);
  return { state: r.state, data: r.data };
}

/**
 * Write recorder.json, after copying the current file to recorder.json.bak. Refuses E_NO_LOCK
 * unless recorder.lock holds this pid, and E_RECORDER_CORRUPT when the current file does not parse.
 */
export function writeRecorder(data) {
  requireLock(NAMES.recorderLock, 'writeRecorder');
  if (!isObject(data)) throw fail('E_ARGS', 'writeRecorder needs an object');
  const current = readBytes(NAMES.recorder);
  if (current !== null) {
    if (parseObject(current) === null) {
      throw fail('E_RECORDER_CORRUPT', 'recorder.json does not parse; recorder.json.bak is not replaced');
    }
    writeAtomic(NAMES.recorderBak, current);
  }
  writeAtomic(NAMES.recorder, jsonBytes(data));
}

/* ---------- mismatch history ---------- */

/** Returns { state: "missing"|"ok"|"corrupt", data } for mismatch_history.json. */
export function readMismatchHistory() {
  const r = readJson(NAMES.history, (d) => Array.isArray(d.entries));
  return { state: r.state, data: r.data };
}

/**
 * Re-read mismatch_history.json, append one entry, write it atomically. Requires the recorder lock.
 * Refuses E_HISTORY_MISSING (use createMismatchHistory) and E_HISTORY_CORRUPT.
 */
export function appendMismatchHistory(entry) {
  requireLock(NAMES.recorderLock, 'appendMismatchHistory');
  if (!isObject(entry)) throw fail('E_ARGS', 'appendMismatchHistory needs an object');
  const bytes = readBytes(NAMES.history);
  if (bytes === null) throw fail('E_HISTORY_MISSING', 'mismatch_history.json is missing');
  const data = parseHistory(bytes);
  if (data === null) throw fail('E_HISTORY_CORRUPT', 'mismatch_history.json does not parse');
  data.entries.push(entry);
  writeAtomic(NAMES.history, jsonBytes(data));
}

/**
 * Create mismatch_history.json with one entry. Requires the recorder lock.
 * Refuses E_HISTORY_EXISTS when the file is there.
 */
export function createMismatchHistory(firstEntry) {
  requireLock(NAMES.recorderLock, 'createMismatchHistory');
  if (!isObject(firstEntry)) throw fail('E_ARGS', 'createMismatchHistory needs an object');
  if (existsSync(filePath(NAMES.history))) throw fail('E_HISTORY_EXISTS', 'mismatch_history.json already exists');
  writeAtomic(NAMES.history, jsonBytes({ entries: [firstEntry] }));
}

/**
 * Copy an unparseable mismatch_history.json to mismatch_history.json.corrupt-<ms>.<pid> (flag "wx"),
 * then delete the original so createMismatchHistory can run. Requires the recorder lock.
 * Refuses E_HISTORY_NOT_CORRUPT when the file parses. Returns the copy's name.
 */
export function copyMismatchHistoryCorrupt() {
  requireLock(NAMES.recorderLock, 'copyMismatchHistoryCorrupt');
  const bytes = readBytes(NAMES.history);
  if (bytes === null) throw fail('E_HISTORY_MISSING', 'mismatch_history.json is missing');
  if (parseHistory(bytes) !== null) throw fail('E_HISTORY_NOT_CORRUPT', 'mismatch_history.json parses');
  const name = createUniqueWx((ms, pid) => `mismatch_history.json.corrupt-${ms}.${pid}`, bytes);
  unlinkSync(filePath(NAMES.history));
  return name;
}

/** True when recorder.json or mismatch_history.json exists. */
export function recorderFilesExist() {
  return existsSync(filePath(NAMES.recorder)) || existsSync(filePath(NAMES.history));
}

/* ---------- snapshots ---------- */

/** Full path of the snapshot file for kind "current" or "forward". */
export function snapshotPath(kind) {
  return filePath(snapshotName(kind));
}

/**
 * Atomic write of the snapshot for kind "current" or "forward". Needs no lock; snapshot.mjs
 * clears "last shown" under the trade-log lock before it calls this.
 * Returns { file, sha256 } where sha256 is the hex digest of the bytes written.
 */
export function writeSnapshot(obj, kind) {
  const name = snapshotName(kind);
  if (obj === null || typeof obj !== 'object') throw fail('E_ARGS', 'writeSnapshot needs an object');
  const bytes = jsonBytes(obj);
  writeAtomic(name, bytes);
  return { file: filePath(name), sha256: sha256Hex(bytes) };
}

/** Hex SHA-256 of the snapshot file on disk, or null when it is missing. */
export function snapshotFileSha256(kind) {
  const bytes = readBytes(snapshotName(kind));
  return bytes === null ? null : sha256Hex(bytes);
}
