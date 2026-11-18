// cbBTC 1-minute trend rider for agent-fun/bars-replay/v1.
//
// Idea, derived from the dev window in this kit: 1-minute cbBTC is choppy
// and mean-reverting after sharp spikes, so chasing moves and buying dips
// both lose to the ~36 bps round-trip cost. The only durable edge found
// was sustained multi-hour strength: when the trailing 60-bar and 120-bar
// returns are both clearly positive, the next hours keep drifting up often
// enough to pay for the trade. The bot therefore waits in cash, enters
// all-in only on confirmed sustained strength, rides it with a wide
// trailing stop, and otherwise does nothing. Few trades, tight risk.
//
// Rules (all comparisons in exact integer arithmetic on price-scale
// integers, so two runs on the same bars decide identically):
//   - entry: 120+ bars seen, close up >40 bps over 60 bars AND >60 bps
//     over 120 bars, on 2 consecutive bars; 30-bar cooldown after an exit;
//     no new entries once the batch seq reaches 1380 (a 1440-bar window
//     leaves no room for a fresh trade to earn its costs).
//   - size: the whole cash balance on a buy, the whole position on a sell.
//   - exits: close 75 bps below the highest close since entry (trailing
//     stop), close 80 bps below the entry decision-bar close (hard stop),
//     or 480 bars held (time stop).
//   - a batch with no bar for the symbol (a missing minute) is skipped:
//     no history is recorded and no order is sent. Flat bars are ordinary
//     bars. No clock, no randomness, no environment, no files.

import { runBars } from './vendor/makefun-bars.ts';

const BPS = 10000n;
// Entry thresholds, in bps over the stated lookbacks.
const FAST_LOOKBACK = 60;
const FAST_MIN_BPS = 40n;
const SLOW_LOOKBACK = 120;
const SLOW_MIN_BPS = 60n;
const CONFIRM_BARS = 2;
// Risk controls.
const TRAIL_BPS = 75n;
const HARD_STOP_BPS = 80n;
const MAX_HOLD_BARS = 480;
const COOLDOWN_BARS = 30;
// A fresh trade needs room to earn its round-trip cost before the window
// ends; the window is 1440 bars, so stop entering near its end.
const LAST_ENTRY_SEQ = 1380;
// Worst open-vs-previous-close gap seen in the dev window was ~18 bps;
// 50 bps covers the gap plus modelled slippage and impact with margin.
const MAX_SLIPPAGE_BPS = 50;

const closes: bigint[] = [];
let confirmStreak = 0;
let cooldownUntilBar = -1;
let barsSeen = 0;
let entryClose: bigint | null = null;
let peakClose: bigint | null = null;
let barsHeld = 0;

function aboveBy(close: bigint, ref: bigint, bps: bigint): boolean {
  return close * BPS > ref * (BPS + bps);
}

function belowBy(close: bigint, ref: bigint, bps: bigint): boolean {
  return close * BPS < ref * (BPS - bps);
}

// Sustained strength: clearly up over both a 1-hour and a 2-hour lookback.
function isSustainedStrength(history: readonly bigint[]): boolean {
  const now = history[history.length - 1]!;
  const fast = history[history.length - 1 - FAST_LOOKBACK]!;
  const slow = history[history.length - 1 - SLOW_LOOKBACK]!;
  return aboveBy(now, fast, FAST_MIN_BPS) && aboveBy(now, slow, SLOW_MIN_BPS);
}

// Any exit trigger: trailing stop, hard stop, or time stop.
function shouldExit(close: bigint, entry: bigint, peak: bigint, held: number): boolean {
  return belowBy(close, peak, TRAIL_BPS) || belowBy(close, entry, HARD_STOP_BPS) || held >= MAX_HOLD_BARS;
}

await runBars({
  onBatch(state, batch) {
    const symbol = state.hello.symbols[0]!.symbol;
    const bar = batch.bars.find((b) => b.symbol === symbol);
    if (bar === undefined) return [];
    const close = BigInt(bar.c);
    closes.push(close);
    barsSeen += 1;

    const held = state.positions.get(symbol)?.qty ?? 0n;
    if (held === 0n) {
      // Flat: any entry reference from a rejected buy is stale.
      entryClose = null;
      peakClose = null;
      barsHeld = 0;
    } else {
      if (entryClose === null || peakClose === null) {
        entryClose = close;
        peakClose = close;
      } else if (close > peakClose) {
        peakClose = close;
      }
      barsHeld += 1;
    }

    if (state.warmingUp) return [];

    if (held > 0n) {
      confirmStreak = 0;
      if (shouldExit(close, entryClose!, peakClose!, barsHeld)) {
        cooldownUntilBar = barsSeen + COOLDOWN_BARS;
        return [{ side: 'sell', symbol, qty: held, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: look for confirmed sustained strength.
    if (barsSeen < SLOW_LOOKBACK + 1) return [];
    if (state.seq >= LAST_ENTRY_SEQ) return [];
    if (barsSeen < cooldownUntilBar) return [];
    const strong = isSustainedStrength(closes);
    confirmStreak = strong ? confirmStreak + 1 : 0;
    if (confirmStreak < CONFIRM_BARS) return [];
    const cash = state.cash;
    const minNotional = BigInt(state.hello.fees.min_notional_quote_units);
    if (cash < minNotional) return [];
    confirmStreak = 0;
    entryClose = closes[closes.length - 1]!;
    peakClose = entryClose;
    barsHeld = 0;
    return [{ side: 'buy', symbol, notional_quote_units: cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
  },
});
