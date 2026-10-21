/**
 * Chart positions adapter. The paper-trade drawing module (paper_trades.js)
 * reaches the TradingView chart only through this interface, which speaks in
 * symbols, views and long/short positions instead of page JavaScript.
 *
 * createCdpChartPositions() drives the live chart over CDP. Tests use the
 * in-memory adapter in tests/helpers/memory_chart_positions.js, which has the
 * same methods.
 *
 * Interface (every method is async):
 *   getState()               -> { symbol, timeframe }
 *   setSymbol(symbol)
 *   setTimeframe(timeframe)
 *   getView()                -> { spacing, offset } or null when unreadable
 *   setView({ spacing, offset })
 *   setVisibleRange({ from, to })
 *   tickSize()               -> { minmov, pricescale } or null
 *   listPositions()          -> [{ shape, time, price }], the entry anchor of
 *                               every long_position and short_position drawing
 *   createPosition({ shape, entry_time, end_time, entry_price, overrides })
 *                            -> the new entity id, or null when no new shape
 *                               appeared; throws when the chart refuses it
 *   getAnchor(entity_id)     -> { time, price } of the entry point, or null
 *   removePosition(entity_id)
 */
import { evaluate as _evaluate, getChartApi as _getChartApi, safeString, requireFinite } from '../connection.js';
import * as chart from './chart.js';

export function createCdpChartPositions(deps = {}) {
  const evaluate = deps.evaluate || _evaluate;
  const getChartApi = deps.getChartApi || _getChartApi;
  const getState = deps.getState || chart.getState;
  const setSymbol = deps.setSymbol || chart.setSymbol;
  const setTimeframe = deps.setTimeframe || chart.setTimeframe;
  const setVisibleRange = deps.setVisibleRange || chart.setVisibleRange;
  const sleep = deps.sleep || ((ms) => new Promise(r => setTimeout(r, ms)));

  let apiPathPromise = null;
  const api = () => (apiPathPromise ??= getChartApi());
  const timeScale = async () => `${await api()}._chartWidget.model().timeScale()`;
  const shapeIds = async () => (await evaluate(`${await api()}.getAllShapes().map(function(s) { return s.id; })`)) || [];

  return {
    async getState() {
      const s = await getState();
      return { symbol: s.symbol, timeframe: s.resolution };
    },

    async setSymbol(symbol) {
      await setSymbol({ symbol });
    },

    async setTimeframe(timeframe) {
      await setTimeframe({ timeframe });
    },

    // Bar spacing and right offset, which include the empty space right of the live bar.
    async getView() {
      return evaluate(`(function() {
        try { var ts = ${await timeScale()}; return { spacing: ts.barSpacing(), offset: ts.rightOffset() }; }
        catch (e) { return null; }
      })()`);
    },

    async setView({ spacing, offset }) {
      const s = requireFinite(spacing, 'spacing');
      const o = requireFinite(offset, 'offset');
      await evaluate(`(function() {
        var ts = ${await timeScale()};
        ts.setBarSpacing(${s});
        ts.setRightOffset(${o});
      })()`);
    },

    async setVisibleRange({ from, to }) {
      await setVisibleRange({ from, to });
    },

    async tickSize() {
      return evaluate(`(function() {
        var si = ${await api()}._chartWidget.model().mainSeries().symbolInfo();
        return si ? { minmov: si.minmov, pricescale: si.pricescale } : null;
      })()`);
    },

    async listPositions() {
      return (await evaluate(`(function() {
        var api = ${await api()};
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
    },

    // The chart API returns no id from createMultipointShape, so the new id is
    // the one that was not there before.
    async createPosition({ shape, entry_time, end_time, entry_price, overrides }) {
      const t1 = requireFinite(entry_time, 'entry_time');
      const t2 = requireFinite(end_time, 'end_time');
      const price = requireFinite(entry_price, 'entry_price');
      const points = JSON.stringify([{ time: t1, price }, { time: t2, price }]);
      const opts = JSON.stringify({ shape, overrides });
      const before = await shapeIds();
      await evaluate(`${await api()}.createMultipointShape(${points}, ${opts})`);
      await sleep(200);
      const after = await shapeIds();
      return after.find(id => !before.includes(id)) || null;
    },

    async getAnchor(entity_id) {
      const pts = await evaluate(`(function() {
        var s = ${await api()}.getShapeById(${safeString(entity_id)});
        return s ? s.getPoints() : null;
      })()`);
      return pts?.[0] ?? null;
    },

    async removePosition(entity_id) {
      await evaluate(`${await api()}.removeEntity(${safeString(entity_id)})`);
    },
  };
}
