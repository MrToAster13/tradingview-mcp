# 0002. TradingView bring-up lives in one module

Date: 2026-10-21. Status: accepted.

## Context

Two copies of "is TradingView running" existed. `scripts/tv_up.js` had an async one that returned false when tasklist or pgrep failed, so a failed check let it go on to launch. `src/core/health.js` had a sync one that returned true on failure. `tv_up.js` also held the whole "CDP up, else refuse, else launch" decision inline, so it could only be tested through the full five-step script.

## Decision

- `src/core/tv_process.js` owns bring-up. It exports `isTvRunning({ execSync, platform })`, `probeCdp(port, host)` and `ensureTradingView({ port, _deps })`.
- `isTvRunning` is the fail-closed version from health.js. `launch()` in health.js and `tv_up.js` both use it. tv_up therefore now refuses, rather than launches, when the process check itself fails.
- `probeCdp` is tv_up's probe: `/json/version`, 2 second timeout. It resolves the body on HTTP 200, even an empty one, and null otherwise, so any 200 counts as up as it did in tv_up. health.js keeps its upstream `_probeCdp` (any status) for `_waitForCdp`, so the upstream launch path is unchanged.
- `ensureTradingView` returns `{ state: 'up' }` or `{ state: 'launched', ready, warning }`, and throws the "running without CDP" refusal or "launch failed: ...". It loads `launch` from health.js with a dynamic import, because health.js imports tv_process.js.
- `tv_up.js` step 2 calls `ensureTradingView` and only maps the result to log lines.

## Consequences

- One process check. A fix to it reaches both callers.
- `tests/tv_process.test.js` tests the bring-up rules directly. `tests/tv_up.test.js` injects `probeCdp` instead of faking `/json/version` through `httpRequest`.
- Not changed: `scripts/launch_tv_debug.bat` still runs `taskkill /F /IM TradingView.exe`. That line is upstream and the script is run by hand. Follow-up: make the .bat check first and refuse like `ensureTradingView`, or stop documenting it as the bring-up path.
