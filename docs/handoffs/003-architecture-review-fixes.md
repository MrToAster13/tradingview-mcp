# 003. Architecture review fixes (tv-1, tv-3)

Date: 2026-10-21. Branch: `refactor/arch-review-tv`, based on fork `main` at 0d5511b.

## What landed on the branch

| Commit | What |
|---|---|
| d80ebf7 | `tests/sanitization.test.js` builds its paths with `fileURLToPath`, so it no longer reads `C:\C:\...` on Windows. Before this, `npm run test:unit` exited 1. |
| 4da20bd | tv-1. Paper-trade drawing moved from `src/core/drawing.js` to `src/core/paper_trades.js`, behind the chart positions adapter in `src/core/chart_positions.js`. `src/core/drawing.js` matches upstream again. Tests use `tests/helpers/memory_chart_positions.js`. ADR 0001. |
| cb2077c | tv-3. Bring-up moved into `src/core/tv_process.js` (`isTvRunning`, `probeCdp`, `ensureTradingView`). health.js and tv_up.js share the fail-closed process check. ADR 0002. |
| 1ba0fdd | Audit fix. A CDP answer of HTTP 200 with an empty body counts as up again, as it did in tv_up. |

Domain terms for both are in `CONTEXT.md`.

## Test counts (`npm run test:unit`)

- After d80ebf7: 329 pass, 0 fail.
- After 4da20bd: 339 pass, 0 fail.
- After cb2077c: 355 pass, 0 fail. That is 14 new tests in `tests/tv_process.test.js` and 2 that `tests/sanitization.test.js` generates for each `src/core` file.
- After 1ba0fdd: 356 pass, 0 fail.

`npm test`, `test:all` and `test:e2e` were not run. They wipe the live chart.

## Behaviour changes

- tv_up step 2 now refuses when tasklist or pgrep cannot run. Before, it treated a failed check as "not running" and launched.
- Nothing else is meant to change. health.js keeps its upstream `_probeCdp` for `launch()`.

## Not done

- tv-2 (mc_basic_1m chart session wiring) is on a local backtest branch in its own worktree. That work stays off the public fork, so this branch does not carry it.
- `scripts/launch_tv_debug.bat` still runs `taskkill /F`. That line is upstream code and Elijah runs the script by hand. The follow-up is in ADR 0002.

## Next

1. Opus audit of the branch, then fix rounds until it is clean.
2. Push to `fork`, open the PR against fork `main`, merge.
3. Remove this branch's worktree. Delete its `node_modules` junction first.
