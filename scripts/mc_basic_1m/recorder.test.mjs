import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as store from './store.mjs';
import { main } from './recorder.mjs';

const made = [];

/** Fresh state folder for one test. Its name carries the prefix store.mjs requires. */
function newStateDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mc_basic_1m_test-'));
  made.push(dir);
  store.__testSetStateDir(dir);
  return dir;
}

after(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const T0 = 1_700_000_000; // unix seconds, first bar open
const BAR_COUNT = 10;

/** A chart with BAR_COUNT closed 1m bars. Plot k of a B row sits at index k; SR row has plots 1..5. */
function makeChart() {
  const bars = [];
  const b = [];
  const sr = [];
  for (let i = 0; i < BAR_COUNT; i++) {
    const t = T0 + 60 * i;
    bars.push([t, 10, 11, 9, 10, 100]);
    const bRow = [t];
    for (let k = 1; k <= 16; k++) bRow.push(k + i / 100);
    b.push(bRow);
    sr.push([t, 1, 2, 3, 4, 5]);
  }
  return { bars, b, sr };
}

/** The read_history result for one tab, copied so mutations between polls stay visible only via the chart. */
function readResult(chart, tab) {
  const copy = JSON.parse(JSON.stringify(chart));
  const bPlots = Array.from({ length: 16 }, (_, k) => ({ id: `plot_${k + 1}`, type: 'line' }));
  const srPlots = Array.from({ length: 5 }, (_, k) => ({ id: `sr_${k + 1}`, type: 'line' }));
  if (tab === 'tab2') return [copy.bars, copy.b, null, bPlots, null];
  return [copy.bars, copy.b, copy.sr, bPlots, srPlots];
}

/**
 * Mock deps. The clock is in ms and starts after the last bar closes, so every bar is closed.
 * afterSleep(state) runs after each sleep, with state.sleeps counting the sleeps so far.
 */
function makeDeps({ chart = makeChart(), tab2Fails = false, afterSleep = () => {} } = {}) {
  const out = [];
  const err = [];
  const reads = [];
  const state = { sleeps: 0, chart: { tab1: chart, tab2: makeChart() } };
  const clock = { t: (T0 + 3600) * 1000 };
  const deps = {
    run: async (name, args, tab) => {
      if (name !== 'read_history') throw new Error(`unexpected template ${name}`);
      reads.push(tab);
      if (tab === 'tab2' && tab2Fails) {
        throw Object.assign(new Error('no tab 2 page'), { code: 'E_TAB2_NONE' });
      }
      return readResult(state.chart[tab], tab);
    },
    now: () => clock.t,
    sleep: async (ms) => {
      clock.t += ms;
      state.sleeps += 1;
      afterSleep(state);
    },
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  return { deps, out, err, reads, state, clock };
}

function historyEntries() {
  return store.readMismatchHistory().data.entries;
}

test('recorder: lock held returns 1 and writes nothing', async () => {
  newStateDir();
  store.takeRecorderLock();
  try {
    const { deps, err } = makeDeps();
    const code = await main(['--max-polls', '1'], deps);
    assert.equal(code, 1);
    assert.ok(err.some((line) => line.includes('held')), err.join('\n'));
    assert.equal(store.readRecorder().state, 'missing');
    assert.equal(store.readMismatchHistory().state, 'missing');
  } finally {
    store.releaseRecorderLock();
  }
});

test('recorder: one poll writes recorder.json and a start entry', async () => {
  newStateDir();
  const { deps, out, clock } = makeDeps();
  const code = await main(['--max-polls', '1'], deps);
  assert.equal(code, 0);

  const rec = store.readRecorder();
  assert.equal(rec.state, 'ok');
  assert.equal(rec.data.last_poll_t1, clock.t);
  assert.equal(rec.data.last_poll_t2, clock.t);
  assert.ok(Object.keys(rec.data.rows.tab1).length > 0, 'closed rows stored on tab 1');

  const entries = historyEntries();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].kind, 'start');
  assert.equal(entries[0].detected_at, clock.t);

  assert.ok(out.some((line) => line.startsWith('guard_digest = ')));
});

test('recorder: a changed watched value on a stored row appends one mismatch', async () => {
  newStateDir();
  const changedRow = makeChart().b[8];
  let changedIndex = null;
  // After poll 1 (rows stored), change plot 2 of bar 8 once and leave it changed.
  const { deps, out, state } = makeDeps({
    afterSleep: (s) => {
      if (s.sleeps === 1) {
        changedIndex = 8;
        s.chart.tab1.b[changedIndex][2] = 999;
      }
    },
  });
  const code = await main(['--max-polls', '4'], deps);
  assert.equal(code, 0);
  assert.equal(state.sleeps, 3);

  const mismatches = historyEntries().filter((e) => e.kind === 'mismatch');
  assert.equal(mismatches.length, 1, 'one entry for one changed row, not one per poll');
  assert.equal(mismatches[0].tab, 'tab1');
  assert.equal(mismatches[0].row_time, changedRow[0]);
  assert.ok(JSON.stringify(mismatches[0].values).includes('999'));
  assert.ok(out.some((line) => line.startsWith('MISMATCH tab1')));
  assert.equal(store.readRecorder().state, 'ok');
});

test('recorder: corrupt history stops without --rename-corrupt and recovers with it', async () => {
  const dir = newStateDir();
  const historyPath = join(dir, 'mismatch_history.json');
  writeFileSync(historyPath, 'not json');

  const first = makeDeps();
  assert.equal(await main(['--max-polls', '1'], first.deps), 1);
  assert.ok(first.err.some((line) => line.includes('does not parse')), first.err.join('\n'));
  assert.equal(readFileSync(historyPath, 'utf8'), 'not json', 'corrupt file is left in place');
  assert.equal(store.recorderLockPid(), null);

  const second = makeDeps();
  assert.equal(await main(['--rename-corrupt', '--max-polls', '1'], second.deps), 0);
  const kinds = historyEntries().map((e) => e.kind);
  assert.deepEqual(kinds, ['history_lost', 'start']);
  const copies = readdirSync(dir).filter((f) => f.startsWith('mismatch_history.json.corrupt-'));
  assert.equal(copies.length, 1);
  assert.equal(readFileSync(join(dir, copies[0]), 'utf8'), 'not json');
});

test('recorder: lock is released after a run and after a refusal', async () => {
  const dir = newStateDir();
  const ok = makeDeps();
  assert.equal(await main(['--max-polls', '1'], ok.deps), 0);
  assert.equal(store.recorderLockPid(), null);
  assert.equal(existsSync(join(dir, 'recorder.lock')), false);

  // A second run can take the lock again.
  const again = makeDeps();
  assert.equal(await main(['--max-polls', '1'], again.deps), 0);
  assert.equal(store.recorderLockPid(), null);

  writeFileSync(join(dir, 'mismatch_history.json'), 'not json');
  const refused = makeDeps();
  assert.equal(await main(['--max-polls', '1'], refused.deps), 1);
  assert.equal(store.recorderLockPid(), null);
});

test('recorder: a failed tab 2 read keeps polling tab 1 and leaves last_poll_t2 unset', async () => {
  newStateDir();
  const { deps, err, clock } = makeDeps({ tab2Fails: true });
  assert.equal(await main(['--max-polls', '1'], deps), 0);
  assert.ok(err.some((line) => line.startsWith('tab2 read failed')), err.join('\n'));
  const rec = store.readRecorder();
  assert.equal(rec.data.last_poll_t1, clock.t);
  assert.equal(rec.data.last_poll_t2, null);
});

test('recorder: a bad --max-polls value is a usage error and takes no lock', async () => {
  newStateDir();
  const { deps, err } = makeDeps();
  assert.equal(await main(['--max-polls', 'x'], deps), 2);
  assert.ok(err.length > 0);
  assert.equal(store.recorderLockPid(), null);
  assert.equal(store.readRecorder().state, 'missing');
});
