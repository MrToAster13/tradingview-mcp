# Desktop watchdog

`scripts/watchdog/desk_watch.js` keeps TradingView with CDP and the combo tester running on the Windows desktop. Hermes runs it every 5 minutes as the no-agent cron job `desk-watch`. The cron script `%LOCALAPPDATA%\hermes\scripts\desk_watch.py` is a thin wrapper that runs it with node. The Hermes gateway starts at sign-in from the Startup folder (`Hermes_Gateway.vbs`). Nothing runs before you sign in.

## What each run does

- **TradingView.** When CDP on 127.0.0.1:9222 does not answer, it runs `scripts/tv_up.js --no-http`. That launches TradingView only when none is running, so it never kills one. It needs no API key and starts no HTTP server or Funnel.
- **Combo tester.** When the pid in `combo-data/lock` is not a live process this account owns, it removes the lock and starts the tester again, detached. Output is appended to `combo-data/run.log`. If the new process is gone 5 seconds later, the check reports `failed`.
- **Stale tester.** The tester is stale when its last successful cycle is over 35 minutes old. A successful cycle is the newer of the log's last `stored` line and the time `store.json` was last written. Skip and failure lines don't count. That catches a frozen chart, the wrong tab or timeframe, a history change and a corrupt store.
- **Device.** It alerts when C: has under 10 GB free or memory is over 90% used.
- **Heartbeat.** Every run writes `date +%s` to `~/.desk_watch_heartbeat` on the Mac mini. The Mac's `sysadmin` cron job `desk-heartbeat-check` alerts when the heartbeat is over 15 minutes old: the gateway is down, or the PC is asleep, off or signed out.

## Remote sessions

The watchdog no longer manages the MCP HTTP server or the Tailscale Funnel (ELI-848). The HTTP server exits after `TV_MCP_IDLE_MINUTES` (default 15) with no authenticated request and turns the :8443 Funnel off (ELI-756). Before ELI-848 the watchdog started both again within 5 minutes and sent a repair message each time.

To start a remote session, run this on the desktop in the repo, with `TV_MCP_API_KEY` set:

```
node scripts/tv_up.js
```

It prints the public URL. The session ends on its own after the idle time. An HTTP server or Funnel that is down does not trigger an alert.

## Alerts

Messages go to Telegram through the Mac mini's root `hermes send`, only when a check changes state or a repair runs. A healthy desktop stays silent. If the relay fails, the changed state is not saved, so the next run sends the message again. The state is in `%LOCALAPPDATA%\hermes\scripts\desk_watch.state.json`, written atomically. A corrupt state file counts as empty.

## Settings

Environment variables, all optional: `DESK_WATCH_TESTER_REPO` (where `scripts/combo/run.js` runs), `DESK_WATCH_TESTER_OUT` (the tester's `--out`, default `combo-data`), `DESK_WATCH_TESTER_CONFIG` (default `scripts/combo/signals.example.json`), `DESK_WATCH_MCP_REPO` (where `tv_up.js --no-http` runs), `DESK_WATCH_STALE_MIN`, `DESK_WATCH_DISK_MIN_GB`, `DESK_WATCH_MEM_MAX_PCT`, `DESK_WATCH_STATE`, and `DESK_WATCH_RELAY=0` to skip Telegram and the heartbeat. The wrapper sets the tester repo and output folder.

## Limits

- It cannot help while the PC is asleep, off or signed out. The Mac heartbeat check reports that.
- Alerts depend on the Mac mini and SSH. When they fail, the message stays in the Hermes cron log and is sent again on the next run.
- It does not check or start the MCP HTTP server, Tailscale or the Funnel. See "Remote sessions".
- Don't run the tester from an elevated (admin) terminal. The watchdog can't see an elevated process and would start a second tester.
- To stop the tester by hand, pause the watchdog first with `hermes cron pause desk-watch`, or the next run starts the tester again. Resume it with `hermes cron resume desk-watch`.
- The restart uses the configured tester config. Change `DESK_WATCH_TESTER_CONFIG` in the wrapper when you switch signal lists.
