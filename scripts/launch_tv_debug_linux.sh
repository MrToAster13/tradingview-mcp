#!/bin/bash
# Launch TradingView Desktop on Linux with Chrome DevTools Protocol enabled.
# Usage: ./scripts/launch_tv_debug_linux.sh [port]
#
# A thin wrapper over `node scripts/tv_up.js --no-http` (ELI-853), which holds
# the one bring-up rule in src/core/tv_process.js: if TradingView answers CDP
# on the port, do nothing; if it runs without CDP, stop and kill nothing;
# launch it only when none runs. The install lookup is launch() in
# src/core/health.js.

PORT="${1:-9222}"
TV_CDP_PORT="$PORT" exec node "$(dirname "$0")/tv_up.js" --no-http
