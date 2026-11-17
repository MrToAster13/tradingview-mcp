@echo off
REM Launch TradingView Desktop on Windows with Chrome DevTools Protocol enabled.
REM Usage: scripts\launch_tv_debug.bat [port]
REM
REM A thin wrapper over "node scripts\tv_up.js --no-http" (ELI-853), which holds
REM the one bring-up rule in src\core\tv_process.js: if TradingView answers CDP
REM on the port, do nothing; if it runs without CDP, stop and kill nothing;
REM launch it only when none runs. The install lookup, MSIX included, is
REM launch() in src\core\health.js.
setlocal
set "PORT=%~1"
if "%PORT%"=="" set "PORT=9222"
set "TV_CDP_PORT=%PORT%"
node "%~dp0tv_up.js" --no-http
exit /b %errorlevel%
