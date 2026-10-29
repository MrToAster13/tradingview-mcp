# 0003. One home per TradingView and trading concern

Date: 2026-10-28. Status: accepted. Decided by Claude Code under ELI-693; Elijah reviews it and may reverse any line.

## Context

Seven repos held TradingView and trading work: tradingview-mcp, wavetrend-replay, claude-tradingview-mcp-trading, tradingview-backtesting-ai, tradingview-alert-capture, trade-journal and diet-bloomberg-terminal. Market Cipher logic existed in three places: wavetrend-replay, the `backtest/mc-*` branches of this repo, and the `market-cipher-replay` branch of claude-tradingview-mcp-trading. A fix in one did not reach the others. Setup docs pointed at three MCP servers: upstream tradesdontlie/tradingview-mcp, the `@tradingview/mcp-server` npm package and a tutorial repo. None of them was this fork. An agent asked to work on backtesting or alerts had to guess which repo was current.

This ADR lives here because every other TradingView repo depends on this MCP server.

## Decision

| Concern | Home | Vault project |
| --- | --- | --- |
| TradingView MCP server | MrToAster13/tradingview-mcp (this repo) | TradingView Backtesting AI |
| Market Cipher math, replay and backtesting | wavetrend-replay | TradingView Backtesting AI |
| Live capture of TradingView alert fires | tradingview-alert-capture | TradingView Backtesting AI |
| Trade journal: broker fills to the Google Sheet | trade-journal | Trading |
| Market data terminal | diet-bloomberg-terminal | Trading |
| Retired | claude-tradingview-mcp-trading, to be archived under ELI-777 | none |
| Retired | tradingview-backtesting-ai, archived 2026-10-29 under ELI-685 | none |

Rules that follow from the table:

- Project rule. A repo whose input is TradingView (charts, indicators, alerts) belongs to TradingView Backtesting AI. A repo whose input is a broker or a market data feed with no TradingView in the path belongs to Trading.
- This repo stays an MCP server. Strategy and backtest code does not merge into `main` here. The `backtest/mc-*` branches move to wavetrend-replay.
- Market Cipher math lives only in wavetrend-replay `src/cipher.js`. Code elsewhere that needs it imports it from there, or copies it with a comment that names the source commit.
- Any setup doc that installs a TradingView MCP server names MrToAster13/tradingview-mcp.

## Alternatives

### Keep the backtester in this repo

The strongest case: the 1m backtester on `backtest/mc-basic-1m` drives the live chart over CDP, the same code path this server uses. Moving it means wavetrend-replay either depends on this repo or carries its own CDP client. The branch is 43 files and about 15,000 lines, so the move is real work.

Rejected because this repo is a public fork that merges upstream, and 15,000 lines of strategy code would make every upstream merge harder. wavetrend-replay already holds the cipher, engine, portfolio and their tests. The move has a cost: wavetrend-replay is also public, so the private home path, chart layout id, backtest reports and strategy notes on those branches must come out before the code lands there (ELI-694, ELI-778).

### Put alert capture under Trading, or inside trade-journal

The strongest case: the audit's guessed map put tradingview-alert-capture under Trading, next to trade-journal, and both record real outcomes rather than replayed ones.

Rejected because alert capture measures which indicator signals pay off, which is the backtesting question asked with live data, and its input is TradingView. Its own AGENTS.md decision 13 already keeps it a standalone repo apart from wavetrend-replay, because it holds mail credentials that a pure replay tool should not.

### Keep claude-tradingview-mcp-trading as the live-order bot home

The strongest case: commit 09dbf13 on its `market-cipher-replay` branch split the bot into modules (`config`, `exchange`, `indicators`, `intervals`, `ledger`, `market-data`, `strategy`) that wavetrend-replay does not have. Archiving freezes the only live-order code.

Rejected because the repo is a copy of a third-party tutorial with no license, so new work on it carries a licensing risk. The cipher, engine, chart, strategies and webhook modules on that branch match wavetrend-replay byte for byte. Archiving is reversible and keeps every branch readable. ELI-777 checks whether the bot modules are wanted before the archive.

## Consequences

- Follow-up tickets in the vault: ELI-777 archives claude-tradingview-mcp-trading after checking its `market-cipher-replay` branch, and ELI-778 moves the `backtest/mc-*` code into wavetrend-replay with the private data removed.
- The repo-to-project map owned by the COO Hermes profile should list the table above (ELI-692).
- tradingview-alert-capture's AGENTS.md records its home and project.
