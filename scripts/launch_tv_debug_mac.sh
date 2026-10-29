#!/bin/bash
# Launch TradingView Desktop on macOS with Chrome DevTools Protocol enabled
# Usage: ./scripts/launch_tv_debug_mac.sh [port]
#
# If TradingView already answers CDP on the port, this prints its version and
# exits. If TradingView runs without CDP, it stops and kills nothing, unless
# KILL_EXISTING=1 is set. Prefer `node scripts/tv_up.js`, which never kills.

PORT="${1:-9222}"

# PIDs of running TradingView processes, matched on the exact process name.
# A full command line match would also find the MCP server, whose path holds
# "tradingview-mcp".
tv_pids() {
  pgrep -x TradingView
}

# 127.0.0.1, not localhost: localhost can resolve to IPv6 ::1, where
# Electron's debug server does not listen.
if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
  echo "TradingView already answers CDP at http://127.0.0.1:$PORT. Nothing to do."
  exit 0
fi

# Auto-detect TradingView install location
APP=""
LOCATIONS=(
  "/Applications/TradingView.app/Contents/MacOS/TradingView"
  "$HOME/Applications/TradingView.app/Contents/MacOS/TradingView"
)

for loc in "${LOCATIONS[@]}"; do
  if [ -f "$loc" ]; then
    APP="$loc"
    break
  fi
done

# Fallback: search with mdfind (Spotlight)
if [ -z "$APP" ]; then
  APP=$(mdfind "kMDItemCFBundleIdentifier == 'com.niceincontact.TradingView'" 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

# Fallback: find any TradingView.app
if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  APP=$(find /Applications "$HOME/Applications" -name "TradingView.app" -maxdepth 2 2>/dev/null | head -1)
  if [ -n "$APP" ]; then
    APP="$APP/Contents/MacOS/TradingView"
  fi
fi

if [ -z "$APP" ] || [ ! -f "$APP" ]; then
  echo "Error: TradingView not found."
  echo "Checked: /Applications/TradingView.app, ~/Applications/TradingView.app"
  echo ""
  echo "If installed elsewhere, run manually:"
  echo "  /path/to/TradingView.app/Contents/MacOS/TradingView --remote-debugging-port=$PORT"
  exit 1
fi

if [ -n "$(tv_pids)" ]; then
  if [ "${KILL_EXISTING:-0}" != "1" ]; then
    echo "Error: TradingView is running without CDP on port $PORT. Not killing it."
    echo "Close TradingView yourself and re-run, or re-run with KILL_EXISTING=1 to kill it."
    exit 1
  fi
  echo "KILL_EXISTING=1: killing the running TradingView."
  tv_pids | xargs kill 2>/dev/null
  sleep 1
fi

echo "Found TradingView at: $APP"
echo "Launching with --remote-debugging-port=$PORT ..."
# Claude Code / T3 Code set ELECTRON_RUN_AS_NODE=1; inherited, it makes Electron
# run as plain Node and reject --remote-debugging-port ("bad option").
unset ELECTRON_RUN_AS_NODE
"$APP" --remote-debugging-port=$PORT &
TV_PID=$!
echo "PID: $TV_PID"

# Wait for CDP to be ready
echo "Waiting for CDP..."
for i in $(seq 1 15); do
  if curl -s "http://127.0.0.1:$PORT/json/version" > /dev/null 2>&1; then
    echo "CDP ready at http://127.0.0.1:$PORT"
    curl -s "http://127.0.0.1:$PORT/json/version" | python3 -m json.tool 2>/dev/null || curl -s "http://127.0.0.1:$PORT/json/version"
    exit 0
  fi
  sleep 1
done

echo "Warning: CDP not responding after 15s. TradingView may still be loading."
echo "Check manually: curl http://127.0.0.1:$PORT/json/version"
