/**
 * Core drawing logic.
 */
import { readFileSync } from 'node:fs';
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import * as chart from './chart.js';
import { findExport, parseCsv, netFromPositions, buildFills, planPosition, isDuplicate, unixToLocal } from './trades.js';

function _resolve(deps) {
  return { evaluate: deps?.evaluate || _evaluate, getChartApi: deps?.getChartApi || _getChartApi };
}

export async function drawShape({ shape, point, point2, overrides: overridesRaw, text, _deps }) {
  const { evaluate, getChartApi } = _resolve(_deps);
  const overrides = overridesRaw ? (typeof overridesRaw === 'string' ? JSON.parse(overridesRaw) : overridesRaw) : {};
  const apiPath = await getChartApi();
  const overridesStr = JSON.stringify(overrides || {});
  const textStr = text ? JSON.stringify(text) : '""';

  const p1time = requireFinite(point.time, 'point.time');
  const p1price = requireFinite(point.price, 'point.price');

  const before = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);

  if (point2) {
    const p2time = requireFinite(point2.time, 'point2.time');
    const p2price = requireFinite(point2.price, 'point2.price');
    await evaluate(`
      ${apiPath}.createMultipointShape(
        [{ time: ${p1time}, price: ${p1price} }, { time: ${p2time}, price: ${p2price} }],
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  } else {
    await evaluate(`
      ${apiPath}.createShape(
        { time: ${p1time}, price: ${p1price} },
        { shape: ${safeString(shape)}, overrides: ${overridesStr}, text: ${textStr} }
      )
    `);
  }

  await new Promise(r => setTimeout(r, 200));
  const after = await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`);
  const newId = (after || []).find(id => !(before || []).includes(id)) || null;
  const result = { entity_id: newId };
  return { success: true, shape, entity_id: result?.entity_id };
}

export async function listDrawings() {
  const apiPath = await _getChartApi();
  const shapes = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var all = api.getAllShapes();
      return all.map(function(s) { return { id: s.id, name: s.name }; });
    })()
  `);
  return { success: true, count: shapes?.length || 0, shapes: shapes || [] };
}

export async function getProperties({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var props = { entity_id: eid };
      var shape = api.getShapeById(eid);
      if (!shape) return { error: 'Shape not found: ' + eid };
      var methods = [];
      try { for (var key in shape) { if (typeof shape[key] === 'function') methods.push(key); } props.available_methods = methods; } catch(e) {}
      try { var pts = shape.getPoints(); if (pts) props.points = pts; } catch(e) { props.points_error = e.message; }
      try { var ovr = shape.getProperties(); if (ovr) props.properties = ovr; } catch(e) {
        try { var ovr2 = shape.properties(); if (ovr2) props.properties = ovr2; } catch(e2) { props.properties_error = e2.message; }
      }
      try { props.visible = shape.isVisible(); } catch(e) {}
      try { props.locked = shape.isLocked(); } catch(e) {}
      try { props.selectable = shape.isSelectionEnabled(); } catch(e) {}
      try {
        var all = api.getAllShapes();
        for (var i = 0; i < all.length; i++) { if (all[i].id === eid) { props.name = all[i].name; break; } }
      } catch(e) {}
      return props;
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, ...result };
}

export async function removeOne({ entity_id }) {
  const apiPath = await _getChartApi();
  const result = await _evaluate(`
    (function() {
      var api = ${apiPath};
      var eid = ${safeString(entity_id)};
      var before = api.getAllShapes();
      var found = false;
      for (var i = 0; i < before.length; i++) { if (before[i].id === eid) { found = true; break; } }
      if (!found) return { removed: false, error: 'Shape not found: ' + eid, available: before.map(function(s) { return s.id; }) };
      api.removeEntity(eid);
      var after = api.getAllShapes();
      var stillExists = false;
      for (var j = 0; j < after.length; j++) { if (after[j].id === eid) { stillExists = true; break; } }
      return { removed: !stillExists, entity_id: eid, remaining_shapes: after.length };
    })()
  `);
  if (result?.error) throw new Error(result.error);
  return { success: true, entity_id: result?.entity_id, removed: result?.removed, remaining_shapes: result?.remaining_shapes };
}

export async function clearAll() {
  const apiPath = await _getChartApi();
  await _evaluate(`${apiPath}.removeAllShapes()`);
  return { success: true, action: 'all_shapes_removed' };
}

// ── Paper-trading export → position drawings ─────────────────────────────

function _resolveTrades(deps) {
  return {
    ..._resolve(deps),
    getState: deps?.getState || chart.getState,
    setSymbol: deps?.setSymbol || chart.setSymbol,
    setTimeframe: deps?.setTimeframe || chart.setTimeframe,
    setVisibleRange: deps?.setVisibleRange || chart.setVisibleRange,
    readFile: deps?.readFile || ((path) => readFileSync(path, 'utf8')),
    sleep: deps?.sleep || ((ms) => new Promise(r => setTimeout(r, ms))),
    dir: deps?.dir,
  };
}

/**
 * Draw a TradingView long/short position for each filled entry in a
 * paper-trading CSV export (newest in ~/Downloads unless export_timestamp is
 * given). Switches the chart to each traded symbol on 1 minute, skips entries
 * already drawn, verifies each drawing landed on the entry bar and price, and
 * restores the original symbol, timeframe and view.
 */
export async function drawTradesFromCsv({ export_timestamp, dry_run = false, _deps } = {}) {
  const d = _resolveTrades(_deps);
  const exp = findExport({ dir: d.dir, exportTimestamp: export_timestamp });
  const orders = parseCsv(d.readFile(exp.order_history_path));
  const balances = parseCsv(d.readFile(exp.balance_history_path));
  // The export id is the UTC time of the export.
  const exportTime = Date.parse(`${exp.export_timestamp.replace(/_/g, ':')}Z`) / 1000;
  // Without a readable positions export the replay starts flat, which is
  // wrong only when the order history was cut off mid-position.
  const netAtExport = exp.positions_path ? netFromPositions(parseCsv(d.readFile(exp.positions_path))) : null;
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

  const { evaluate } = d;
  const apiPath = await d.getChartApi();
  const start = await d.getState();
  const original = { symbol: start.symbol, timeframe: start.resolution };
  const current = { ...original };
  // Bar spacing and right offset put the view back where the user left it,
  // including the empty space right of the live bar.
  const tsPath = `${apiPath}._chartWidget.model().timeScale()`;
  const originalView = await evaluate(`(function() {
    try { var ts = ${tsPath}; return { spacing: ts.barSpacing(), offset: ts.rightOffset() }; }
    catch (e) { return null; }
  })()`);
  let viewMoved = false;

  const bySymbol = new Map();
  for (const f of fills) {
    if (!bySymbol.has(f.symbol)) bySymbol.set(f.symbol, []);
    bySymbol.get(f.symbol).push(f);
  }

  const shapeIds = async () => (await evaluate(`${apiPath}.getAllShapes().map(function(s) { return s.id; })`)) || [];

  const create = (plan, overrides) => {
    const t1 = requireFinite(plan.entry_time, 'entry_time');
    const t2 = requireFinite(plan.end_time, 'end_time');
    const price = requireFinite(plan.entry_price, 'entry_price');
    const points = JSON.stringify([{ time: t1, price }, { time: t2, price }]);
    const opts = JSON.stringify({ shape: plan.shape, overrides });
    return evaluate(`${apiPath}.createMultipointShape(${points}, ${opts})`);
  };

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

    const before = await shapeIds();
    try {
      await create(plan, full);
    } catch (err) {
      if (Object.keys(full).length === Object.keys(levels).length) throw err;
      await create(plan, levels);
      fallback = true;
    }
    await d.sleep(200);
    const after = await shapeIds();
    return { entity_id: after.find(id => !before.includes(id)) || null, fallback };
  };

  const drawn = [];
  const drawSkipped = [];
  let fallbackSizing = false;
  let restoreError = null;

  try {
    for (const [symbol, symFills] of bySymbol) {
      if (current.symbol !== symbol) {
        current.symbol = symbol;
        await d.setSymbol({ symbol });
      }
      if (current.timeframe !== '1') {
        current.timeframe = '1';
        await d.setTimeframe({ timeframe: '1' });
      }

      const si = await evaluate(`(function() {
        var si = ${apiPath}._chartWidget.model().mainSeries().symbolInfo();
        return si ? { minmov: si.minmov, pricescale: si.pricescale } : null;
      })()`);
      const tick = si ? si.minmov / si.pricescale : NaN;
      if (!(Number.isFinite(tick) && tick > 0)) {
        throw new Error(`Could not read tick size for ${symbol} (symbolInfo: ${JSON.stringify(si)})`);
      }

      const plans = symFills.map(fill => ({ fill, plan: planPosition(fill, { tick }) }));
      viewMoved = true;
      await d.setVisibleRange({
        from: Math.min(...plans.map(p => p.plan.entry_time)) - 3600,
        to: Math.max(...plans.map(p => p.plan.end_time)) + 3600,
      });

      const existing = (await evaluate(`(function() {
        var api = ${apiPath};
        var out = [];
        api.getAllShapes().forEach(function(s) {
          if (s.name !== "long_position" && s.name !== "short_position") return;
          try {
            var p = api.getShapeById(s.id).getPoints();
            if (p && p[0]) out.push({ shape: s.name, time: p[0].time, price: p[0].price });
          } catch (e) {}
        });
        return out;
      })()`)) || [];

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
        const pts = await evaluate(`(function() {
          var s = ${apiPath}.getShapeById(${safeString(entity_id)});
          return s ? s.getPoints() : null;
        })()`);
        const anchor = pts?.[0];
        if (!anchor || anchor.time !== Math.floor(plan.entry_time / 60) * 60
          || Math.abs(anchor.price - plan.entry_price) > 1e-6) {
          await evaluate(`${apiPath}.removeEntity(${safeString(entity_id)})`);
          drawSkipped.push({ order_id: fill.order_id, reason: 'placement mismatch' });
          continue;
        }
        if (fallback) fallbackSizing = true;
        drawn.push({
          order_id: fill.order_id, entity_id, side: fill.side, qty: fill.qty,
          entry_price: fill.entry_price, entry_time: unixToLocal(fill.entry_time),
        });
      }
    }
  } finally {
    try {
      if (current.symbol !== original.symbol) {
        await d.setSymbol({ symbol: original.symbol });
        current.symbol = original.symbol;
      }
      if (current.timeframe !== original.timeframe) {
        await d.setTimeframe({ timeframe: original.timeframe });
        current.timeframe = original.timeframe;
      }
      if (viewMoved && originalView
        && Number.isFinite(originalView.spacing) && Number.isFinite(originalView.offset)) {
        await evaluate(`(function() {
          var ts = ${tsPath};
          ts.setBarSpacing(${originalView.spacing});
          ts.setRightOffset(${originalView.offset});
        })()`);
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
