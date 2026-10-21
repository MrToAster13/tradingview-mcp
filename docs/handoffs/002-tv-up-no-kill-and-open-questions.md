# Handoff 002: tv_up no-kill fix and audit follow-ups, five open questions

Status: blocked (the follow-up fixes in bcaec23 passed audit; the push and PR are next; the open questions wait on Elijah)

## Goal
Elijah asked to work every ticket and task that could be done without him, using subagents, and to commit the uncommitted work. The pieces were Caddy after reboot, whether Tailscale Funnel is on, why the 10-19 and 10-20 forward check-ins produced nothing, and landing the feat/draw-trades-from-csv work. Elijah lifted the one-subagent cap on resume, so normal CLAUDE.md subagent use applies.

## Done
- PR https://github.com/MrToAster13/tradingview-mcp/pull/1 merged into the fork's main as 8ee5660 and linked to the thread. The fix commit d19ed29 is on feat/draw-trades-from-csv. It contains:
  - `scripts/tv_up.js` no longer kills TradingView. If TradingView is running without CDP, it retries 5 times 2 s apart and then refuses. It launches only when no TradingView process exists.
  - `src/core/health.js` gets a new `isTvRunning` dep. The MSIX fallback throws instead of killing when `kill_existing` is false and TradingView was already running.
  - `src/core/trades.js` links same-second entries only by a unique shared Level ID and skips blank or zero fills.
  - `src/core/drawing.js` stops drawing the same trade twice in one run.
- The Opus audit and the Opus re-audit were both clean, and the secrets grep was empty. `npm run test:unit` passes 273 of 273 tests but exits 1 because of the existing `tests/sanitization.test.js` `C:\C:\` path bug on main.
- Caddy needs no fix. The current design retired it, and Tailscale serves :8443.
- Funnel is on. `/mcp` returns 401 without the key. `/health` returns 200 "ok" with no auth.
- The check-ins never ran because they were in-session timers in a session that ended. A manual rerun failed with "tab 1 (CME_MINI:MES1! 15m) not found" because the layout reopened on CBOT:ZC1! 15m. I didn't change the live chart.

- The audit follow-ups are fixed on branch `fix/bool-params-and-kill-scope` (off fork/main 8ee5660) in commit bcaec23. I picked the fixes myself under the audit and fix rule, and each one makes the code refuse more.
  - `src/tools/_params.js` has a strict `bool` schema that replaced all 8 `z.coerce.boolean()` params. Coercion turned "false" into true, so `delete_all: "false"` deleted every alert.
  - When `kill_existing` is false, the `src/core/health.js` MSIX fallback kills only the child it spawned, by PID. It refuses when the PID is unknown.
  - `src/core/trades.js` skips a stop or target that isn't positive. It also skips every entry on a symbol whose order history has an unreadable Filled quantity.
  - `npm run test:unit` passes 291 of 291 tests and exits 1 only because of the known sanitization `C:\C:\` bug. `tests/bool_params.test.js` was added to `test:unit` and `test:all`.
  - The Opus audit of the branch was clean, apart from minor doc errors that are now fixed.

## Next (in order)
1. Push `fix/bool-params-and-kill-scope` to `fork`, open the PR, link it, merge, then remove worktree `../tvmcp-fix`. Its `node_modules` is a junction to the main checkout's copy, so delete it with `.Delete()` before `git worktree remove`.
2. Then wait on the open questions below.

## Open questions for Elijah
1. package-lock.json drift with no package.json change: (a) discard or (b) commit.
2. `docs/handoffs/001-tradingview-mcp-persistence.md`, which is stale and contains the tailnet IP and SSH details: (a) keep it local and update it to the Funnel design, (b) delete it, or (c) commit a redacted copy.
3. Funnel: (a) keep it on and put `/health` behind the key, (b) keep it on as is, or (c) go tailnet-only, which breaks Hermes until Hermes moves to the tailnet.
4. Forward check-ins: (a) switch the chart to MES1! 15m (or allow me to), run now, and schedule twice a day with T3 `schedule_task`, (b) run once, or (c) drop the forward test.
5. backtest/mc-basic-1m: (a) keep it local, (b) move the home path and layout id into env vars, regenerate the reports at the $1 fee, re-audit and push, or (c) push it to a private repo.

## Key decisions
- Never push backtest/mc-basic-1m to the public fork as it stands, because commit 6aa97f4 says "do not push". `scripts/mc_basic_1m/store.mjs:11` has a home path, and `cdp.mjs:14-15`, `templates.mjs:21` and `lint.test.mjs` have the layout id.
- Don't touch the live chart without Elijah's yes (question 4).
- Never commit `docs/handoffs/001`, because the fork is public and that doc has the IP and SSH details.
- Push only to the `fork` remote (MrToAster13). `origin` is upstream.

## Relevant files
- `scripts/tv_up.js` holds the bring-up steps: key, CDP 9222, HTTP 127.0.0.1:8765, Funnel :8443.
- `src/core/health.js` has `launch()` and the MSIX fallback kill guard.
- `src/core/trades.js` and `src/core/drawing.js` hold the trade bracket linking and the drawing dedupe.
- `src/tools/_params.js` holds the strict `bool` schema that replaced `z.coerce.boolean()` (fixed in bcaec23).
- `scripts/mc_basic_1m/fwd_run.sh`, `fwd_snap.mjs` and `fwd_eval.mjs` run the forward check-in. They need layout tab 1 on `CME_MINI:MES1!|15`.
- `%TEMP%\mc_fwd\snap_20261020_2026.txt` is the failed rerun log.

## Gotchas
- Never run `npm test`, `test:all` or `test:e2e` while TradingView is open, because they wipe the live chart. Use `npm run test:unit`.
- Never run `scripts\launch_tv_debug.bat` and never kill TradingView.
- bcaec23 fixed the boolean coercion, the name-based fallback kill, the zero stop or target, and the blank replay quantity.
- Follow-ups not fixed yet:
  - Nobody has verified that exports fill in Level ID.
  - `planPosition` in `src/core/trades.js` uses `Math.abs`, so a stop on the wrong side of entry, or equal to it, is drawn as a mirrored bracket or with 0 ticks. This predates bcaec23. The audit found it.
  - The PID kill closes Elijah's window if Electron's single-instance lock handed it to our process.
  - The launch_tv_debug scripts kill by name with no check.
- The committed HTML reports on backtest/mc-basic-1m still show the old $3 fee.
- `e.txt` and `o.txt` in the repo root are scratch files and stay uncommitted.
