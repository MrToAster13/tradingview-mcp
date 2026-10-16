/**
 * Forward test (design v14, Report per run, forward test; line 106).
 * Pure: takes the parsed original snapshot and the parsed forward snapshot. Reads no file,
 * makes no CDP call and keeps no state. Built on sim.mjs.
 *
 * forwardSimulate throws an Error with a code: E_FORWARD_SHORT (fewer than 1000 closed 1m
 * bars after the original's last bar), E_FORWARD_MISMATCH (the forward rows do not carry the
 * original's rows over the original's range, the two sr_period_s differ, or the forward snapshot
 * is malformed). Errors from sim.mjs (prepare's E_SNAPSHOT_ABORT) pass through unchanged.
 */
import { RUN_IDS, prepare, simulateRun, summarize, sha256Rows } from './sim.mjs';

/** Closed 1m bars needed after the original's last bar before a forward report runs (line 106). */
export const FORWARD_MIN_NEW_1M = 1000;

const M1 = 60;
const CLOSED_FIELDS = ['entryTime', 'side', 'eQ', 'sQ', 'tQ', 'exitTime', 'exitQ', 'reason', 'nq'];
const OPEN_FIELDS = ['entryTime', 'side', 'eQ', 'sQ', 'tQ'];

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function checkRowList(label, list) {
  if (!Array.isArray(list)) throw fail('E_FORWARD_MISMATCH', `forward ${label} is not an array`);
  list.forEach((r, i) => {
    if (!Array.isArray(r) || !Number.isInteger(r[0])) {
      throw fail('E_FORWARD_MISMATCH', `forward ${label} row ${i} has no integer time`);
    }
  });
}

function checkStructure(fwd) {
  if (!isObj(fwd) || !isObj(fwd.rows) || !isObj(fwd.rows.m1) || !isObj(fwd.rows.m15)) {
    throw fail('E_FORWARD_MISMATCH', 'forward snapshot needs rows.m1 and rows.m15');
  }
  const { m1, m15 } = fwd.rows;
  checkRowList('rows.m1.bars', m1.bars);
  checkRowList('rows.m1.b', m1.b);
  checkRowList('rows.m1.sr', m1.sr);
  checkRowList('rows.m15.bars', m15.bars);
  checkRowList('rows.m15.b', m15.b);
  if (m1.bars.length === 0 || m15.bars.length === 0) {
    throw fail('E_FORWARD_MISMATCH', 'forward snapshot has no 1m or no 15m bars');
  }
  if (!Number.isInteger(fwd.snapshot_time)) {
    throw fail('E_FORWARD_MISMATCH', 'forward snapshot_time is not an integer');
  }
  if (typeof fwd.sha256 !== 'string' || sha256Rows(fwd.rows) !== fwd.sha256) {
    throw fail('E_FORWARD_MISMATCH', 'forward sha256 does not match its rows');
  }
}

/** Rows whose time is in [lo, hi], in their stored order. */
const within = (rows, lo, hi) => rows.filter((r) => r[0] >= lo && r[0] <= hi);

/** The forward rows in [lo, hi] must equal the original rows in the same range, position by position. */
function sameRows(label, origRows, fwdRows, lo, hi) {
  const a = within(origRows, lo, hi);
  const b = within(fwdRows, lo, hi);
  if (a.length !== b.length) {
    throw fail('E_FORWARD_MISMATCH', `${label}: the original has ${a.length} rows in its range, the forward has ${b.length}`);
  }
  a.forEach((r, i) => {
    if (JSON.stringify(r) !== JSON.stringify(b[i])) {
      throw fail('E_FORWARD_MISMATCH', `${label}: the forward row at ${b[i][0]} does not match the original row at ${r[0]}`);
    }
  });
}

const sameFields = (fields, a, b) => fields.every((k) => a[k] === b[k]);

/**
 * Compare the original's triggers with the forward run's triggers at or before the original's
 * last bar. Keys are trigger time and side (one trigger row per time).
 */
function compareRuns(orig, fwd, origLast1) {
  const keyOf = (r) => `${r.time}|${r.side}`;
  const fwdByKey = new Map(fwd.triggers.filter((r) => r.time <= origLast1).map((r) => [keyOf(r), r]));
  const origKeys = new Set(orig.triggers.map(keyOf));
  const out = { compared: 0, same: 0, insufficientInOriginal: 0, nowClosed: 0, differences: [] };
  const diff = (r, why) => out.differences.push({ time: r.time, side: r.side, why });

  for (const o of orig.triggers) {
    const f = fwdByKey.get(keyOf(o));
    if (!f) {
      diff(o, 'missing in forward');
      continue;
    }
    out.compared++;
    if (o.outcome === 'insufficient') {
      out.insufficientInOriginal++;
      continue;
    }
    if (o.outcome === 'trade') {
      if (f.outcome !== 'trade') {
        diff(o, `original trade became ${f.outcome} in forward`);
        continue;
      }
      const ot = o.trade;
      const ft = f.trade;
      if (ot.open) {
        if (!sameFields(OPEN_FIELDS, ot, ft)) {
          diff(o, 'open trade entry or levels changed');
        } else if (ft.open) {
          out.same++;
        } else {
          out.nowClosed++;
        }
        continue;
      }
      if (ft.open || !sameFields(CLOSED_FIELDS, ot, ft)) {
        diff(o, 'closed trade differs in forward');
      } else {
        out.same++;
      }
      continue;
    }
    if (f.outcome !== o.outcome) diff(o, `outcome ${o.outcome} became ${f.outcome}`);
    else out.same++;
  }
  for (const [k, f] of fwdByKey) {
    if (!origKeys.has(k)) diff(f, 'at or before the original last bar, not in the original');
  }
  return out;
}

/**
 * Forward test. Returns:
 *   original: { id, sha256, first1, last1, first15, last15 }
 *   forward:  { id, sha256, first1, first15, last1, last15, newBars1m }
 *     first1 and first15 are the forward file's own first rows, before the trim.
 *   repaint:  the repaint status of the forward simulation.
 *   lastCloseQ: last close of the forward data, in quarter points.
 *   runs: one entry per run { runId, excluded, stats, trades, comparison }.
 *     excluded is the number of forward triggers at or before the original's last bar.
 *     stats (summarize) and trades cover only triggers after the original's last bar.
 *     comparison (compareRuns) checks triggers at or before that bar against the original.
 */
export function forwardSimulate(original, forward) {
  const d1 = prepare(original);
  checkStructure(forward);
  // Both snapshots must read MarketCipher_SR at the same Resolution (absent means 60 s, as in sim.mjs),
  // or the target candidates differ and every comparison would show a false difference.
  const srOrig = original.sr_period_s === undefined ? 60 : original.sr_period_s;
  const srFwd = forward.sr_period_s === undefined ? 60 : forward.sr_period_s;
  if (srFwd !== srOrig) {
    throw fail('E_FORWARD_MISMATCH', `sr_period_s differs: the original has ${JSON.stringify(srOrig)}, the forward has ${JSON.stringify(srFwd)}`);
  }
  const origFirst1 = d1.t[0];
  const origLast1 = d1.t[d1.n - 1];
  const origFirst15 = d1.t15[0];
  const origLast15 = d1.t15[d1.n15 - 1];

  const { m1, m15 } = forward.rows;
  const newBars1m = m1.bars.filter((r) => r[0] > origLast1 && r[0] + M1 <= forward.snapshot_time).length;
  if (newBars1m < FORWARD_MIN_NEW_1M) {
    throw fail('E_FORWARD_SHORT', `forward has ${newBars1m} closed 1m bars after the original's last bar; ${FORWARD_MIN_NEW_1M} are needed`);
  }

  const o = original.rows;
  sameRows('1m bars', o.m1.bars, m1.bars, origFirst1, origLast1);
  sameRows('1m B rows', o.m1.b, m1.b, origFirst1, origLast1);
  sameRows('1m SR rows', o.m1.sr, m1.sr, origFirst1, origLast1);
  sameRows('15m bars', o.m15.bars, m15.bars, origFirst15, origLast15);
  sameRows('15m B rows', o.m15.b, m15.b, origFirst15, origLast15);

  const trimmedRows = {
    m1: {
      bars: within(m1.bars, origFirst1, Infinity),
      b: within(m1.b, origFirst1, Infinity),
      sr: within(m1.sr, origFirst1, Infinity),
    },
    m15: {
      bars: within(m15.bars, origFirst15, Infinity),
      b: within(m15.b, origFirst15, Infinity),
    },
  };
  const t1 = trimmedRows.m1.bars.map((r) => r[0]);
  const t15 = trimmedRows.m15.bars.map((r) => r[0]);
  const trimmed = {
    ...forward,
    first_1m: t1[0], last_1m: t1[t1.length - 1], count_1m: t1.length,
    first_15m: t15[0], last_15m: t15[t15.length - 1], count_15m: t15.length,
    rows: trimmedRows,
    sha256: sha256Rows(trimmedRows),
  };
  const d2 = prepare(trimmed);
  if (d2.F !== d1.F || d2.t[d2.F] !== d1.t[d1.F]) {
    throw fail('E_FORWARD_MISMATCH', 'F differs between the original and the forward snapshot');
  }

  const runs = RUN_IDS.map((runId) => {
    const r1 = simulateRun(d1, runId);
    const r2 = simulateRun(d2, runId);
    const included = r2.triggers.filter((x) => x.time > origLast1);
    return {
      runId,
      excluded: r2.triggers.length - included.length,
      stats: summarize(included),
      trades: included.filter((x) => x.outcome === 'trade').map((x) => x.trade),
      comparison: compareRuns(r1, r2, origLast1),
    };
  });

  return {
    original: {
      id: d1.info.id, sha256: d1.info.sha256,
      first1: origFirst1, last1: origLast1, first15: origFirst15, last15: origLast15,
    },
    forward: {
      id: forward.sha256.slice(0, 8), sha256: forward.sha256,
      first1: m1.bars[0][0], first15: m15.bars[0][0],
      last1: d2.info.last_1m, last15: d2.info.last_15m, newBars1m,
    },
    repaint: d2.info.repaint,
    lastCloseQ: d2.c[d2.n - 1],
    runs,
  };
}
