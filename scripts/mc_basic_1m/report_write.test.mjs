/**
 * Tests for the report.mjs writes: "last shown" in the trade log (design line 163) and the
 * --forward option (design line 106). Temp state dir only, synthetic snapshots, no CDP.
 * Run: node --test scripts/mc_basic_1m/report_write.test.mjs
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { __testSetStateDir, readLog, emptyLog } from './store.mjs';
import { FORMAT, RUN_IDS, sha256Rows, simulate } from './sim.mjs';
import { main, tradeListSha256 } from './report.mjs';

const SCRIPT = 'scripts/mc_basic_1m/report.mjs';
const T0 = Date.UTC(2026, 9, 14, 9, 0, 0) / 1000;
const ORIG_LAST = 499;
const FWD_LAST = 1499;

const layout = () => Array.from({ length: 16 }, (_, i) => ({ id: `plot_${i}`, type: 'line' }));

/**
 * Synthetic snapshot covering rows startRow..lastRow (same design as forward.test.mjs): setups
 * every 30 rows from row 320, even setups win, odd setups lose. A setup whose candidate bar
 * would land inside the original range is left out, so the forward world agrees with the original.
 */
function snapshot({ startRow = 0, lastRow }) {
  const n = lastRow - startRow + 1;
  const t = Array.from({ length: n }, (_, i) => T0 + 60 * (startRow + i));
  const fill = (v) => new Array(n).fill(v);
  const m1 = {
    o: fill(5000), h: fill(5000), l: fill(5000), c: fill(5000),
    bw: fill(0), mf: fill(0), buy: fill(0), cross: fill(null), sto: fill(0), res: fill(null), sup: fill(null),
  };
  const setBar = (i, o, h, l, c) => { m1.o[i] = o; m1.h[i] = h; m1.l[i] = l; m1.c[i] = c; };

  for (let s = 0; ; s += 1) {
    const d = 320 + 30 * s;
    if (d + 6 > lastRow) break;
    if (d + 6 > ORIG_LAST && d - 13 <= ORIG_LAST) continue;
    const win = s % 2 === 0;
    const D = d - startRow;
    const K = D + 2;
    m1.buy[D] = 1;
    m1.bw[D] = -65;
    m1.bw[K] = m1.bw[K - 1] + 1;
    m1.mf[K] = m1.mf[K - 1] + 1;
    m1.sto[K] = m1.sto[K - 1] + 1;
    const j = D - 10;
    m1.h[j - 3] = 5010;
    m1.res[j - 1] = 5000;
    m1.res[j] = 5010;
    setBar(D + 1, 5000, 5000, 4996, 5000);
    setBar(K + 1, 5001, 5001, 5001, 5001);
    if (win) setBar(K + 4, 5005, 5012, 5005, 5010);
    else setBar(K + 4, 5001, 5001, 4990, 4992);
  }

  const tL = t[n - 1];
  const t15 = [];
  const first15 = t[0] - (t[0] % 900);
  for (let b = first15 - 100 * 900; b + 900 <= tL + 60; b += 900) t15.push(b);

  const bars = t.map((x, i) => [x, m1.o[i], m1.h[i], m1.l[i], m1.c[i], 100]);
  const b = t.map((x, i) => {
    const r = [x, ...new Array(16).fill(0)];
    r[2] = m1.bw[i]; r[4] = m1.mf[i]; r[6] = m1.buy[i]; r[8] = m1.cross[i]; r[16] = m1.sto[i];
    return r;
  });
  const sr = t.map((x, i) => [x, 0, 0, 0, m1.res[i], m1.sup[i]]);
  const bars15 = t15.map((S) => [S, 5000, 5000, 5000, 5000, 1000]);
  const b15 = t15.map((S) => {
    const r = [S, ...new Array(16).fill(0)];
    r[2] = S / 900; r[4] = S / 900; r[15] = S / 900;
    return r;
  });
  const rows = { m1: { bars, b, sr }, m15: { bars: bars15, b: b15 } };
  return {
    format: FORMAT,
    snapshot_time: tL + 60,
    symbol: 'CME_MINI:MES1!',
    first_1m: t[0], last_1m: tL, count_1m: n,
    first_15m: t15[0], last_15m: t15[t15.length - 1], count_15m: t15.length,
    plots_b_1m: layout(),
    plots_b_15m: layout(),
    inputs_b_1m: ['enc-1'],
    inputs_b_15m: ['enc-1'],
    sha256: sha256Rows(rows),
    rows,
  };
}

let stateDir;

/** Captures what main writes. */
function capture() {
  const out = [];
  const err = [];
  return { io: { stdout: (s) => out.push(s), stderr: (s) => err.push(s) }, out, err };
}

const write = (name, text) => { const p = `${stateDir}/${name}`; writeFileSync(p, text); return p; };
const writeJson = (name, obj) => write(name, JSON.stringify(obj));
const exists = (name) => existsSync(`${stateDir}/${name}`);
const argv = (...rest) => ['node', SCRIPT, ...rest];

beforeEach(() => {
  // The prefix is required by store.mjs; the temp folder name starts with mc_basic_1m_test-.
  stateDir = mkdtempSync(`${tmpdir()}/mc_basic_1m_test-`);
  __testSetStateDir(stateDir);
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe('report.mjs: last shown (design line 163)', () => {
  it('writes last_shown with the snapshot hash and a trade-list hash per run, then releases the lock', () => {
    const orig = snapshot({ lastRow: ORIG_LAST });
    const origFile = writeJson('orig.json', orig);
    const c = capture();
    assert.equal(main(argv(origFile), c.io), 0);
    assert.deepEqual(c.err, []);
    assert.match(c.out.join(''), /^repaint unverified\n/);

    const log = readLog();
    assert.equal(log.state, 'ok');
    const res = simulate(orig);
    assert.equal(log.log.last_shown.snapshot_sha256, res.info.sha256);
    assert.deepEqual(Object.keys(log.log.last_shown.runs), [...RUN_IDS]);
    for (const run of res.runs) {
      assert.equal(log.log.last_shown.runs[run.runId], tradeListSha256(run.trades), run.runId);
    }
    assert.equal(exists('trade.lock'), false, 'lock released');
  });

  it('overwrites an existing log, keeping its old bytes in log.bak and its reset_count', () => {
    const old = { ...emptyLog(), reset_count: 7 };
    const oldText = JSON.stringify(old);
    write('trade_log.json', oldText);
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile), c.io), 0);
    assert.equal(readFileSync(`${stateDir}/trade_log.json.bak`, 'utf8'), oldText);
    const log = readLog().log;
    assert.equal(log.reset_count, 7);
    assert.notEqual(log.last_shown, null);
  });

  it('creates the empty log first when none exists', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    assert.equal(exists('trade_log.json'), false);
    assert.equal(main(argv(origFile), capture().io), 0);
    // writeLog copies the current log (the fresh empty one) to log.bak before it writes the new log.
    assert.equal(JSON.parse(readFileSync(`${stateDir}/trade_log.json.bak`, 'utf8')).last_shown, null);
    assert.equal(readLog().log.version, 1);
    assert.notEqual(readLog().log.last_shown, null);
  });

  it('refuses when another pid holds the lock: exit 1, no stdout, lock left alone, no log written', () => {
    write('trade.lock', '999999');
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile), c.io), 1);
    assert.deepEqual(c.out, []);
    assert.match(c.err.join(''), /^E_LOCK_HELD: /);
    assert.equal(readFileSync(`${stateDir}/trade.lock`, 'utf8'), '999999');
    assert.equal(exists('trade_log.json'), false);
  });

  it('refuses a corrupt log: exit 1, no stdout, file untouched, no log.bak', () => {
    write('trade_log.json', 'not json{');
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile), c.io), 1);
    assert.deepEqual(c.out, []);
    assert.match(c.err.join(''), /^E_LOG_CORRUPT: /);
    assert.equal(readFileSync(`${stateDir}/trade_log.json`, 'utf8'), 'not json{');
    assert.equal(exists('trade_log.json.bak'), false);
    assert.equal(exists('trade.lock'), false, 'lock released after the refusal');
  });
});

describe('report.mjs: --forward (design line 106)', () => {
  it('prints the forward section and writes last shown when the forward snapshot is valid', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const fwdFile = writeJson('fwd.json', snapshot({ lastRow: FWD_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile, '--forward', fwdFile), c.io), 0);
    assert.deepEqual(c.err, []);
    const text = c.out.join('');
    assert.match(text, /== forward test \(design line 106\) ==/);
    assert.match(text, /closed 1m bars after the original last bar: 1000/);
    assert.notEqual(readLog().log.last_shown, null);
  });

  it('a bad forward file: exit 1, no stdout, no last_shown write', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile, '--forward', `${stateDir}/missing.json`), c.io), 1);
    assert.deepEqual(c.out, []);
    assert.match(c.err.join(''), /^E_SNAPSHOT_READ: /);
    assert.equal(exists('trade_log.json'), false);
  });

  it('a forward that is too short: exit 1 with E_FORWARD_SHORT and no last_shown write', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const fwdFile = writeJson('fwd.json', snapshot({ lastRow: 1498 }));
    const c = capture();
    assert.equal(main(argv(origFile, '--forward', fwdFile), c.io), 1);
    assert.deepEqual(c.out, []);
    assert.match(c.err.join(''), /^E_FORWARD_SHORT: /);
    assert.equal(exists('trade_log.json'), false);
  });
});

describe('report.mjs: usage', () => {
  it('no snapshot argument: exit 2, usage on stderr, no log created', () => {
    const c = capture();
    assert.equal(main(argv(), c.io), 2);
    assert.deepEqual(c.out, []);
    assert.equal(c.err.join(''), 'usage: node scripts/mc_basic_1m/report.mjs <snapshot.json> [--forward <forward_snapshot.json>]'
      + ' [--target sr|1R|srsl|band|next|next15] (only --target sr can be combined with --forward)\n');
    assert.equal(exists('trade_log.json'), false);
  });

  it('--forward with no file, or two snapshot files: exit 2', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    assert.equal(main(argv(origFile, '--forward'), capture().io), 2);
    assert.equal(main(argv(origFile, origFile, '--forward', origFile), capture().io), 2);
    assert.equal(exists('trade_log.json'), false);
  });
});

describe('report.mjs: --target', () => {
  it('--target 1R prints the 1R banner, sets T at E plus or minus D, and leaves last shown alone', () => {
    const orig = snapshot({ lastRow: ORIG_LAST });
    const origFile = writeJson('orig.json', orig);
    const c = capture();
    assert.equal(main(argv(origFile, '--target', '1R'), c.io), 0);
    assert.deepEqual(c.err, []);
    assert.match(c.out.join(''), /TARGET MODE 1R/);
    assert.match(c.out.join(''), /NOT RECORDED: this report does not change last shown/);
    const res = simulate(orig, { target: '1R' });
    assert.ok(res.runs.some((r) => r.trades.length > 0));
    for (const run of res.runs) {
      for (const t of run.trades) assert.equal(Math.abs(t.tQ - t.eQ), t.dQ);
    }
    assert.equal(exists('trade_log.json'), false);
  });

  it('a 1R report after an SR report keeps the SR trade lists as last shown', () => {
    const orig = snapshot({ lastRow: ORIG_LAST });
    const origFile = writeJson('orig.json', orig);
    assert.equal(main(argv(origFile), capture().io), 0);
    const before = JSON.stringify(readLog().log.last_shown);
    assert.equal(main(argv(origFile, '--target', '1R'), capture().io), 0);
    assert.equal(JSON.stringify(readLog().log.last_shown), before);
    for (const run of simulate(orig).runs) {
      assert.equal(readLog().log.last_shown.runs[run.runId], tradeListSha256(run.trades), run.runId);
    }
  });

  it('--target sr prints the same report as the default, with no banner', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const a = capture();
    const b = capture();
    assert.equal(main(argv(origFile), a.io), 0);
    assert.equal(main(argv(origFile, '--target', 'sr'), b.io), 0);
    assert.equal(a.out.join(''), b.out.join(''));
    assert.doesNotMatch(a.out.join(''), /TARGET MODE/);
  });

  it('a bad, missing or repeated mode, or 1R with --forward: exit 2 and no log', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    for (const extra of [['--target', '2R'], ['--target'], ['--target', '1R', '--target', 'sr'],
      ['--target', '1R', '--forward', origFile], ['--forward', origFile, '--target', '1R'],
      ['--forward', origFile, '--forward', origFile],
      ['--target', 'srsl', '--forward', origFile], ['--forward', origFile, '--target', 'srsl'],
      ['--target', 'srsl', '--target', '1R'],
      ['--target', 'band', '--forward', origFile], ['--forward', origFile, '--target', 'band'],
      ['--target', 'band', '--target', 'srsl'],
      ['--target', 'next', '--forward', origFile], ['--forward', origFile, '--target', 'next15'],
      ['--target', 'next', '--target', 'next15'], ['--target', 'next20']]) {
      assert.equal(main(argv(origFile, ...extra), capture().io), 2, extra.join(' '));
    }
    assert.equal(exists('trade_log.json'), false);
  });

  it('--target srsl prints the srsl banner and a no stop funnel bucket, and leaves last shown alone', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile, '--target', 'srsl'), c.io), 0);
    assert.deepEqual(c.err, []);
    const out = c.out.join('');
    assert.match(out, /TARGET MODE srsl/);
    assert.match(out, /NOT RECORDED: .*srsl trades cannot be drawn/);
    assert.match(out, / \+ no stop \d+ \+ closed trades /);
    assert.equal(exists('trade_log.json'), false);
  });

  it('sr and 1R reports print no no stop bucket', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    for (const mode of ['sr', '1R']) {
      const c = capture();
      assert.equal(main(argv(origFile, '--target', mode), c.io), 0);
      assert.doesNotMatch(c.out.join(''), / \+ no stop /, mode);
    }
  });

  it('--target band prints the band banner and an outside band funnel bucket, and leaves last shown alone', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    const c = capture();
    assert.equal(main(argv(origFile, '--target', 'band'), c.io), 0);
    assert.deepEqual(c.err, []);
    const out = c.out.join('');
    assert.match(out, /TARGET MODE band/);
    assert.match(out, /NOT RECORDED: .*band trades cannot be drawn/);
    assert.match(out, / \+ outside band \d+ \+ closed trades /);
    assert.doesNotMatch(out, / \+ no stop /);
    assert.equal(exists('trade_log.json'), false);
  });

  it('sr, 1R and srsl reports print no outside band bucket', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    for (const mode of ['sr', '1R', 'srsl']) {
      const c = capture();
      assert.equal(main(argv(origFile, '--target', mode), c.io), 0);
      assert.doesNotMatch(c.out.join(''), / \+ outside band /, mode);
    }
  });

  it('--target next and next15 print their banner, Trend4 run rules and under 1.5R bucket, and leave last shown alone', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    for (const mode of ['next', 'next15']) {
      const c = capture();
      assert.equal(main(argv(origFile, '--target', mode), c.io), 0);
      assert.deepEqual(c.err, []);
      const out = c.out.join('');
      assert.match(out, new RegExp(`TARGET MODE ${mode}: `), mode);
      assert.match(out, /judged by Trend4/, mode);
      assert.match(out, /== HTF-a: Trend4\(15m Mny Flow\) /, mode);
      assert.match(out, new RegExp(`NOT RECORDED: .*${mode} trades cannot be drawn`), mode);
      assert.match(out, / \+ outside band \d+ \+ under 1\.5R \d+ \+ closed trades /, mode);
      assert.doesNotMatch(out, / \+ no stop /, mode);
    }
    assert.equal(exists('trade_log.json'), false);
  });

  it('sr, 1R, srsl and band reports print no under 1.5R bucket and no Trend4 rule', () => {
    const origFile = writeJson('orig.json', snapshot({ lastRow: ORIG_LAST }));
    for (const mode of ['sr', '1R', 'srsl', 'band']) {
      const c = capture();
      assert.equal(main(argv(origFile, '--target', mode), c.io), 0);
      assert.doesNotMatch(c.out.join(''), / \+ under 1\.5R |Trend4/, mode);
    }
  });
});
