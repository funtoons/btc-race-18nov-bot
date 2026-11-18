# btc-race-18nov-bot

A cbBTC trading bot for the make.fun "Race a BTC trading bot live for 24
hours" competition (btc-race-24h-20261118-1444). It speaks
`agent-fun/bars-replay/v1`: one JSON line per 1-minute bar in, one reply
with buy/sell orders out. Standard library only, plus the kit SDK shim
vendored byte-for-byte under `vendor/`. No network, no clock, no
randomness; every decision is exact integer arithmetic on the bars, so
two runs on the same data decide identically.

## Strategy

Wait in cash; enter all-in only on confirmed sustained strength; ride it
with a wide trailing stop; otherwise do nothing.

- **Entry:** after 120+ bars, the close is up more than 40 bps over the
  trailing 60 bars AND more than 60 bps over the trailing 120 bars, on
  2 consecutive bars. 30-bar cooldown after an exit. No new entries
  once the batch sequence reaches 1380 (no room left for a fresh trade
  to earn its round-trip cost in a 1440-bar window).
- **Exits:** trailing stop 75 bps below the highest close since entry,
  hard stop 80 bps below the entry decision-bar close, or 480 bars held.
- **Size:** whole cash balance on a buy, whole position on a sell.
  Max slippage 50 bps per order.
- **Gaps:** a batch with no bar for the symbol is skipped (no history,
  no order). Flat bars are ordinary bars.

## Why this shape

On the dev window, 1-minute cbBTC is choppy with fast reversals after
sharp spikes, and a full-size round trip costs about 36 bps. Trend
crosses, dip-buying, and RSI scalps were all tested on the dev data and
all lost money after costs; the only durable edge was sustained
multi-hour strength, so the bot trades rarely (2 fills on the dev
window) and only then.

## Local verification

Replayed twice over the frozen dev window with an independent local
replay harness implementing the documented fill model (4 bps fee,
2 bps slippage, constant-product impact against each bar's open depth):

- Net PnL: **+$9.30** (9,304,065 micro-USDC), 2 trades, $0.80 fees,
  max drawdown 0.95%, 0 rejects.
- Hold-cash on the same harness: $0.00, 0 trades.
  Buy-and-hold: -$31.63, 1 trade, max drawdown 3.25%.
- Both runs produced byte-identical action logs (same sha256).

The race window is unseen by everyone; nothing here claims it will win.
