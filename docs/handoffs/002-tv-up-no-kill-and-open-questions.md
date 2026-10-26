# Handoff 002: tv_up no-kill fix and audit follow-ups, five open questions

Status: blocked (all code work that doesn't need Elijah has landed; the open questions wait on Elijah)

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
- PR https://github.com/MrToAster13/tradingview-mcp/pull/2 merged into the fork's main as ef7318d and linked to the thread. It fixes the PR #1 audit follow-ups. I picked the fixes myself under the audit and fix rule, and each one makes the code refuse more.
  - `src/tools/_params.js` has a strict `bool` schema that replaced all 8 `z.coerce.boolean()` params. Coercion turned "false" into true, so `delete_all: "false"` deleted every alert.
  - When `kill_existing` is false, the `src/core/health.js` MSIX fallback kills only the child it spawned, by PID. It refuses when the PID is unknown.
  - `src/core/trades.js` skips a stop or target that isn't positive. It also skips every entry on a symbol whose order history has an unreadable Filled quantity.
  - `npm run test:unit` passed 291 of 291 tests. `tests/bool_params.test.js` was added to `test:unit` and `test:all`.
  - The Opus audit of the branch was clean. The worktree `../tvmcp-fix` is removed.
- Branch `fix/wrong-side-bracket` (off fork/main ef7318d) fixes the `planPosition` follow-up. `buildFills` now skips an entry as 'bracket on wrong side of fill' unless a long has stop < fill < target or a short has target < fill < stop. Before, `planPosition` took distances with `Math.abs`, so a wrong-side stop was drawn as a mirrored bracket and a stop at the fill got 0 ticks. `npm run test:unit` passes 293 of 293 tests and exits 1 only because of the sanitization `C:\C:\` bug.

## Next (in order)
1. Wait on the open questions below. PR https://github.com/MrToAster13/tradingview-mcp/pull/3 merged as 0d5511b, and worktree `../tvmcp-fix2` is removed.
2. When `fwd_run.sh` runs again, note that `fwd_eval.mjs` also imports `sweep.mjs` from the same temp folder, and that `fwd_snap.mjs` opens and deletes hidden sessions in the live tab 1 page, so it needs Elijah's yes (question 4).

## Open questions for Elijah
1. package-lock.json drift with no package.json change: (a) discard or (b) commit.
2. Answered 2026-10-26: (a). `docs/handoffs/001-tradingview-mcp-persistence.md` stays local, is listed in `.git/info/exclude`, and now describes the Funnel design.
3. Funnel: (a) keep it on and put `/health` behind the key, (b) keep it on as is, or (c) go tailnet-only, which breaks Hermes until Hermes moves to the tailnet.
4. Forward check-ins: (a) switch the chart to MES1! 15m (or allow me to), run now, and schedule twice a day with T3 `schedule_task`, (b) run once, or (c) drop the forward test.
5. backtest/mc-basic-1m: (a) keep it local, (b) move the home path and layout id into env vars, regenerate the reports at the $1 fee, re-audit and push, or (c) push it to a private repo.

## Key decisions
- Never push backtest/mc-basic-1m to the public fork as it stands, because commit 6aa97f4 says "do not push". `scripts/mc_basic_1m/store.mjs:11` has a home path, and `cdp.mjs:14-15`, `templates.mjs:21` and `lint.test.mjs` have the layout id.
- Don't touch the live chart without Elijah's yes (question 4).
- Never commit `docs/handoffs/001`, because the fork is public and that doc has the IP and SSH details.
- The logon script `tv-proxy/start-tv-mcp.ps1` runs `scripts/tv_up.js` from whatever branch is checked out. On `backtest/mc-basic-1m`, which lacks the no-kill fix, it force-kills a TradingView that is open without CDP at sign-in. Handoff 001 has the details and the fix options.
- Push only to the `fork` remote (MrToAster13). `origin` is upstream.

## Relevant files
- `scripts/tv_up.js` holds the bring-up steps: key, CDP 9222, HTTP 127.0.0.1:8765, Funnel :8443.
- `src/core/health.js` has `launch()` and the MSIX fallback kill guard.
- `src/core/trades.js` and `src/core/drawing.js` hold the trade bracket linking and the drawing dedupe.
- `src/tools/_params.js` holds the strict `bool` schema that replaced `z.coerce.boolean()`.
- The forward check-in is `%TEMP%\mc_fee1\an\fwd_run.sh`. It runs `fwd_snap.mjs` and then `fwd_eval.mjs` from that folder, and none of the three is in git. `fwd_snap.mjs` looks for a chart page showing `CME_MINI:MES1!|15`, opens hidden 1m and 15m sessions in it, and reads `%TEMP%\mc_tab2\run_h1.js`. `fwd_eval.mjs` also reads `%TEMP%\mc_tab2\snapshot_2026-10-16_sr5.json`. These live in a temp folder, so a cleanup can delete them. The repo's own versions, `scripts/mc_basic_1m/snapshot.mjs --forward` and `forward.mjs`, are only on backtest/mc-basic-1m.
- `%TEMP%\mc_fwd\snap_20261020_2026.txt` is the failed rerun log.

## Gotchas
- Never run `npm test`, `test:all` or `test:e2e` while TradingView is open, because they wipe the live chart. Use `npm run test:unit`.
- Never run `scripts\launch_tv_debug.bat` and never kill TradingView.
- Follow-ups not fixed yet. Each needs Elijah or the live app to verify, so I left them:
  - Level ID is blank in every row of both real exports in Downloads (69 and 100 order-history rows, 2 open orders, from 10-14 and 10-15). So `buildFills` never links same-second entries by Level ID on real data, and it skips them instead. The code refuses rather than guesses, so no fix is needed. Pairing same-second brackets would need another signal, such as matching prices.
  - The PID kill closes Elijah's window if Electron's single-instance lock handed it to our process. Testing it means killing TradingView.
  - The launch_tv_debug scripts kill by name with no check. Elijah runs them by hand, so changing them changes his bring-up.
- The committed HTML reports on backtest/mc-basic-1m still show the old $3 fee.
- `e.txt` and `o.txt` in the repo root are scratch files and stay uncommitted.
