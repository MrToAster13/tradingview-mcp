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
