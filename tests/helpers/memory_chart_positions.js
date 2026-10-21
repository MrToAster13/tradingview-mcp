/**
 * In-memory chart positions adapter for tests. Same methods as
 * createCdpChartPositions() in src/core/chart_positions.js, backed by a plain
 * list of shapes. Records every call in `calls` for assertions.
 *
 *   createThrows(overrides, n) -> true to make the n-th create throw
 *   snap(time)                 -> where the chart puts a point's time (default: bar start)
 */
const bar = (t) => Math.floor(t / 60) * 60;

export function createMemoryChartPositions({
  symbol = 'CME_MINI:MES1!',
  timeframe = '5',
  shapes = [],
  tick = { minmov: 25, pricescale: 100 },
  view = { spacing: 4.5, offset: 120 },
  createThrows = () => false,
  snap = bar,
} = {}) {
  const state = { symbol, timeframe, shapes: shapes.map(s => ({ ...s })), next: 1 };
  const calls = {
    getState: 0, getView: 0, setSymbol: [], setTimeframe: [], setVisibleRange: [], setView: [],
    tickSize: 0, listPositions: 0, creates: [], getAnchor: [], removes: [],
  };

  const chart = {
    async getState() { calls.getState++; return { symbol: state.symbol, timeframe: state.timeframe }; },
    async setSymbol(s) { calls.setSymbol.push(s); state.symbol = s; },
    async setTimeframe(tf) { calls.setTimeframe.push(tf); state.timeframe = tf; },
    async getView() { calls.getView++; return view ? { ...view } : null; },
    async setView(v) { calls.setView.push({ ...v }); },
    async setVisibleRange(r) { calls.setVisibleRange.push({ ...r }); },
    async tickSize() { calls.tickSize++; return tick; },
    async listPositions() {
      calls.listPositions++;
      return state.shapes
        .filter(s => s.name === 'long_position' || s.name === 'short_position')
        .map(s => ({ shape: s.name, time: s.points[0].time, price: s.points[0].price }));
    },
    async createPosition({ shape, entry_time, end_time, entry_price, overrides }) {
      calls.creates.push({ shape, entry_time, end_time, entry_price, overrides });
      if (createThrows(overrides, calls.creates.length)) throw new Error('JS evaluation error: create failed');
      const id = `pos${state.next++}`;
      state.shapes.push({
        id, name: shape,
        points: [{ time: snap(entry_time), price: entry_price }, { time: snap(end_time), price: entry_price }],
      });
      return id;
    },
    async getAnchor(id) {
      calls.getAnchor.push(id);
      return state.shapes.find(s => s.id === id)?.points[0] ?? null;
    },
    async removePosition(id) {
      calls.removes.push(id);
      state.shapes = state.shapes.filter(s => s.id !== id);
    },
  };

  const chartCalls = () => calls.getState + calls.getView + calls.tickSize + calls.listPositions
    + calls.setSymbol.length + calls.setTimeframe.length + calls.setVisibleRange.length
    + calls.setView.length + calls.creates.length + calls.getAnchor.length + calls.removes.length;

  return { chart, state, calls, chartCalls };
}
