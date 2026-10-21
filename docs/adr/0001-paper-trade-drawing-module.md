# 0001. Paper-trade drawing lives in its own module behind a chart positions adapter

Date: 2026-10-21. Status: accepted.

## Context

`drawTradesFromCsv` was added to the upstream file `src/core/drawing.js`, which made that file 336 lines against upstream's 113. Every upstream change to drawing.js then had to merge around user-owned code. The function also built page JavaScript inline, so its tests had to regex-match `evaluate()` strings to fake the chart.

## Decision

- `src/core/paper_trades.js` owns paper-trade drawing. `src/core/drawing.js` is byte-for-byte upstream again.
- The module reaches the chart only through a chart positions adapter with these methods: getState, setSymbol, setTimeframe, getView, setView, setVisibleRange, tickSize, listPositions, createPosition, getAnchor and removePosition.
- `src/core/chart_positions.js` has the CDP adapter. It alone builds page JavaScript, and it JSON-encodes or `requireFinite`-checks every interpolated value.
- `tests/helpers/memory_chart_positions.js` is the in-memory adapter. `tests/trade_drawings.test.js` tests the module through it. `tests/chart_positions.test.js` tests the CDP adapter's expressions with a fake `evaluate`.
- `_deps` for the module is `{ dir, readFile, chart }`.

## Consequences

- Upstream merges into drawing.js no longer conflict with this feature.
- Tests of the drawing rules (dedupe, fallback sizing, placement check, restore) no longer depend on expression text.
- A change to the page JavaScript has to keep the adapter contract. The CDP adapter tests cover encoding, not TradingView's behaviour. That still needs a manual run against a chart.
