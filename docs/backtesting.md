# Backtesting strategies on the live TradingView chart

Reference for any agent that backtests a strategy through this repo. It covers the live-chart safety rules, how to get more history than the chart shows, how to simulate without fooling yourself, and how to report. The working example is `scripts/mc_b_dot/`, the MC B dot strategy on 1-minute futures. Copy its layout for a new strategy.

## Safety rules for the live chart

Elijah trades on the same TradingView Desktop that port 9222 exposes. Anything you break there, you break in his trading session.

- Run `npm run test:unit` only. `npm test`, `npm run test:all` and `tests/e2e.test.js` delete every drawing, switch the symbol to AAPL and overwrite the Pine editor. Pass this rule into every subagent prompt.
- Keep every drawing. His `long_position` and `short_position` drawings are the ground truth for his rules (see "Ground truth" below). Use `draw_remove_one` on a shape you drew yourself, by its id, and never `draw_clear`.
- Place replay trades only. Never place a live order.
- Let one agent drive the chart at a time. Symbol changes, replay and history loads are global to the window, so two drivers corrupt each other's reads. Pure-file work (simulation, grids, reviews) runs in parallel freely.
- Close TradingView gracefully (`(Get-Process TradingView).CloseMainWindow()` in PowerShell), never with a force kill. Start it with `node scripts/tv_up.js` only when no TradingView process exists. Leave `scripts\launch_tv_debug.bat` alone.
- When you finish, put the chart back as you found it: symbol, timeframe, replay stopped, strategy inputs and source links. For the MC work that is `CME_MINI:MES1!` on 1m.

## Getting the data

The official TradingView MCP (`mcp-tradingview`) returns OHLCV but no indicator plot values, so any strategy built on an indicator needs the CDP path.

### Reading the chart over CDP

`scripts/mc_b_dot/read.mjs` is the reader to reuse. The objects it touches:

- Chart: `window.TradingViewApi._activeChartWidgetWV.value()`
- Main series bars: `chart._chartWidget.model().mainSeries().bars()`, rows `[t, o, h, l, c, v]` from `firstIndex()` to `lastIndex()`
- A study: find it in `model.model().dataSources()` by `metaInfo().description`, then read `study.data()` the same way. Index 0 of each row is the bar time. The other indexes are the study's plots in order.
- Contract spec: `mainSeries().symbolInfo()` gives `minmov`, `pricescale` and `pointvalue`. Tick size is `minmov / pricescale`.
- Strategy fills: `study.ordersData()` on the strategy's data source, for the parity check below.

Use full chart symbols. These are verified: `CME_MINI:MES1!`, `CME_MINI:MNQ1!`, `CBOT_MINI:MYM1!`, `CME_MINI:M2K1!`, `CME_MINI:RTY1!`, `COMEX_MINI:MGC1!`, `NYMEX:MCL1!`. The chart reports `chart.symbol()` in that form, so a short name like `MES1!` fails a symbol check.

### Loading more history

- `mainSeries().requestMoreData(5000)` loads older bars. Scrolling the chart back does not. Call it until the bar count stops growing (`loadHistory` in `collect.mjs`).
- On 1m the chart stops at about 15,000 bars, roughly two weeks. That is one window.
- To go further back, start bar replay at a date before the window's first bar and load history again. Each replay window gives another ~15,000 bars. `collect.mjs` walks back window by window:

  ```
  node scripts/mc_b_dot/collect.mjs <outDir> --symbol CME_MINI:MES1! --max 30 --overlap 400
  ```

  It stops early when a new window's first bar does not move back, which means replay has run out of history.
- Measured on 2026-10-26: one window takes about 17 seconds, and 1m replay stops at 2026-04-19 on MES and MNQ, 14 windows or about 187,000 bars per symbol. A symbol takes about 4 minutes, so the limit on data is history depth, not collection time. To get more trades, add instruments.
- Use one chart tab. In TV Desktop 3.4.1, `tab.js` `newTab` opens a tab but cannot find its landing page as a CDP target, because no target with the title "New tab" appears. Whether a hidden tab keeps computing studies is unverified. A second tab would only make collection faster, and collection is already fast.
- After every symbol change, replay jump or history load, wait for the studies to recalculate before reading. The check in `isSettled` is the one to copy: three polls with the same study `lastIndex`, the study's last row within two bars of the main series' last bar, and every study's first row time equal to the main series' first bar time. Skip the last part and you read a study that has not yet covered the bars you just loaded.
- Stop replay in a `finally` block so a failed read never leaves the chart in replay.
- Keep collected data out of the repo. Write it under `%TEMP%\mcbdata\<name>` or a similar temp folder.

### Stitching replay windows

Each window restarts its indicators, so its first few hundred bars are warm-up and disagree with the older window's values for the same bars. `grid.mjs` handles this, and a new strategy should reuse it rather than rewrite it:

- A window owns the bars from its `fromT` (first bar plus the warm-up, default 300 bars) up to the next newer window's `fromT`.
- Collect with `--overlap` at least the warm-up. Otherwise some bars exist only inside a window's warm-up, and `grid.mjs` refuses the data.
- State that compares a bar with the previous bar (for example "a new level was plotted") must compare with the previous bar of the same window. `stitch` stores that row as `ownPrev`.

## Building the strategy

### Pine side

- Invite-only indicators cannot be called from Pine. Read their plots with `input.source()` and have the user link them once in Settings > Inputs. Show a warning table while the sources sit on their default `close`.
- Futures need `margin_long = 0, margin_short = 0`. The v6 default of 100% margin rejects every MES entry on a $10k account.
- Fees: `commission_type = strategy.commission.cash_per_contract, commission_value = 0.5`, which is $1 per round trip. Use the same $1 in any offline simulation.
- Gate entries on `barstate.isconfirmed` so a signal is a closed-bar signal. The order then fills at the next bar's open.
- Compare prices in whole ticks (`math.round(p / syminfo.mintick)`) so Pine and the offline simulator agree on exact touches.
- Compile with `pine_set_source` then `pine_smart_compile`, and read `pine_get_errors`.

### Offline simulator

Pine's strategy tester only covers the bars loaded on the chart, so parameter grids run offline over the collected windows (`sweep.mjs` is the model). Match TradingView's broker emulator:

- Entry at the open of the bar after the signal.
- Inside a bar, if the open is nearer the high the path is open, high, low, close. Otherwise it is open, low, high, close. A bar that opens past the stop or target fills at its open. What TradingView does when the open sits exactly at the midpoint is unverified.
- Stops and targets fixed at the signal and checked from the fill bar onward.

Before trusting the simulator, run the parity check. Put the Pine strategy on the chart with the same inputs, read its fills from `ordersData()`, and compare trade by trade with the simulator on the same bars. Investigate every mismatch.

## Optimising without overfitting

- Split each instrument by time, not at random: train on the older part (`--train 0.6`) and test on the newer part. Pick the winner on train only and report its test result next to it.
- Set a minimum trade count (`--min-trades 30`). A profit factor on 10 trades is noise.
- Always report a reference row: the user's own stated rule, run on every instrument whether or not it wins. On the first MES trial, the grid's best had a train profit factor of 1.98 over 31 trades and a test profit factor of 0.98 over 22. The reference rule had 0.90 on train and 1.07 on test. A grid winner that falls apart on test is the normal result, so show both.
- Pick per instrument. Tick size and point value change what a fixed tick offset means, so expect different winners per contract.
- Report trade counts, win rate, profit factor, net dollars after fees and max drawdown for train and test. Thousands of trades across instruments is the target, and replay windows are how you reach it.

Usage of the MC grid, as a template:

```
node scripts/mc_b_dot/grid.mjs <dataDir> <outJson> [--warmup 300] [--train 0.6] [--min-trades 30] [--fee 1]
```

## Ground truth

Elijah's written rule and his intended rule differ. His drawings show the intended one. On the MES 1m layout he draws each intended trade as a `long_position` or `short_position` shape, often from his phone.

- Read them with `getAllShapes()` and `getShapeById()`. `stopLevel` and `profitLevel` are in ticks from the entry.
- Score any rule against them before you call it his rule. Report how many drawn trades the rule catches. For example, his text said money flow "25 either side", but "with the trade at 23" caught 14 of 15 drawn trades and his text's version caught 10.
- Drawing times are in the chart's time zone, America/Chicago. Match a drawing to a bar with `timeZone: 'America/Chicago'`, not the machine's local zone. On 2026-10-26 a match in Los Angeles time put every drawing 2 hours off. Check that the matched bar's open equals the drawn entry within a tick.

### Drawing simulated trades for him to review

To let him correct a rule by hand, for example moving each target to where it should be, draw the simulated trades as position shapes and read them back afterwards.

- Create each one with `createMultipointShape([{ time: entry, price }, { time: end, price }], { shape: 'long_position' or 'short_position', overrides: { stopLevel, profitLevel } })`, levels in ticks. Then read the shape back with `getShapeById(id).getPoints()` and `getProperties()` and remove it if the time, price or ticks differ.
- A shape whose time is before the first loaded bar snaps both points to that bar. The live 1m chart holds about 15,000 bars, so anything older than about two weeks needs a replay window. Start replay after the trade's exit, load history with `requestMoreData`, draw, then stop replay. Shapes drawn in replay keep their exact time after replay stops. He then needs bar replay to see those trades on 1m.
- Skip trades within 30 minutes of one of his own position drawings, and save every created id to a file. Read his edits back by id, and remove only those ids when cleaning up.
- The 2026-10-26 run drew 100 MC B dot v2 trades this way. Handoff 003 has the details and the read-back steps.

## Process

- Every code change goes through the `tdd-loop` skill: baseline suite, failing tests first, at most 10 logged iterations, an Opus adversarial review, a red regression test for each confirmed finding, then the security stage.
- Reviews report functional defects only: wrong numbers, crashes, wrong refusals. Each finding needs a reproduced scenario.
- Report the full suite's pass and fail counts after every code change, and name `tests/e2e.test.js` as excluded.
- Backtest branches such as `backtest/mc-basic-1m` stay local. Commit the scripts and tests. Leave collected data, reports and scratch files uncommitted.
- Label anything you could not verify as unverified in the report. Known open ones for the MC work are the emulator midpoint tie and the MarketCipher_SR pivot offset.
