# Combo tester

The combo tester takes your list of strong bullish and strong bearish signals from indicators on the TradingView chart. It tests every small combination of them on the chart's history and keeps a leaderboard. It only tests. It never places orders, alerts or drawings.

With 10 signals there are at most 55 combinations of 1 or 2, so one cycle tests them all in well under a second. Running around the clock means re-testing every combination as new bars close, and tracking how each winner does on bars it never saw. It does not search over exits or symbols, because tuning those is the complexity that decays.

Complexity stays low:

- A combination has at most 3 signals. The default is 2.
- Exits are a fixed number of bars, with no stop, target or trailing parameters to tune.
- A larger combination only ranks above a smaller one inside it when it beats that one out of sample by 10%.

## Files

- `scripts/combo/signals.example.json` shows the signal list format. Copy it and fill in your own signals.
- `scripts/combo/engine.js` holds the pure logic: signal checks, combinations, trades, stats and ranking.
- `scripts/combo/store.js` merges each chart read into a bar store on disk.
- `scripts/combo/read.js` reads the chart in one call. It changes nothing on the chart.
- `scripts/combo/run.js` is the loop: read, merge, test, write the leaderboard, sleep.

## Signal list

```json
{
  "symbol": "CME_MINI:MES1!",
  "resolution": "1",
  "horizon": 12,
  "costPoints": 0.5,
  "maxSize": 2,
  "signals": [
    { "name": "B buy dot", "side": "bull", "study": "MarketCipher_B", "plot": "Buy", "op": "fires" },
    { "name": "Money flow above 0", "side": "bull", "study": "MarketCipher_B", "plot": "Mny Flow", "op": ">", "value": 0 },
    { "name": "Close above VWAP", "side": "bull", "study": "MarketCipher_SR", "plot": "VWAP", "op": "<", "ref": "close" },
    { "name": "Money flow below 0", "side": "bear", "study": "MarketCipher_B", "plot": "Mny Flow", "op": "<", "value": 0 }
  ]
}
```

- These names come from Elijah's MES 1m layout. Replace them with your own: run `node scripts/combo/run.js --list` to print every study on the chart, its plot titles and each plot's value on the last bar. A plot whose value is 0 or empty most of the time is a shape or alert plot and wants `fires`.
- `study` matches a study's name, short name or legend title exactly. It must match one study. Two studies with the same name stop the run with an error, so rename one in its settings.
- `plot` and a string `ref` are plot titles of that study. A study with two plots of the same title cannot use that title. `ref` can also be `"open"`, `"high"`, `"low"`, `"close"`, or `{ "study": ..., "plot": ... }` for another study.
- `op` is one of `>`, `<`, `crosses_above`, `crosses_below` or `fires`. The right side is a number, `value`, or `ref`.
- The signal reads as "plot op right side". "Close above VWAP" is `VWAP < close`.
- `fires` takes no right side. It is true on a bar where the plot has a nonzero value, such as a shape plot ("Buy") or an alert condition ("Long Entry").
- A missing value is never true. A cross needs both sides on this bar and the bar before.
- `side` is `bull` or `bear`. Bull signals combine only with bull signals, bear only with bear.
- `horizon` (bars held, default 12), `costPoints` (round trip, default 0) and `maxSize` (1 to 3, default 2) are optional.

## How a combination trades

- A combination fires on a closed bar when every signal in it is true on that bar.
- The trade enters at the next bar's open, long for bull and short for bear. It exits at the open `horizon` bars after entry.
- It does not enter again while a trade is open.
- A trade needs its exit bar. It cannot cross a gap in the store or the train/test split.
- Each trade's result is points, minus `costPoints`.

## Scoring

- Bars split by time: the oldest 70% are train, the newest 30% are test.
- For each combination and split: trades, win rate, average points, profit factor and the t-stat of the trade results. With fewer than 2 trades, or all results equal, there is no t-stat and the combination fails.
- A combination survives when it has at least 30 test trades, its train and test averages are both above zero, and its test t-stat clears a bar that rises with the number of combinations tested: the t distribution quantile at 1 − 0.05/N for its number of test trades. At N = 55 and 30 trades the bar is about 3.43. This keeps lucky winners out.
- Survivors rank by test t-stat. A combination whose test average is under 1.1 times that of a surviving combination inside it is dropped.
- Below the survivors, the leaderboard lists the 5 combinations with the highest test t-stat that do not pass yet.
- Each survivor records the time it first survived. The leaderboard shows its trades since then on live bars only. That is the honest number.

## The store

- Only closed bars are stored. The newest bar on the chart is still forming and is never stored.
- A bar is live when it was first stored within two cycles of its time. Live bars keep their stored values, so a repainting indicator cannot rewrite history the tester saw as it happened.
- Bars loaded from history are not live, apart from the newest few of a read. They take a new read's values only when that read starts at or before the one that wrote them, so an indicator's warm-up at the old edge of one read is replaced when the next read loads further back, and a shorter read after a restart cannot damage settled values. Their values may include repaint, so only the forward numbers are free of it.
- A newer read that does not overlap the store starts a new segment. An older one is skipped. A later read that covers the gap fills it and joins the segments. Trades and crosses never span segments.
- A reloaded chart, as after a TradingView restart, can drop or add a few quiet minutes and revise a few closes. Up to 10% of the stored bars in the read's span may differ in those ways. Revised closes are taken from the read and those bars stop being live; dropped bars stay in the store; new bars are inserted.
- History changed when more than 10% differ. That catches a back-adjust and a switch between regular and extended hours, which change far more bars. The cycle is skipped and logged. Start a new `--out` folder to begin again.
- On an unadjusted continuous contract such as `MES1!`, a roll does not change old bars and is not detected. A trade held across the roll books the gap between contracts. With exits of a few bars this hits about one trade a quarter.
- The store records each study's inputs. If they change, the cycle is skipped and logged, because the stored values no longer mean the same thing.
- The store keeps the newest 200,000 bars, about 3 years of 5m futures bars or 7 months of 1m bars.
- Writes go to a temp file, then rename. A lock file stops two runs from sharing one `--out` folder.

## The loop

- Every `--every` minutes (default 15), `run.js` reads the chart in one call. It loads older history with the chart's own request for more data, which does not move the view. That request checks, in the same page call, that the chart shows the config symbol and timeframe and that replay is off.
- It never changes the symbol, timeframe, studies, drawings or replay. It skips the cycle and logs why when the chart shows another symbol or timeframe, when the chart type changes prices (Heikin Ashi, Renko, Kagi, point and figure, line break), when replay is running before or after the read, or when a study has not finished loading.
- A read that takes over 60 seconds counts as an error. An error, including TradingView closing, logs and waits for the next cycle. The loop never exits on its own, and it never starts or closes TradingView.
- After each merge it writes `leaderboard.json` and `leaderboard.md` to the output folder.

## Run it

```
node scripts/combo/run.js --config my-signals.json --out combo-data --every 15
```

Leave the terminal open to keep it running. `--once` runs one cycle and exits.

Point it at a chart on candles, bars, hollow candles, line or area. A Heikin Ashi chart is skipped every cycle: its opens and closes are averages, not prices a trade could fill at. The tester reads the first chart tab that shows the config symbol and timeframe on one of those types, so if your trading tab is on Heikin Ashi, open a second tab on candles with the same studies and it will read that one. Indicators on that tab then compute on real prices, so their signals can differ from the ones you see on Heikin Ashi.
