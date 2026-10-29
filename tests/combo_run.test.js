/**
 * Tests for scripts/combo/read.js and scripts/combo/run.js. The reader expression runs
 * against a fake TradingViewApi in a vm sandbox; the cycle gets an injected reader.
 * Nothing here touches TradingView.
 *
 * Run: node --test tests/combo_run.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildReadExpr, buildMoreExpr, pickPage } from '../scripts/combo/read.js';
import { parseArgs, runCycle, runLoop, toJson, withTimeout } from '../scripts/combo/run.js';

const series = (rows) => ({
  firstIndex: () => 0, lastIndex: () => rows.length - 1, size: () => rows.length, valueAt: (i) => rows[i],
});

function fakeWindow({ replay = false, studies }) {
  const sources = studies.map((s) => ({
    metaInfo: () => ({
      description: s.name, shortDescription: s.short,
      plots: s.plots.map((title, i) => ({ id: `plot_${i}` })),
      styles: Object.fromEntries(s.plots.map((title, i) => [`plot_${i}`, title ? { title } : {}])),
    }),
    title: () => s.title,
    data: () => series(s.rows),
    properties: () => ({ childs: () => ({ inputs: { state: () => ({ in_0: s.len, text: 'blob', pineFeatures: 'x' }) } }) }),
  }));
  const main = series([[100, 1, 1, 1, 1, 0], [200, 2, 2, 2, 2, 0]]);
  const chart = {
    symbol: () => 'CME_MINI:MES1!', resolution: () => '5', chartType: () => 1,
    _chartWidget: { model: () => ({ mainSeries: () => ({ bars: () => main }), model: () => ({ dataSources: () => sources }) }) },
  };
  return {
    TradingViewApi: {
      _activeChartWidgetWV: { value: () => chart },
      _replayApi: { isReplayStarted: () => ({ value: () => replay }) },
    },
  };
}

describe('buildReadExpr', () => {
  const studies = [
    { name: 'MarketCipher_B', short: 'MC B', title: 'MarketCipher_B', len: 9, plots: ['Blue Wave', null, 'Buy'], rows: [[100, 1, 0, 1], [200, 2, 0, 0]] },
    { name: 'Other', short: 'O', title: 'Other', len: 3, plots: ['X'], rows: [[100, 5]] },
  ];

  it('returns bars, plot titles, inputs without the source blob, and rows only for wanted studies', () => {
    const v = vm.runInNewContext(buildReadExpr(['MC B']), { window: fakeWindow({ studies }) });
    assert.equal(v.symbol, 'CME_MINI:MES1!');
    assert.equal(v.replay, false);
    assert.equal(v.bars.length, 2);
    const mcb = v.studies.find((s) => s.name === 'MarketCipher_B');
    assert.deepEqual(Array.from(mcb.plots), ['Blue Wave', null, 'Buy']);
    assert.equal(mcb.lastT, 200);
    assert.equal(mcb.inputs, '{"in_0":9}');
    assert.equal(mcb.rows.length, 2);
    assert.equal(v.studies.find((s) => s.name === 'Other').rows, null);
  });

  it('keeps named inputs of built-in studies, dropping only the script blob keys', () => {
    const win = fakeWindow({ studies });
    const src = win.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().model().dataSources()[0];
    src.properties = () => ({ childs: () => ({ inputs: { state: () => ({ length: 9, source: 'close', text: 'blob', pineFeatures: 'x', __profile: false }) } }) });
    const v = vm.runInNewContext(buildReadExpr(['MC B']), { window: win });
    assert.equal(v.studies[0].inputs, '{"length":9,"source":"close"}');
  });

  it('returns each study last row for --list', () => {
    const v = vm.runInNewContext(buildReadExpr([]), { window: fakeWindow({ studies }) });
    assert.deepEqual(Array.from(v.studies[0].last), [200, 2, 0, 0]);
    assert.equal(v.chartType, 1);
  });

  it('asks for more history only when the chart shows the config symbol and timeframe and replay is off', () => {
    const run = (want, replay) => {
      const win = fakeWindow({ studies, replay });
      let asked = 0;
      const main = win.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries();
      main.requestMoreData = () => { asked++; };
      win.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model = () => ({ mainSeries: () => main });
      vm.runInNewContext(buildMoreExpr(want.symbol, want.resolution), { window: win });
      return asked;
    };
    assert.equal(run({ symbol: 'CME_MINI:MES1!', resolution: '5' }, false), 1);
    assert.equal(run({ symbol: 'CME_MINI:NQ1!', resolution: '5' }, false), 0);
    assert.equal(run({ symbol: 'CME_MINI:MES1!', resolution: '1' }, false), 0);
    assert.equal(run({ symbol: 'CME_MINI:MES1!', resolution: '5' }, true), 0);
  });

  it('embeds a hostile study name as data, not code', () => {
    const name = `x"]); globalThis.pwned = 1; (["`;
    const ctx = { window: fakeWindow({ studies }) };
    const v = vm.runInNewContext(buildReadExpr([name, "y'); globalThis.pwned = 1; //"]), ctx);
    assert.equal(ctx.pwned, undefined);
    assert.ok(v.studies.every((s) => s.rows === null));
  });
});

describe('pickPage', () => {
  const want = { symbol: 'CME_MINI:MES1!', resolution: '1' };
  it('picks the first chart tab on the config symbol and timeframe with real prices', () => {
    const pages = [
      { id: 'ha', symbol: 'CME_MINI:MES1!', resolution: '1', chartType: 8 },
      { id: 'nq', symbol: 'CME_MINI:NQ1!', resolution: '1', chartType: 1 },
      { id: 'candles', symbol: 'CME_MINI:MES1!', resolution: '1', chartType: 1 },
    ];
    assert.equal(pickPage(pages, want).id, 'candles');
  });

  it('falls back to the first tab when none match, so the cycle skips with its reason', () => {
    assert.equal(pickPage([{ id: 'ha', symbol: 'CME_MINI:MES1!', resolution: '1', chartType: 8 }, { id: 'b', symbol: 'X', resolution: '1', chartType: 1 }], want).id, 'ha');
  });
});

describe('parseArgs', () => {
  it('reads config, out and every, with every defaulting to 15 minutes', () => {
    assert.deepEqual(parseArgs(['--config', 'c.json', '--out', 'd']), { config: 'c.json', out: 'd', every: 15, once: false, list: false });
    assert.equal(parseArgs(['--config', 'c.json', '--out', 'd', '--every', '5', '--once']).once, true);
    assert.equal(parseArgs(['--list']).list, true);
  });

  it('rejects a missing config or out, a bad every, and unknown options', () => {
    assert.throws(() => parseArgs(['--out', 'd']), /--config/);
    assert.throws(() => parseArgs(['--config', 'c.json']), /--out/);
    assert.throws(() => parseArgs(['--config', 'c', '--out', 'd', '--every', '0']), /--every/);
    assert.throws(() => parseArgs(['--config', 'c', '--out', 'd', '--bogus']), /unknown/);
  });
});

const config = {
  symbol: 'CME_MINI:MES1!', resolution: '5', horizon: 1, costPoints: 0, maxSize: 1,
  signals: [{ name: 'buy', side: 'bull', study: 'MarketCipher_B', plot: 'Buy', op: 'fires' }],
};
const rawRead = (extra = {}) => ({
  symbol: 'CME_MINI:MES1!', resolution: '5', replay: false, replayAfter: false,
  bars: [[100, 1, 1, 1, 1, 0], [200, 2, 2, 2, 2, 0], [300, 3, 3, 3, 3, 0]],
  studies: [{ name: 'MarketCipher_B', short: 'MC B', title: 'MarketCipher_B', inputs: '{"in_0":9}', plots: ['Buy'], lastT: 300, rows: [[100, 1], [200, 0], [300, 1]] }],
  ...extra,
});

async function cycle(raw) {
  const out = mkdtempSync(join(tmpdir(), 'combo-run-'));
  const logs = [];
  const res = await runCycle({ config, out, read: async () => raw, now: () => 400, every: 15, log: (m) => logs.push(m) });
  return { out, logs, res };
}

describe('runCycle', () => {
  it('stores closed bars and writes the leaderboard files', async () => {
    const { out, res } = await cycle(rawRead());
    assert.equal(res.skipped, undefined);
    assert.ok(existsSync(join(out, 'leaderboard.md')));
    const store = JSON.parse(readFileSync(join(out, 'store.json'), 'utf8'));
    assert.deepEqual(store.bars.map((x) => x.t), [100, 200]);
    const board = JSON.parse(readFileSync(join(out, 'leaderboard.json'), 'utf8'));
    assert.equal(board.combosTested, 1);
  });

  it('skips and writes nothing when the chart shows another symbol or timeframe', async () => {
    const { out, res, logs } = await cycle(rawRead({ symbol: 'CME_MINI:NQ1!' }));
    assert.match(res.skipped, /NQ1!/);
    assert.match(logs.join('\n'), /skip/);
    assert.deepEqual(readdirSync(out), []);
    assert.match((await cycle(rawRead({ resolution: '1' }))).res.skipped, /timeframe/);
  });

  it('skips when replay runs before or after the read', async () => {
    assert.match((await cycle(rawRead({ replay: true }))).res.skipped, /replay/);
    assert.match((await cycle(rawRead({ replayAfter: true }))).res.skipped, /replay/);
  });

  it('skips when the chart type changes prices, such as Heikin Ashi or Renko', async () => {
    assert.match((await cycle(rawRead({ chartType: 8 }))).res.skipped, /chart type/);
    assert.equal((await cycle(rawRead({ chartType: 1 }))).res.skipped, undefined);
  });

  it('writes an infinite profit factor as "inf" in JSON and times out a hung read', async () => {
    assert.equal(toJson({ pf: Infinity }), '{"pf":"inf"}');
    await assert.rejects(withTimeout(new Promise(() => {}), 10), /timed out/);
  });

  it('skips when a study has not finished loading', async () => {
    const raw = rawRead();
    raw.studies[0].lastT = 200;
    assert.match((await cycle(raw)).res.skipped, /not loaded/);
  });
});

describe('runLoop', () => {
  it('logs a failed cycle and keeps going', async () => {
    const logs = [];
    let calls = 0;
    await runLoop({
      cycle: async () => { calls++; if (calls === 1) throw new Error('CDP closed'); },
      sleep: async () => {}, log: (m) => logs.push(m), cycles: 3,
    });
    assert.equal(calls, 3);
    assert.match(logs.join('\n'), /CDP closed/);
  });
});

describe('read-only guard', () => {
  it('no combo script calls anything that changes the chart or TradingView', () => {
    const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'scripts', 'combo');
    const banned = /setSymbol|setResolution|setTimeframe|selectDate|stopReplay|startReplay|removeEntity|createShape|createStudy|removeStudy|createAlert|alert_|placeOrder|Browser\.close|taskkill|launch/;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = readFileSync(join(dir, f), 'utf8');
      assert.equal(banned.exec(src)?.[0], undefined, `${f} uses a chart-changing call`);
    }
  });
});
