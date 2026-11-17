# 0003. One home per TradingView and trading concern

Date: 2026-10-28. Status: accepted. Decided by Claude Code under ELI-693; Elijah reviews it and may reverse any line. Amended 2026-11-16 under ELI-806 (alert capture moved to diet-bloomberg-terminal) and ELI-850 (TradingView's official MCP server, the combo tester exception and the fork file rule).

## Context

Seven repos held TradingView and trading work: tradingview-mcp, wavetrend-replay, claude-tradingview-mcp-trading, tradingview-backtesting-ai, tradingview-alert-capture, trade-journal and diet-bloomberg-terminal. Market Cipher logic existed in three places: wavetrend-replay, the `backtest/mc-*` branches of this repo, and the `market-cipher-replay` branch of claude-tradingview-mcp-trading. A fix in one did not reach the others. Setup docs pointed at three MCP servers: upstream tradesdontlie/tradingview-mcp, the `@tradingview/mcp-server` npm package and a tutorial repo. None of them was this fork. An agent asked to work on backtesting or alerts had to guess which repo was current.

This ADR lives here because every other TradingView repo depends on this MCP server.

## Decision

| Concern | Home | Vault project |
| --- | --- | --- |
| TradingView MCP server for the desktop chart: chart reads, drawing, Pine and replay over CDP | MrToAster13/tradingview-mcp (this repo) | TradingView Backtesting AI |
| TradingView cloud data: the alert log, news, calendar and fundamentals | TradingView's official MCP server, `https://mcp.tradingview.com/mcp`, with OAuth. diet-bloomberg-terminal reads it. | none, TradingView runs it |
| Market Cipher math, replay and backtesting | wavetrend-replay | TradingView Backtesting AI |
| Live capture of TradingView alert fires | diet-bloomberg-terminal, the `tv_alerts` collector. Spec in that repo at `docs/alert-capture-spec.md` | Trading |
| Trade journal: broker fills to the Google Sheet | trade-journal | Trading |
| Market data terminal | diet-bloomberg-terminal | Trading |
| Retired | claude-tradingview-mcp-trading, to be archived under ELI-777 | none |
| Retired | tradingview-backtesting-ai, archived 2026-10-29 under ELI-685 | none |
| Retired | tradingview-alert-capture, retired 2026-11-16 under ELI-806 and to be archived. Its spec moved to diet-bloomberg-terminal. | none |

Rules that follow from the table:

- Project rule. A repo whose input is TradingView (charts, indicators, alerts) belongs to TradingView Backtesting AI. A repo whose input is a broker or a market data feed with no TradingView in the path belongs to Trading.
- Exception to the project rule: live alert capture lives in diet-bloomberg-terminal, which belongs to Trading, because the collector already runs there (ELI-806). Tickets that change the terminal go to Trading. Alert research that changes no terminal code stays in TradingView Backtesting AI.
- Two TradingView MCP servers, each with its own job. This fork drives the desktop chart over CDP: chart reads, drawing, Pine and replay. TradingView's official MCP server answers cloud reads: the alert log, news, calendar and fundamentals. A new need goes to whichever of the two already does that job, and no repo builds a third path.
- This repo stays an MCP server. Strategy and backtest code does not merge into `main` here, with one named exception. The `backtest/mc-*` code moved to wavetrend-replay under ELI-778, and ELI-694 deleted those branches.
- Exception to the no-backtest rule: the combo tester in `scripts/combo` (PR #7, `docs/combo-tester.md`) stays in this repo. `scripts/combo/engine.js` simulates trades with costs and a train and test split, so it is backtest code. It stays because `scripts/combo` is a new folder and adds no upstream merge conflicts, which was the reason for moving the backtester out. Moving it would also make the dependency between the two repos run both ways, because wavetrend-replay already loads this repo's `src/core/chart.js` and `src/core/replay.js` through `TRADINGVIEW_MCP_DIR`. The desk watchdog starts the tester from this repo (`scripts/watchdog/desk_watch.js`). wavetrend-replay's README points at `scripts/combo` so an agent looking for backtesting finds it.
- Fork file rule. Fork-only code goes in new files or folders, such as `scripts/combo`, `scripts/watchdog`, `src/http.js` and `src/funnel.js`. Files that came from upstream tradesdontlie/tradingview-mcp, including `src/tools`, `src/core` and `src/cli`, change only to fix a bug or to wire in a fork feature. Refactors of upstream code go upstream as pull requests, not into this fork. This keeps upstream merges cheap.
- Market Cipher math lives only in wavetrend-replay `src/cipher.js`. Code elsewhere that needs it imports it from there, or copies it with a comment that names the source commit.
- Any setup doc that installs an MCP server for the desktop chart names MrToAster13/tradingview-mcp. A doc that needs the alert log, news, calendar or fundamentals names TradingView's official MCP server.

## Alternatives

### Keep the backtester in this repo

The strongest case: the 1m backtester on `backtest/mc-basic-1m` drives the live chart over CDP, the same code path this server uses. Moving it means wavetrend-replay either depends on this repo or carries its own CDP client. The branch is 43 files and about 15,000 lines, so the move is real work.

Rejected because this repo is a public fork that merges upstream, and 15,000 lines of strategy code would make every upstream merge harder. wavetrend-replay already holds the cipher, engine, portfolio and their tests. The move has a cost: wavetrend-replay is also public, so the private home path, chart layout id, backtest reports and strategy notes on those branches must come out before the code lands there (ELI-694, ELI-778).

### Move the combo tester to wavetrend-replay

Considered under ELI-850, after the combo tester merged into `main`.

The strongest case: the no-backtest rule above is plain, and ELI-778 just paid to follow it. An agent told that backtesting lives in wavetrend-replay will not find the combo tester. `scripts/combo/engine.js` also overlaps wavetrend-replay `src/portfolio.js` on fees, equity and drawdown.

Rejected for the reasons in the exception above: no upstream merge cost, a dependency that would run both ways, and a watchdog setting to change on the host that runs the tester. The wavetrend-replay README pointer fixes discovery at much lower cost than a move.

### Put alert capture under Trading, or inside trade-journal

Rejected on 2026-10-28, then reversed on 2026-11-16 under ELI-806. Live capture now lives in diet-bloomberg-terminal's `tv_alerts` collector, which belongs to Trading.

The first rejection said that alert capture measures which indicator signals pay off, which is the backtesting question asked with live data, and that its input is TradingView. It kept tradingview-alert-capture as a standalone repo because the repo would hold a mail credential that a pure replay tool should not. Both points rested on that repo's premise that TradingView has no alert history, so email and webhook were the only ways to get fires out.

The premise was wrong. diet-bloomberg-terminal already reads TradingView's alert log through the official MCP server every 60 seconds and stores each fire once by TradingView's own fire id (ELI-585). tradingview-alert-capture had a spec and no code. With the alert log as the source there is no mail credential, so the reason for a standalone repo went away. The spec moved to diet-bloomberg-terminal `docs/alert-capture-spec.md`, a private repo.

The strongest case for keeping a standalone capture repo under TradingView Backtesting AI:

- It follows the project rule above. The terminal is in Trading.
- Email has no loss window, because mail waits in the inbox while a host sleeps. The collector asks the alert log for the last 2 days, so a terminal that is off for longer loses fires. How long the log keeps fires past that window is unverified.
- The terminal is a large app. Research data inside it shares that app's uptime and release cycle.
- The terminal's table keeps parsed columns and strips the message, which breaks the spec's rule that the raw record is stored exactly as received.

Why the reversal holds: the collector exists and has stored real fires, and an email poller would be a second, weaker copy of it that needs a new secret. Two follow-up tickets in the Trading project take the strongest points: one appends every alert log event, unmodified, to an append-only file, and one flags a silent canary alert so an outage is visible. An email backfill can be added later if outages longer than the lookback window happen. The project rule bends for this one concern, as the exception in the rules says.

### Keep claude-tradingview-mcp-trading as the live-order bot home

The strongest case: commit 09dbf13 on its `market-cipher-replay` branch split the bot into modules (`config`, `exchange`, `indicators`, `intervals`, `ledger`, `market-data`, `strategy`) that wavetrend-replay does not have. Archiving freezes the only live-order code.

Rejected because the repo is a copy of a third-party tutorial with no license, so new work on it carries a licensing risk. The cipher, engine, chart, strategies and webhook modules on that branch match wavetrend-replay byte for byte. Archiving is reversible and keeps every branch readable. ELI-777 checks whether the bot modules are wanted before the archive.

## Consequences

- Follow-up tickets in the vault: ELI-777 archives claude-tradingview-mcp-trading after checking its `market-cipher-replay` branch, and ELI-778 moves the `backtest/mc-*` code into wavetrend-replay with the private data removed.
- The repo-to-project map owned by the COO Hermes profile should list the table above (ELI-692).
- tradingview-alert-capture's AGENTS.md opens with a retired note that points at diet-bloomberg-terminal `docs/alert-capture-spec.md`.
- wavetrend-replay's README points at `scripts/combo` in this repo (ELI-850).
