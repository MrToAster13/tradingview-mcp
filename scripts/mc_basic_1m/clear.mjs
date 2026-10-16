/**
 * clear command (design lines 169-171). Checks that a run's drawings are gone from tab 1, then marks
 * the run's pending and drawn records "cleared". It never removes a shape (design line 169).
 * Usage: clear <run id> --expect-guard <digest> [--colour-ok <ids>] [--chart-empty-ok]
 * Exit: 0 when cleared, 1 when refused, 2 for usage.
 *
 * Shared helpers (guard gate, colour-ok storage, tab 1 read, lock wrapper) come from resolve.mjs.
 */
import * as store from './store.mjs';
import * as shapes from './shapes.mjs';
import {
  CLEAR_GAP_MS,
  CLEAR_USAGE,
  checkRunSettled,
  fmtShape,
  guardGate,
  loadLog,
  parseArgs,
  readTab1,
  refusal,
  storeColourOk,
  withTradeLock,
} from './resolve.mjs';

/** Entry point. Takes deps as in design line 13 and returns the exit code. */
export async function main(argv, deps) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    deps.err(e.message);
    deps.err(CLEAR_USAGE);
    return 2;
  }
  if (opts.pos.length !== 1) {
    deps.err(CLEAR_USAGE);
    return 2;
  }
  const runId = opts.pos[0];

  try {
    checkRunSettled(loadLog(), runId, deps.now());
  } catch (e) {
    deps.err(`${e.code || 'E_ERROR'}: ${e.message}`);
    return 1;
  }

  return withTradeLock(deps, async () => {
    const log = loadLog();
    const guard = guardGate(opts, log, deps);
    storeColourOk(opts, log, guard);
    checkRunSettled(log, runId, deps.now());

    const read1 = await readTab1(deps);
    await deps.sleep(CLEAR_GAP_MS);
    const read2 = await readTab1(deps);
    const stable = shapes.loadingTest(read1, read2, opts.chartEmptyOk);
    if (!stable.ok) throw refusal(`tab 1 reads not settled: ${stable.reason}`);

    const check = shapes.clearCheck({ shapes: read2, runId, log, guard });
    for (const r of check.reported || []) deps.out(`reported, not blocking: ${fmtShape(r)}`);
    const blocking = check.blocking || [];
    if (blocking.length > 0) {
      for (const b of blocking) deps.err(`still on tab 1: ${fmtShape(b)}`);
      throw refusal(`${blocking.length} stored shape(s) of run ${runId} still on tab 1; delete them by hand, then run clear again`);
    }

    const now = deps.now();
    let changed = 0;
    for (const r of Object.values(log.records || {})) {
      if (r && r.run === runId && (r.state === 'pending' || r.state === 'drawn')) {
        r.state = 'cleared';
        r.written_at = now;
        changed++;
      }
    }
    if (changed > 0) store.writeLog(log);
    deps.out(`cleared ${changed} record(s) of run ${runId}`);
    return 0;
  });
}
