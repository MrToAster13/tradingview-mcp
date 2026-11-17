/**
 * Builds the TradingView MCP server with every tool registered.
 * Shared by stdio mode (src/server.js) and HTTP mode (src/http.js), which
 * builds a fresh server per request.
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { registerHealthTools } from './tools/health.js';
import { registerChartTools } from './tools/chart.js';
import { registerPineTools } from './tools/pine.js';
import { registerDataTools } from './tools/data.js';
import { registerCaptureTools } from './tools/capture.js';
import { registerDrawingTools } from './tools/drawing.js';
import { registerAlertTools } from './tools/alerts.js';
import { registerBatchTools } from './tools/batch.js';
import { registerReplayTools } from './tools/replay.js';
import { registerIndicatorTools } from './tools/indicators.js';
import { registerWatchlistTools } from './tools/watchlist.js';
import { registerUiTools } from './tools/ui.js';
import { registerPaneTools } from './tools/pane.js';
import { registerTabTools } from './tools/tab.js';

/**
 * The only tools HTTP mode registers (ELI-849). HTTP mode can be public
 * through Tailscale Funnel, and whether a live broker is connected in
 * TradingView Desktop is unverified, so HTTP mode serves reads and drawing
 * only. Each value starts with "read:" or "draw:" and names what the tool
 * touches, plus any panel it opens to get there. tests/http_tools.test.js
 * checks the prefixes, that draw tools come from src/tools/drawing.js, and
 * that no read tool has a write verb in its name.
 */
export const HTTP_ALLOWED_TOOLS = Object.freeze({
  tv_health_check: 'read: CDP connection and chart symbol. Asks GitHub for the latest commit',
  tv_discover: 'read: names of TradingView API methods',
  tv_ui_state: 'read: open panels and visible button labels',
  chart_get_state: 'read: symbol, timeframe, chart type and studies',
  chart_get_visible_range: 'read: visible date and bar range',
  symbol_info: 'read: metadata of the chart symbol',
  symbol_search: 'read: TradingView public symbol search',
  quote_get: 'read: last bar of a symbol. With a symbol argument it switches the chart and switches it back',
  depth_get: 'read: Depth of Market panel rows',
  data_get_ohlcv: 'read: price bars',
  data_get_indicator: 'read: inputs of one study',
  data_get_study_values: 'read: data window values of visible studies',
  data_get_pine_lines: 'read: line.new levels of visible Pine studies',
  data_get_pine_labels: 'read: label.new text of visible Pine studies',
  data_get_pine_tables: 'read: table.new rows of visible Pine studies',
  data_get_pine_boxes: 'read: box.new zones of visible Pine studies',
  data_get_strategy_results: 'read: Strategy Tester metrics. Opens that panel and unhides a hidden strategy so the report computes',
  data_get_trades: 'read: Strategy Tester orders. Opens that panel and unhides a hidden strategy so the report computes',
  data_get_equity: 'read: Strategy Tester equity. Opens that panel and unhides a hidden strategy so the report computes',
  pine_get_source: 'read: Pine Editor source. Opens the editor',
  pine_get_errors: 'read: Pine Editor error markers. Opens the editor',
  pine_get_console: 'read: Pine console lines. Opens the editor',
  pine_list_scripts: 'read: names of saved Pine scripts',
  pine_analyze: 'read: offline static analysis of the source passed in',
  pine_check: 'read: compiles the source passed in on TradingView\'s server as a guest. Saves nothing',
  alert_list: 'read: alerts',
  watchlist_get: 'read: watchlist rows. Opens the watchlist panel',
  indicator_search: 'read: Indicators dialog results. Opens and closes the dialog',
  replay_status: 'read: replay state, position and P&L',
  layout_list: 'read: names of saved layouts',
  pane_list: 'read: panes and their symbols',
  tab_list: 'read: open chart tabs',
  draw_shape: 'draw: adds one shape',
  draw_list: 'draw: lists drawings',
  draw_get_properties: 'draw: reads one drawing',
  draw_remove_one: 'draw: removes one drawing by id',
  draw_trades_from_csv: 'draw: draws positions from the paper-trading CSV export in ~/Downloads, then restores the symbol and timeframe',
});

/**
 * Every other registered tool, with the reason it stays off HTTP. A tool in
 * neither list fails tests/http_tools.test.js, so a tool from an upstream
 * merge gets a decision before it ships. HTTP mode leaves out anything not
 * in HTTP_ALLOWED_TOOLS whether or not it is listed here.
 */
export const STDIO_ONLY_TOOLS = Object.freeze({
  tv_launch: 'starts, and can kill, TradingView on the host',
  tv_update: 'fetches code and runs npm ci on the host',
  ui_evaluate: 'runs any JavaScript in the logged-in TradingView page',
  ui_click: 'clicks any element, including order buttons in the trading panel',
  ui_open_panel: 'opens any panel, including the trading panel',
  ui_mouse_click: 'clicks at any x,y in the window',
  ui_keyboard: 'presses any key in the window',
  ui_type_text: 'types into the focused element',
  ui_hover: 'drives the mouse',
  ui_scroll: 'drives the mouse wheel',
  ui_fullscreen: 'toggles fullscreen',
  ui_find_element: 'helper for the click tools. Its CSS mode reads text from any element in the logged-in page',
  chart_set_symbol: 'changes the chart symbol',
  chart_set_timeframe: 'changes the chart timeframe',
  chart_set_type: 'changes the chart type',
  chart_set_visible_range: 'moves the chart view',
  chart_scroll_to_date: 'moves the chart view',
  chart_manage_indicator: 'adds or removes studies',
  indicator_add: 'adds a study',
  indicator_set_inputs: 'changes study inputs',
  indicator_toggle_visibility: 'shows or hides a study',
  batch_run: 'switches the chart symbol and timeframe and does not switch back',
  capture_screenshot: 'returns only a path on the host, and method "api" asks TradingView for its own snapshot, which the Charting Library docs say it uploads',
  pine_set_source: 'overwrites the Pine Editor source',
  pine_save: 'saves the script to TradingView\'s cloud',
  pine_compile: 'adds the script to the chart, can click "Save and add to chart", and presses Ctrl+Enter when no button matches',
  pine_smart_compile: 'adds the script to the chart, can click "Save and add to chart", and presses Ctrl+Enter when no button matches',
  pine_new: 'replaces the Pine Editor contents',
  pine_open: 'replaces the Pine Editor contents',
  draw_clear: 'removes every drawing on the chart in one call, including ones drawn by hand. draw_remove_one stays allowed and removes one drawing per call',
  alert_create: 'creates an alert',
  alert_copy: 'creates an alert',
  alert_delete: 'deletes alerts',
  watchlist_add: 'edits the watchlist',
  watchlist_add_bulk: 'edits the watchlist',
  watchlist_remove: 'edits the watchlist',
  replay_start: 'changes replay state',
  replay_step: 'changes replay state',
  replay_autoplay: 'changes replay state',
  replay_stop: 'changes replay state',
  replay_trade: 'places replay trades',
  layout_switch: 'switches the layout',
  layout_new: 'creates a layout',
  pane_set_layout: 'changes the pane grid',
  pane_focus: 'changes the active pane',
  pane_set_symbol: 'changes a pane symbol',
  tab_new: 'opens a tab',
  tab_close: 'closes the current tab',
  tab_switch: 'switches tabs',
});

/**
 * Removes every registered tool whose name is not in `allowed`. It runs after
 * registration, so it covers server.tool(), server.registerTool() and any
 * other path that stores tools in the SDK registry, which is the map that
 * tools/list and tools/call read. It throws rather than serve an unfiltered
 * list when that registry is missing or no allowed tool is left.
 */
export function applyHttpAllowList(server, allowed = HTTP_ALLOWED_TOOLS) {
  const registry = server?._registeredTools;
  if (!registry || typeof registry !== 'object' || registry instanceof Map) {
    throw new Error('MCP SDK tool registry not found; HTTP mode will not start with an unfiltered tool list');
  }
  for (const name of Object.keys(registry)) {
    if (!Object.hasOwn(allowed, name)) delete registry[name];
  }
  const left = Object.keys(registry);
  if (!left.length || left.some((n) => !Object.hasOwn(allowed, n))) {
    throw new Error('HTTP tool filter left no allowed tool registered; HTTP mode will not start');
  }
  return server;
}

const HTTP_INSTRUCTIONS = `

HTTP MODE: this server registers only the tools that read the chart or draw on it. A tool named above that is missing from tools/list is stdio-only and cannot be called over HTTP.`;

/**
 * @param {{ http?: boolean }} [opts] http: true registers only HTTP_ALLOWED_TOOLS.
 */
export function createServer({ http = false } = {}) {
  const server = new McpServer(
    {
      name: 'tradingview',
      version: '2.0.0',
      description: 'AI-assisted TradingView chart analysis and Pine Script development via Chrome DevTools Protocol',
    },
    {
      instructions: `TradingView MCP — 86 tools for reading and controlling a live TradingView Desktop chart.

TOOL SELECTION GUIDE — use this to pick the right tool:

Reading your chart:
- chart_get_state → get symbol, timeframe, all indicator names + entity IDs (call first)
- data_get_study_values → get current numeric values from ALL visible indicators (RSI, MACD, BB, EMA, etc.)
- quote_get → get real-time price snapshot (last, OHLC, volume)
- data_get_ohlcv → get price bars. ALWAYS pass summary=true unless you need individual bars

Reading custom Pine indicator output (line.new/label.new/table.new/box.new drawings):
- data_get_pine_lines → horizontal price levels from custom indicators (deduplicated, sorted)
- data_get_pine_labels → text annotations with prices ("PDH 24550", "Bias Long", etc.)
- data_get_pine_tables → table data as formatted rows (session stats, analytics dashboards)
- data_get_pine_boxes → price zones as {high, low} pairs
- ALWAYS pass study_filter to target a specific indicator by name (e.g., study_filter="Profiler")
- Indicators must be VISIBLE on chart for these to work

Changing the chart:
- chart_set_symbol, chart_set_timeframe, chart_set_type → change ticker/resolution/style
- chart_manage_indicator → add/remove studies. USE FULL NAMES: "Relative Strength Index" not "RSI"
- chart_scroll_to_date → jump to a date (ISO format)
- indicator_set_inputs → change indicator settings (length, source, etc.)

Pine Script development:
- pine_set_source → inject code, pine_smart_compile → compile + check errors
- pine_get_errors → read errors, pine_get_console → read log output
- WARNING: pine_get_source can return 200KB+ for complex scripts — avoid unless editing

Screenshots: capture_screenshot → regions: "full", "chart", "strategy_tester"
Replay: replay_start → replay_step → replay_trade → replay_status → replay_stop
Batch: batch_run → run action across multiple symbols/timeframes
Drawing: draw_shape → horizontal_line, trend_line, rectangle, text
Alerts: alert_create, alert_list, alert_copy, alert_delete
Launch: tv_launch → auto-detect and start TradingView with CDP on any platform
Panes: pane_list, pane_set_layout (s, 2h, 2v, 4, 6, 8), pane_focus, pane_set_symbol
Tabs: tab_list, tab_new, tab_close, tab_switch

CONTEXT MANAGEMENT:
- ALWAYS use summary=true on data_get_ohlcv
- ALWAYS use study_filter on pine tools when you know which indicator you want
- NEVER use verbose=true unless user specifically asks for raw data
- Prefer capture_screenshot for visual context over pulling large datasets
- Call chart_get_state ONCE at start, reuse entity IDs` + (http ? HTTP_INSTRUCTIONS : ''),
    }
  );

  // Register all tool groups
  registerHealthTools(server);
  registerChartTools(server);
  registerPineTools(server);
  registerDataTools(server);
  registerCaptureTools(server);
  registerDrawingTools(server);
  registerAlertTools(server);
  registerBatchTools(server);
  registerReplayTools(server);
  registerIndicatorTools(server);
  registerWatchlistTools(server);
  registerUiTools(server);
  registerPaneTools(server);
  registerTabTools(server);

  // HTTP mode keeps only HTTP_ALLOWED_TOOLS, so a tool that is not listed
  // there is neither listed nor callable, however it was registered.
  if (http) applyHttpAllowList(server);

  return server;
}
