# Context

Domain terms for the user-owned parts of this fork. Upstream tool names are in CLAUDE.md.

## Paper-trade drawing

- **Paper-trading export.** The CSV files TradingView writes to ~/Downloads from the paper trading panel: order history, balance history and, when present, positions. One export shares an export id, `YYYY-MM-DDTHH_MM_SS` in UTC.
- **Fill.** One filled entry order joined to its bracket (stop and target) and its exit. `buildFills` in `src/core/trades.js` turns an export into fills.
- **Position plan.** What one fill becomes on the chart: long or short shape, entry and end time, entry price, stop and profit distance in ticks, money risk and account size. `planPosition` builds it.
- **Position drawing.** A TradingView `long_position` or `short_position` shape. Its entry anchor is the first point: the bar time and the entry price.
- **Chart positions adapter.** The interface `src/core/paper_trades.js` uses to reach the chart. It speaks in symbols, timeframes, views and position drawings. `createCdpChartPositions()` in `src/core/chart_positions.js` drives the live chart over CDP. `tests/helpers/memory_chart_positions.js` is the in-memory version for tests. See ADR 0001.
- **Already drawn.** A position drawing with the same shape, entry bar and entry price exists. The module skips the fill.
- **Placement mismatch.** The chart put the entry anchor on a different bar or price than the plan. The module removes that drawing and reports the skip.
- **Fallback sizing.** The drawing got only stop and profit levels because money risk or account size was unknown, or the chart refused the full overrides.

## TradingView bring-up

- **Bring-up.** Getting a local TradingView to answer CDP on a port without killing one the user started. `ensureTradingView()` in `src/core/tv_process.js` decides: CDP answers, so it is up; a TradingView process runs without CDP, so it refuses; no process runs, so it calls `launch({ kill_existing: false })` from `src/core/health.js`. `scripts/tv_up.js` step 2 calls it. See ADR 0002.
- **Running without CDP (refusal).** A TradingView process is running but `/json/version` on the CDP port gave no HTTP 200 for about 10 seconds (5 retries, 2 seconds apart). Bring-up throws and leaves the process alone. The user closes TradingView or restarts it with `--remote-debugging-port`.
- **Fail-closed process check.** `isTvRunning()` counts a check that cannot run (tasklist error, pgrep exit other than 1) as running, so code that must not kill a user's TradingView refuses instead.
