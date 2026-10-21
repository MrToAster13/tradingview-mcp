/**
 * Paper-trade drawing: turns a TradingView paper-trading CSV export into
 * long/short position drawings. The export-to-fills rules live in trades.js.
 * The chart is reached only through a chart positions adapter
 * (chart_positions.js), so tests run against an in-memory chart.
 */
import { readFileSync } from 'node:fs';
import { requireFinite } from '../connection.js';
import { createCdpChartPositions } from './chart_positions.js';
import { findExport, parseCsv, netFromPositions, buildFills, planPosition, isDuplicate, unixToLocal } from './trades.js';

/**
 * Draw a TradingView long/short position for each filled entry in a
 * paper-trading CSV export (newest in ~/Downloads unless export_timestamp is
 * given). Switches the chart to each traded symbol on 1 minute, skips entries
 * already drawn, verifies each drawing landed on the entry bar and price, and
 * restores the original symbol, timeframe and view.
 *
 * _deps: { dir, readFile, chart } where chart is a chart positions adapter.
 */
export async function drawTradesFromCsv({ export_timestamp, dry_run = false, _deps } = {}) {
  const readFile = _deps?.readFile || ((path) => readFileSync(path, 'utf8'));
  const exp = findExport({ dir: _deps?.dir, exportTimestamp: export_timestamp });
  const orders = parseCsv(readFile(exp.order_history_path));
  const balances = parseCsv(readFile(exp.balance_history_path));
  // The export id is the UTC time of the export.
  const exportTime = Date.parse(`${exp.export_timestamp.replace(/_/g, ':')}Z`) / 1000;
  // Without a readable positions export the replay starts flat, which is
  // wrong only when the order history was cut off mid-position.
  const netAtExport = exp.positions_path ? netFromPositions(parseCsv(readFile(exp.positions_path))) : null;
  const warnings = netAtExport ? [] : ['positions export missing or unreadable; exits assume the order history starts flat'];
  const { fills, skipped } = buildFills({ orders, balances, exportTime, netAtExport: netAtExport ?? undefined });

  if (dry_run) {
    // Tick counts need the symbol's tick size, which needs the chart; a dry
    // run reports prices. tick: 1 only feeds the fields kept here.
    const plans = fills.map((f) => {
      const p = planPosition(f, { tick: 1 });
      return {
        order_id: f.order_id, symbol: f.symbol, side: f.side, qty: f.qty,
        entry_price: f.entry_price, stop: f.stop, target: f.target,
        entry_time: unixToLocal(p.entry_time), end_time: unixToLocal(p.end_time),
        open_at_export: f.open_at_export, risk_amount: p.risk_amount, account_size: p.account_size,
      };
    });
    return { success: true, dry_run: true, export: exp.export_timestamp, fills: fills.length, plans, skipped, warnings };
  }

  const chart = _deps?.chart || createCdpChartPositions();
  const start = await chart.getState();
  const original = { symbol: start.symbol, timeframe: start.timeframe };
  const current = { ...original };
  const originalView = await chart.getView();
  let viewMoved = false;

  const bySymbol = new Map();
  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push(f);
  }

  // Returns { entity_id, fallback }. Throws if creation fails with minimal overrides.
  const drawPosition = async (plan) => {
    const levels = {
      stopLevel: requireFinite(plan.stop_ticks, 'stop_ticks'),
      profitLevel: requireFinite(plan.profit_ticks, 'profit_ticks'),
    };
    const full = { ...levels };
    if (plan.risk_amount != null) {
      full.riskDisplayMode = 'money';
      full.risk = requireFinite(plan.risk_amount, 'risk_amount');
    }
    if (plan.account_size != null) full.accountSize = requireFinite(plan.account_size, 'account_size');
    let fallback = plan.risk_amount == null || plan.account_size == null;

    const position = { shape: plan.shape, entry_time: plan.entry_time, end_time: plan.end_time, entry_price: plan.entry_price };
    let entity_id;
    try {
      entity_id = await chart.createPosition({ ...position, overrides: full });
    } catch (err) {
      if (Object.keys(full).length === Object.keys(levels).length) throw err;
      entity_id = await chart.createPosition({ ...position, overrides: levels });
      fallback = true;
    }
    return { entity_id, fallback };
  };

  const drawn = [];
  const drawSkipped = [];
  let fallbackSizing = false;
  let restoreError = null;

  try {
    for (const [symbol, symFills] of bySymbol) {
      if (current.symbol !== symbol) {
        current.symbol = symbol;
        await chart.setSymbol(symbol);
      }
      if (current.timeframe !== '1') {
        current.timeframe = '1';
        await chart.setTimeframe('1');
      }

      const si = await chart.tickSize();
      const tick = si ? si.minmov / si.pricescale : NaN;
      if (!(Number.isFinite(tick) && tick > 0)) {
        throw new Error(`Could not read tick size for ${symbol} (symbolInfo: ${JSON.stringify(si)})`);
      }

      const plans = symFills.map(fill => ({ fill, plan: planPosition(fill, { tick }) }));
      viewMoved = true;
      await chart.setVisibleRange({
        from: Math.min(...plans.map(p => p.plan.entry_time)) - 3600,
        to: Math.max(...plans.map(p => p.plan.end_time)) + 3600,
      });

      const existing = await chart.listPositions();

      for (const { fill, plan } of plans) {
        if (isDuplicate(plan, existing)) {
          drawSkipped.push({ order_id: fill.order_id, reason: 'already drawn' });
          continue;
        }
        const { entity_id, fallback } = await drawPosition(plan);
        if (!entity_id) {
          drawSkipped.push({ order_id: fill.order_id, reason: 'not created' });
          continue;
        }
        const anchor = await chart.getAnchor(entity_id);
        if (!anchor || anchor.time !== Math.floor(plan.entry_time / 60) * 60
          || Math.abs(anchor.price - plan.entry_price) > 1e-6) {
          await chart.removePosition(entity_id);
          drawSkipped.push({ order_id: fill.order_id, reason: 'placement mismatch' });
          continue;
        }
        if (fallback) fallbackSizing = true;
        // Same shape as the listPositions read, so a repeat later in this run is skipped.
        existing.push({ shape: plan.shape, time: anchor.time, price: anchor.price });
        drawn.push({
          order_id: fill.order_id, entity_id, side: fill.side, qty: fill.qty,
          entry_price: fill.entry_price, entry_time: unixToLocal(fill.entry_time),
        });
      }
    }
  } finally {
    try {
      if (current.symbol !== original.symbol) {
        await chart.setSymbol(original.symbol);
        current.symbol = original.symbol;
      }
      if (current.timeframe !== original.timeframe) {
        await chart.setTimeframe(original.timeframe);
        current.timeframe = original.timeframe;
      }
      if (viewMoved && originalView
        && Number.isFinite(originalView.spacing) && Number.isFinite(originalView.offset)) {
        await chart.setView(originalView);
      }
    } catch (err) {
      restoreError = err;
    }
  }
  // Reached only when drawing succeeded; a drawing error propagates from the try.
  if (restoreError) throw new Error(`Drew ${drawn.length} positions but failed to restore the chart: ${restoreError.message}`);

  return {
    success: true,
    export: exp.export_timestamp,
    fills: fills.length,
    drawn,
    skipped: [...skipped, ...drawSkipped],
    fallback_sizing: fallbackSizing,
    warnings,
    restored: { ...original },
  };
}
