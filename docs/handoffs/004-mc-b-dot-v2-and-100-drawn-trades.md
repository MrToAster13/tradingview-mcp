# Handoff 004: MC B dot v2, the R:R study, and 100 v2 trades drawn for Elijah to set targets

Status: waiting on Elijah. He is moving the targets on the 100 drawn trades by hand. The next session reads them back.

## Goal
Elijah wanted a v2 of the MC B dot 1m strategy that matches the default settings, as a new file with the original left alone. After that he asked about the R:R spread, why there are no higher R:R trades, and what his own long and short drawings show. He concluded he has to hand pick the target. He asked for 100 v2 trades drawn on the chart, apart from his own drawings, so he can drag each target to where it should be.

## Done
- `scripts/mc_b_dot/mc_b_dot_strategy_v2.pine` is a copy of `mc_b_dot_strategy.pine`. Only the header comment and the `strategy("MC B Dot Strategy v2 (1m)", ...)` title differ. The original is untouched. v2 is not on the chart yet and has no parity check.
- I backtested v2 offline on the stitched MES 1m windows. The parameters are `mfMode 'with'`, `mfLevel 23`, `waveLimit 45`, `tp 'r3'`, `sl 'swing20'`, `stopTicks 1`, a $1 round-trip fee and a 300-bar warm-up.
  - First 50 trades: 34% wins, +$415 net, PF 1.63.
  - All 438 trades from Apr 19 to Oct 26: 26% wins, -$664 net, PF 0.91, max drawdown $2,002.
  - The report with entry and exit images is `screenshots/mc_b_dot_v2/report.html`. It is gitignored.
- R:R spread at the fill: min 2.33, 25th percentile 3.00, median 3.00, 75th percentile 3.24, max 4.14.
- The fixed-target sweep put 3R first over all trades. 2R, 4R, 5R, 6R and 8R all lost more.
- Drawing study. Chart time is America/Chicago. The first pass used the machine's Los Angeles time and was 2 hours off. In Elijah's 19 drawings:
  - The stop sits on a 2 to 9 bar swing, often on the first SR level behind the entry.
  - Where the target lands on a level, it is the 1st free SR level 6 times, the 2nd 4 times and the 3rd once.
  - The high R:R trades come from a tight stop with the next free level far away.
  - Held to their own stops and targets with the emulator fill rule, the 19 drawings go 7 targets and 12 stops, about -$55 after fees.
- Level-target sweep on MES, swing3, swing5, swing10, swing20 and free1 stops against r3, free1, free2, freeR2, freeR3 and freeR4 targets. No combination beats swing20 with r3 over all trades or on the train split. Level targets raise the median R:R to 5 or 6 and drop the win rate to 13 to 17%.
- I drew 100 v2 trades on CME_MINI:MES1! 1m as `long_position` and `short_position` shapes.
  - They are the most recent 100 closed v2 trades, Sep 2 09:58 to Oct 26 13:23 Chicago time, with none overlapping Elijah's drawings: 56 longs and 44 shorts.
  - Each starts at v2's entry, stop and 3R target. The box ends at v2's exit bar, or 5 minutes after entry, whichever is later.
  - v2's own outcome on them is 31 targets, 69 stops, +$255 net.
  - After drawing, all 100 were re-read with the exact entry time, price and ticks. Elijah's 20 drawings are untouched. He added a long at 10/26 17:05 during the session.
  - The chart was left on CME_MINI:MES1! 1m with replay stopped.

## Next (in order)
1. When Elijah says he has moved the targets, read the 100 shapes back by id from `screenshots/mc_b_dot_v2/work/drawn100.json`. Compare each `profitLevel` with the planned `profit_ticks` in the same file. Use `state.mjs` as the reader. A shape missing from the chart means he deleted it, which probably means "skip this trade".
2. For each moved target, measure where it sits: in R, against the free MC SR levels at the signal bar (`levelsAfter` in `sweep.mjs`, as `draw2.mjs` does), and against the session and time of day. Look for the rule behind his picks, then backtest that rule as a new target mode. Any change to `sweep.mjs` goes through tdd-loop.
3. Put v2 on the chart as its own new script and run the parity check from `docs/backtesting.md`. Restore the chart to MES1! 1m afterward.
4. To remove the 100 drawings later, remove only the ids in `drawn100.json` with `removeEntity`. Never use `draw_clear`.

## Key decisions
- v2 is a new file. Never overwrite `mc_b_dot_strategy.pine` or any earlier version. Elijah said so twice.
- The drawn targets start at 3R, so an unmoved target means 3R is fine, or that he skipped it. Ask him which once he is done.
- Only one agent drives the chart at a time. Another session's collector, a loop over CBOT, CME, COMEX and NYMEX symbols logging to `%TEMP%\mcbdata\collect_extra.log`, ran during this session. I waited until no `collect.mjs` process had run for 60 s before drawing.

## Relevant files
- `screenshots/mc_b_dot_v2/work/` is gitignored and holds copies of the scratch scripts and data from `%TEMP%\v2`. Run them from that folder:
  - `drawn100.json` lists the 100 drawn trades: shape `id`, `side`, `entry_time`, `exit_time`, `entry_price`, `stop_ticks`, `profit_ticks`, v2 `reason` and `net`.
  - `drawwin.mjs` is the drawer: `probe` tests one trade, `go` draws the rest and skips ids already in `drawn100.json`.
  - `plan.mjs` builds `plan_all.json` from the MES data in `%TEMP%\mcbdata\full`.
  - `state.mjs` reads the symbol, replay state and every position shape. `cdp.mjs` is the CDP connection both use.
  - `draw2.mjs` and `drawrows.json` hold the study of Elijah's drawings. `sw.mjs` is the stop and target sweep. `run.mjs`, `run_r.mjs` and `html.mjs` built the v2 report.
- `%TEMP%\mcbdata\full` holds the collected replay windows the scripts read. It is outside the repo and a temp cleanup can delete it. Rebuild it with `scripts/mc_b_dot/collect.mjs`.

## Gotchas
- A position drawn at a time before the first loaded bar snaps both points to that bar. The live 1m chart loads only about 15,000 bars, back to Oct 11 today. To draw older trades exactly, start bar replay after the trade's exit, load history with `requestMoreData`, draw, then stop replay. The shapes keep their exact time after replay stops. `drawwin.mjs` does this in three replay windows.
- 84 of the 100 trades are older than Oct 11, so Elijah has to use bar replay to see them on 1m. Whether they show on 5m, which loads further back, is unverified.
- Drawing times are Chicago time. Use `timeZone: 'America/Chicago'` when matching a drawing to a bar.
- Simulator-to-Pine parity at the v2 settings, the emulator's midpoint tie and the MarketCipher_SR pivot offset are all unverified.
- Run `npm run test:unit` only. The other suites wipe the live chart.
