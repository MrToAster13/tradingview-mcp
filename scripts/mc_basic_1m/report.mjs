/**
 * mc_basic_1m report: node scripts/mc_basic_1m/report.mjs <snapshot.json> [--forward <forward_snapshot.json>] [--target sr|1R|srsl|band|next|next15]
 * Prints the three run reports (HTF-a, HTF-b, HTF-c). Reads snapshots through store.mjs and
 * makes no CDP call. Under the trade-log lock it writes "last shown" into the log (design
 * line 163): the snapshot's SHA-256 and, per run, a SHA-256 of the trade list shown. Then it
 * prints the report. --forward adds the forward test (design line 106) from forward.mjs.
 * --target 1R sets every target at 1R (E plus or minus D) instead of the nearest Cipher
 * Resistance/Support. --target srsl keeps the Cipher target and puts the stop 1 tick beyond the
 * nearest opposite Cipher level 2 to 8 points away. --target band targets the Cipher Resistance
 * (longs) or Support (shorts) plotted on the trigger row and stops 1 tick beyond the other one.
 * --target next keeps the band stop and targets the nearest past Cipher line beyond E, skipping
 * trades under 1.5R; --target next15 targets the nearest past line at least 1.5R away. Both judge
 * 15m Mny Flow by Avg4 (its 4-bar average must move the trade's way, and the latest bar must not move against it).
 * None of 1R, srsl, band, next and next15 can be combined with --forward.
 *
 * main returns the exit code: 0 on success, 1 on any error (nothing is printed on a lock or log
 * failure), 2 on bad usage.
 */
import { pathToFileURL } from 'node:url';
import { readSnapshot, takeLogLock, releaseLogLock, readLog, createEmptyLog, writeLog } from './store.mjs';
import {
  simulate, etLabel, fmtRate, fmtDollarsNq, fmtPriceQ, fmtR, rHundredths, RUN_RULES, RUN_RULES_TREND, sha256Rows,
  TARGET_MODES,
} from './sim.mjs';
import { forwardSimulate } from './forward.mjs';

/** SHA-256 of one run's trade list as shown: entry time, side, E, S, T for every trade (design line 163). */
export function tradeListSha256(trades) {
  return sha256Rows(trades.map((t) => [t.entryTime, t.side, t.eQ, t.sQ, t.tQ]));
}

const pct = (x) => (x === null ? 'n/a' : `${fmtRate(x)}%`);

function renderStats(title, s, mode = 'sr') {
  const out = [];
  const w = s.wilson;
  out.push(`  ${title}`);
  out.push(`    closed trades: ${s.closed.n} (long ${s.closed.long}, short ${s.closed.short});`
    + ` open trades: ${s.open.n} (long ${s.open.long}, short ${s.open.short})`);
  out.push(`    win rate: ${pct(s.winRate)}  Wilson 95%: ${w ? `${pct(w.lower)} to ${pct(w.upper)}` : 'n/a'}`);
  out.push(`    Net $: ${fmtDollarsNq(s.netNq)}  Gross $: ${fmtDollarsNq(s.grossNq)}`
    + `  average R: ${fmtR(s.avgRHundredths)}  max drawdown $: ${fmtDollarsNq(s.maxDdNq)}`);
  out.push(`    stops on floor: ${s.stopsOnFloor}  stops on cap: ${s.stopsOnCap}`
    + `  targets under 1R: ${s.targetsUnder1R}  target at or behind entry: ${s.targetAtOrBehindEntry}`);
  out.push(`    target-hit rate: ${pct(s.targetHitRate)}  target exits with Net $ <= 0: ${s.targetExitsNonPositive}`
    + `  target touched, not filled: ${s.touchedNotFilled}  stop taken, target also reached: ${s.stopTakenTargetReached}`);
  out.push(`    trades whose rows d..k+1 span a gap or session break: ${s.gapTrades}`);
  out.push(`    stale 15m across a break: pass ${s.stale.break.pass}, fail ${s.stale.break.fail};`
    + ` stale 15m, no break: pass ${s.stale.no_break.pass}, fail ${s.stale.no_break.fail}`);
  const f = s.funnel;
  out.push(`    funnel: triggers ${f.triggers} = ignored while in a position ${f.ignored_position}`
    + ` + ignored (same-side window open) ${f.ignored_window} + cancelled ${f.cancelled}`
    + ` + expired ${f.expired} (with a 15m filter fail: ${s.expiredWithFilterFail})`
    + ` + filtered (15m filter fail) ${f.filtered}`
    + ` + insufficient data ${f.insufficient} + no target ${f.no_target}`
    + (mode === 'srsl' ? ` + no stop ${f.no_stop}` : '')
    + (['band', 'next', 'next15'].includes(mode) ? ` + outside band ${f.outside_band}` : '')
    + (['next', 'next15'].includes(mode) ? ` + under 1.5R ${f.under_rr}` : '')
    + ` + closed trades ${f.closed} + open (end of data) ${f.open}`);
  if (!f.reconciles) out.push(`    ERROR: funnel does not reconcile (buckets sum to ${f.sum}, triggers ${f.triggers})`);
  return out;
}

function renderTrade(t, index, lastCloseQ) {
  const head = `    #${index} ${t.side.padEnd(5)} trigger ${etLabel(t.triggerTime)}  entry ${etLabel(t.entryTime)}`
    + `  E ${fmtPriceQ(t.eQ)}  S ${fmtPriceQ(t.sQ)}  T ${fmtPriceQ(t.tQ)}  D ${fmtPriceQ(t.dQ)}`;
  const flags = [t.floor && 'floor', t.cap && 'cap', t.under1R && 'under 1R', t.behind && 'target at or behind entry', t.gap && 'gap']
    .filter(Boolean);
  const tail = flags.length ? `  [${flags.join(', ')}]` : '';
  if (t.open) {
    return `${head}  OPEN at end of data, last close ${fmtPriceQ(lastCloseQ)}, mark Net $ ${fmtDollarsNq(t.markNq)}${tail}`;
  }
  return `${head}  exit ${etLabel(t.exitTime)} ${t.reason} (case ${t.exitCase}) at ${fmtPriceQ(t.exitQ)}`
    + `  Net $ ${fmtDollarsNq(t.nq)}  R ${fmtR(rHundredths(t.nq, t.dQ))}${tail}`;
}

/** Render the full report text for a simulate() result. */
export function renderReport(result) {
  const { info, runs, lastCloseQ } = result;
  const out = [];
  out.push(`repaint ${info.repaint}`);
  out.push('Small, in-sample backtest: parameters were fixed before any results; all three runs are always reported.');
  out.push(`snapshot ${info.id} (sha256 ${info.sha256})`);
  out.push(`  1m rows ${info.count_1m}: ${etLabel(info.first_1m)} to ${etLabel(info.last_1m)}`);
  out.push(`  15m rows ${info.count_15m}: ${etLabel(info.first_15m)} to ${etLabel(info.last_15m)}`);
  out.push(`  F = 1m row ${info.F} at ${etLabel(info.fTime)}; ${info.rowsBeforeF} rows precede it`);
  out.push(`  MarketCipher_SR resolution ${info.srPeriodS / 60}m; target candidates: ${info.targetCandidates.long} long, `
    + `${info.targetCandidates.short} short`);
  if (info.targetMode === '1R') {
    out.push('  TARGET MODE 1R: every target is E plus or minus D (1:1); Cipher Resistance/Support is not used');
    out.push('  NOT RECORDED: this report does not change last shown; draw still uses the last SR report, and 1R trades cannot be drawn');
  }
  if (info.targetMode === 'srsl') {
    out.push('  TARGET MODE srsl: target is the nearest Cipher level (as sr); stop is 1 tick beyond the nearest confirmed opposite'
      + ' Cipher level 2 to 8 points from E, not clamped; no such level is "no stop"');
    out.push('  NOT RECORDED: this report does not change last shown; draw still uses the last SR report, and srsl trades cannot be drawn');
  }
  if (info.targetMode === 'band') {
    out.push('  TARGET MODE band: on the trigger row, a long targets Cipher Resistance and stops 1 tick below Cipher Support;'
      + ' a short targets Support and stops 1 tick above Resistance; not clamped; E not strictly between them is "outside band"');
    out.push('  NOT RECORDED: this report does not change last shown; draw still uses the last SR report, and band trades cannot be drawn');
  }
  if (info.targetMode === 'next' || info.targetMode === 'next15') {
    out.push(`  TARGET MODE ${info.targetMode}: stop as band (1 tick beyond the trigger row's Cipher Support for a long,`
      + ' Resistance for a short); target is the nearest past Cipher line (any Resistance or Support value plotted at or'
      + ` before the trigger row) beyond E${info.targetMode === 'next' ? '; a reward under 1.5R is skipped as "under 1.5R"'
        : ' that is at least 1.5R away; none is "under 1.5R"'}`);
    out.push('  15m Mny Flow is judged by Avg4: its 4-bar average of closed 15m values must rise for a long (fall for a short),'
      + ' and the latest closed 15m bar must move the same way (a counter or flat bar is filtered)');
    out.push(`  NOT RECORDED: this report does not change last shown; draw still uses the last SR report, and ${info.targetMode}`
      + ' trades cannot be drawn');
  }
  for (const w of info.warnings) out.push(`  WARNING: ${w}`);
  out.push(`  1m gaps (not the daily halt or weekend close): ${info.gaps1m.length}`);
  for (const g of info.gaps1m) out.push(`    ${etLabel(g.from)} -> ${etLabel(g.to)} (${g.seconds} s)`);
  out.push(`  15m gaps (not the daily halt or weekend close): ${info.gaps15m.length}`);
  for (const g of info.gaps15m) out.push(`    ${etLabel(g.from)} -> ${etLabel(g.to)} (${g.seconds} s)`);
  out.push(`  15m rows whose bucket has no 1m row (inside the 1m range): ${info.emptyBuckets15m.length}`
    + `; outside the 1m range: ${info.emptyBuckets15mOutside1mRange}`);
  if (info.emptyBuckets15m.length > 0) {
    out.push('  WARNING: the empty-bucket assumption is false for this feed');
    for (const S of info.emptyBuckets15m) out.push(`    ${etLabel(S)}`);
  }
  out.push('  non-finite values per plot used:');
  for (const [k, v] of Object.entries(info.nonFinite)) out.push(`    ${k}: ${v}`);

  for (const run of runs) {
    out.push('');
    const rules = ['next', 'next15'].includes(info.targetMode) ? RUN_RULES_TREND : RUN_RULES;
    out.push(`== ${run.runId}: ${rules[run.runId]} (shorts use Falling) ==`);
    out.push(`  snapshot ${info.id}, ${etLabel(info.first_1m)} to ${etLabel(info.last_1m)}, F ${etLabel(info.fTime)}`);
    out.push(...renderStats('whole run', run.whole, info.targetMode));
    out.push(...renderStats('first 70% (by trigger time)', run.first, info.targetMode));
    out.push(...renderStats('last 30% (by trigger time)', run.second, info.targetMode));
    out.push('  trades:');
    if (run.trades.length === 0) out.push('    none');
    run.trades.forEach((t, i) => out.push(renderTrade(t, i, lastCloseQ)));
  }
  return `${out.join('\n')}\n`;
}

/** Render the forward test (forwardSimulate result). Runs after the main report. */
export function renderForward(res) {
  const out = [];
  out.push('');
  out.push('== forward test (design line 106) ==');
  out.push(`  original snapshot ${res.original.id} (sha256 ${res.original.sha256})`
    + `, 1m ${etLabel(res.original.first1)} to ${etLabel(res.original.last1)}`
    + `, 15m ${etLabel(res.original.first15)} to ${etLabel(res.original.last15)}`);
  out.push(`  forward snapshot ${res.forward.id} (sha256 ${res.forward.sha256})`
    + `, first 1m row ${etLabel(res.forward.first1)}, first 15m row ${etLabel(res.forward.first15)}`
    + `, last 1m row ${etLabel(res.forward.last1)}, last 15m row ${etLabel(res.forward.last15)}`);
  out.push(`  closed 1m bars after the original last bar: ${res.forward.newBars1m}`);
  out.push(`repaint ${res.repaint}`);
  out.push(`  last close ${fmtPriceQ(res.lastCloseQ)}`);
  for (const run of res.runs) {
    const c = run.comparison;
    out.push('');
    out.push(`== ${run.runId} forward: ${RUN_RULES[run.runId]} (shorts use Falling) ==`);
    out.push(`  triggers at or before the original last bar, excluded: ${run.excluded}`);
    out.push(`  check against the original: compared ${c.compared}, same ${c.same},`
      + ` insufficient in original ${c.insufficientInOriginal}, closed in forward ${c.nowClosed},`
      + ` differences ${c.differences.length}`);
    for (const d of c.differences) out.push(`    DIFFERENCE ${etLabel(d.time)} ${d.side}: ${d.why}`);
    out.push(...renderStats('triggers after the original last bar', run.stats));
    out.push('  trades after the original last bar:');
    if (run.trades.length === 0) out.push('    none');
    run.trades.forEach((t, i) => out.push(renderTrade(t, i, res.lastCloseQ)));
  }
  return `${out.join('\n')}\n`;
}

/** Parse argv (node, script, snapshot, optional --forward file, optional --target mode). Returns null on bad usage. */
function parseArgs(argv) {
  const args = argv.slice(2);
  const pos = [];
  let forward = null;
  let target = null;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--forward') {
      if (forward !== null || i + 1 >= args.length || args[i + 1].startsWith('--')) return null;
      forward = args[i + 1];
      i += 1;
    } else if (args[i] === '--target') {
      if (target !== null || i + 1 >= args.length || !TARGET_MODES.includes(args[i + 1])) return null;
      target = args[i + 1];
      i += 1;
    } else {
      pos.push(args[i]);
    }
  }
  if (pos.length !== 1) return null;
  if (target !== null && target !== 'sr' && forward !== null) return null;
  return { file: pos[0], forward, target: target ?? 'sr' };
}

const USAGE = 'usage: node scripts/mc_basic_1m/report.mjs <snapshot.json> [--forward <forward_snapshot.json>]'
  + ' [--target sr|1R|srsl|band|next|next15] (only --target sr can be combined with --forward)\n';

/** Writes "last shown" under the trade-log lock, creating the empty log first when none exists. */
function writeLastShown(result) {
  takeLogLock();
  try {
    let read = readLog();
    if (read.state === 'corrupt') {
      throw Object.assign(new Error('trade_log.json does not parse; last shown not written'), { code: 'E_LOG_CORRUPT' });
    }
    if (read.state === 'missing') {
      createEmptyLog();
      read = readLog();
    }
    const runs = {};
    for (const run of result.runs) runs[run.runId] = tradeListSha256(run.trades);
    read.log.last_shown = { snapshot_sha256: result.info.sha256, runs };
    writeLog(read.log);
  } finally {
    releaseLogLock();
  }
}

/**
 * Run the report. io.stdout and io.stderr receive the text. Returns the exit code.
 * The lock is taken only after the report and forward text are built, so a failed run writes nothing.
 */
export function main(argv, io = {
  stdout: (s) => process.stdout.write(s),
  stderr: (s) => process.stderr.write(s),
}) {
  const args = parseArgs(argv);
  if (!args) {
    io.stderr(USAGE);
    return 2;
  }
  let text;
  try {
    const snap = readSnapshot(args.file);
    const result = simulate(snap, { target: args.target });
    text = renderReport(result);
    if (args.forward !== null) {
      const fwd = forwardSimulate(snap, readSnapshot(args.forward));
      text += renderForward(fwd);
    }
    // draw.mjs re-simulates SR targets only, so a 1R list must not become the approved one.
    if (args.target === 'sr') writeLastShown(result);
  } catch (err) {
    io.stderr(`${err.code ? `${err.code}: ` : ''}${err.message}\n`);
    return 1;
  }
  io.stdout(text);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main(process.argv);
