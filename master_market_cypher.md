# Master Market Cipher reference

Reference for agents reading MarketCipher indicators on Elijah's TradingView chart. Each section names its source. Add new sources as new sections; don't rewrite old ones.

## How to read the indicators from the chart

All four MarketCipher studies are invite-only. Their source and inputs are encrypted, so `data_get_indicator` and `pine_get_source` return nothing useful. Their plotted values are readable:

- `data_get_study_values` gives the current bar's values by plot title.
- Over CDP, `source.data()` on each study holds every loaded bar (`valueAt(i)` returns `[time, plot1, plot2, ...]`). Checked on 2026-10-15 with about 4,890 one-minute bars loaded.
- Signal plots (shapes and alertconditions) are 0 or null when they don't fire.

Studies on the chart as of 2026-10-15: MarketCipher_A, MarketCipher_B, MarketCipher_SR and MarketCipher DBSI.

## Source: "Market Cipher A & B Tools" (Market Cipher, YouTube)

URL: https://www.youtube.com/watch?v=f6xC0WtRD7E (5:48). Notes come from the auto-generated transcript. The "Plot" column maps each tool to the plot title the indicator exposes; that mapping comes from matching plot titles, colors and shapes on the live chart, not from the video.

### Market Cipher A (price pane)

| Tool | Meaning (video) | Plot |
|---|---|---|
| EMA ribbons | All ribbons in full color, white to blue: overall bullish trend. All ribbons grayed out: overall bearish trend. | `Ribbon 1` to `Ribbon 9` with colorers (only `Ribbon 5` had values on 2026-10-15) |
| Yellow diamond | Bullish. Usually a continuation of the move. "These are your friends." | `Yellow Diamond` |
| Green dot | Generally bullish. Look at everything else for more confirmation. | `Green Dot` |
| Blue triangle | Likely reversal of the previous trend. | `Blue Triangle` |
| Red diamond | Bearish, first warning. The move may be losing steam. | `Red Diamond` |
| Red X | Bearish, hard warning. Consider taking profit or shorting. | `Red X` |
| Blood diamond | Bearish, harshest warning. Exit or short. | `Blood Diamond` |
| Yellow X | Whale manipulation. The presenter avoids trading around a yellow X unless very familiar with the whole package. | `Yellow X` |

### Market Cipher B (lower pane)

| Tool | Meaning (video) | Plot |
|---|---|---|
| Green dots on the momentum wave | Can mark a local bottom. | `Buy` (large green dot); `Blue Wave Crossing UP` / `Blue Wave Crossing Down` are the small green and red dots |
| Purple RSI | Traditional RSI. Very high: overbought. Very low: oversold. | `RSI` (magenta) |
| Red/green line | Heavily smoothed stochastic RSI with both lines combined. Red: bearish sentiment. Green: bullish sentiment. | `Sto RSI` (colorer picks green or red) |
| Big blue wave | Momentum wave. Shows reversals, momentum and overall movement. | `Blue Wave` (dark blue), `Lt Blue Wave` (light blue) |
| Light blue turning into dark blue abruptly | Likely trend reversal, matched by price action. | Crossing of `Lt Blue Wave` and `Blue Wave` |
| Green/red wave | Money flow. Green: money flowing in, likely bullish price action. Red: money leaving, likely bearish. | `Mny Flow` (colorer picks green or red) |
| Yellow wave | VWAP combined with a momentum wave, heavily smoothed. It tends to return to the zero line. Crossing above zero and staying positive: price may turn bullish. Crossing below zero: price may go down. | `VWAP` (yellow, in MarketCipher_B, not the price VWAP in MarketCipher_SR) |
| Bar at the bottom | Green when money flow is positive, red when negative. Green but falling means the move is fading; red but rising means it may turn up soon. | The fill between the two `Plot` lines at −93 and −103 |

Level lines on MarketCipher_B: `OB 1 Solid` +60, `OS 1 Solid` −60 (solid), `Trigger 1` +53, `Trigger 2` −53 (dotted), `Zero` 0. The video doesn't explain these levels.

### Not covered in this video

The video says its next one covers the core "Blue Wave strategy", which combines these tools. Anchor waves and trigger waves aren't defined here. Add them from that video when it's available.

## Source: "How to use Market Cipher Basic Strategy CORRECTLY!" (Crypto Face, YouTube)

URL: https://www.youtube.com/watch?v=7U8zYPnqeco (16:59). Notes come from the auto-generated transcript. The example is a live BTC/USDT long entered on the 4-minute chart. The presenter says Market Cipher works on any chartable asset and any timeframe.

### Basic strategy long setup (as shown on the 4-minute entry chart)

All of these lined up on the trade he took:

1. Big green dots on MarketCipher_B after momentum (the blue wave) came down deep.
2. Momentum then rose sharply from the deep green dots.
3. Money flow came down and started curving back up. He also calls an entry when money flow crosses the zero line valid "in the right situation".
4. Both RSI lines green, close together and heading up.
5. Candles turning up.

He also calls his entry wave a "beautiful trigger wave" but doesn't define the term.

### Main rule: higher timeframes must back the entry

The same 4-minute setup appeared four times. Only the trades with higher timeframes agreeing worked:

- **Failed entries.** On the 1-hour, money flow, both RSIs and momentum were all heading straight down. The 4-minute setup "did not have the higher time frames backing it up", so it failed.
- **The trade he took.** On the higher timeframe, money flow was already in the red and coming up.
- **A trade that worked but he rejects.** Money flow was still falling on a big green dot, and the 30-, 15- and 10-minute charts didn't clearly agree. He calls it a higher-risk entry that "got lucky" and says trading shouldn't be gambling.
- For bias he checks the daily and 2-day: money flow at a local high, yellow VWAP waves rising, momentum up and RSI strong mean a bullish bias.

### Trade management

- Don't dollar-cost average into a losing position. He adds to winning trades only "when the time is right".
- Always set a stop loss. Don't leave a trade unprotected.
- He takes partial profit on warning signs. On the 1-hour he saw a head and shoulders on the momentum waves, falling money flow and momentum, and a blood diamond.
- He keeps part of the position open as a cushion if price turns back up.
- Don't force trades. If you miss one, wait for the next.

### Notes for automation (agent notes, not from the video)

- A higher-timeframe filter needs MarketCipher_B values from a second timeframe. A study's `data()` only holds the chart's own timeframe. Switching the live chart's timeframe would disturb Elijah's trading, so a second chart in a multi-chart layout is the likely route. Not tested.
