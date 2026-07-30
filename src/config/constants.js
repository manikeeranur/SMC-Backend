// ─── Trading Constants ─────────────────────────────────────────────────────────
// Edit lot sizes here — used everywhere (auto-trade entry, SL, exit orders, Telegram)
const LOT_SIZE        = 65; // NIFTY lot size  (1 lot = 65 shares)
const SENSEX_LOT_SIZE = 20; // SENSEX lot size (1 lot = 20 shares)
const NUM_LOTS        = 10; // ← change this to trade multiple lots (e.g. 10 = 650 qty)

// ← change MIN_PREMIUM / MAX_PREMIUM here to update alert range everywhere
const MIN_PREMIUM = Number(process.env.MIN_PREMIUM) || 200;
const MAX_PREMIUM = Number(process.env.MAX_PREMIUM) || 300;


const LOT_SIZES = {
  NIFTY:  LOT_SIZE,
  SENSEX: SENSEX_LOT_SIZE,
};

function getLotSize(index) {
  return LOT_SIZES[(index || "").toUpperCase()] ?? LOT_SIZE;
}

const EXCHANGE = "NFO";
const PRODUCT  = "MIS"; // intraday

// ─── Premium Filter ────────────────────────────────────────────────────────────

const FALLBACK1_MIN = Math.round(MIN_PREMIUM * 0.75);
const FALLBACK1_MAX = Math.round(MAX_PREMIUM * 1.75);
const FALLBACK2_MIN = Math.round(MIN_PREMIUM * 0.50);
const FALLBACK2_MAX = Math.round(MAX_PREMIUM * 2.00);
const SWEET_SPOT    = Math.round((MIN_PREMIUM + MAX_PREMIUM) / 2);

// ─── VWAP 9:30 Strategy ─────────────────────────────────────────────────────────
// Premium band, SL/Target, and daily trade cap are ALL defined below — this
// is the single source of truth for VWAP930 timing and premium filtering.
// Every other file (live scan, backtest, cron, Telegram messages, status
// display) must read these constants, never hardcode its own copy of a time
// or a premium number.
//
// No fixed entry checkpoints — the live cron (index.js) re-checks every
// minute across VWAP930_ENTRY_HOUR, but a signal only actually fires once a
// CE/PE's own VWAP930_CANDLE_MINUTES-minute candle CLOSES strictly above that
// candle's VWAP, and never before VWAP930_ENTRY_START_HOUR:VWAP930_ENTRY_START_MINUTE
// IST. SL/Target below are unchanged. The one extra rule: the moment an
// ACTIVE trade's own VWAP930_CANDLE_MINUTES-minute candle CLOSES below its
// VWAP, exit immediately — do not wait for SL/Target (see
// checkVwapCloseExit() in vwap930Service.js).
const VWAP930_MIN_PREMIUM = Number(process.env.VWAP930_MIN_PREMIUM) || 200; // 130;
const VWAP930_MAX_PREMIUM = Number(process.env.VWAP930_MAX_PREMIUM) || 300; // 150
const VWAP930_SL_PCT      = 8;   // stop loss  −8%
const VWAP930_TARGET_PCT  = 8;   // target     +8%
const VWAP930_NUM_LOTS    = 10;  // 10 lots, single entry per day
const VWAP930_CANDLE_MINUTES     = 5;  // candle size used for entry confirmation + close-below-VWAP exit
const VWAP930_ENTRY_HOUR         = [9, 10, 11, 12, 13, 14, 15]; // hours the live cron scans (index.js)
const VWAP930_ENTRY_START_HOUR   = 9;  // no entries before this hour:minute IST
const VWAP930_ENTRY_START_MINUTE = 30;
// At most this many entries per day: the 1st at whichever checkpoint first
// qualifies, and — only if that one exits with a status in
// VWAP930_REENTRY_STATUSES before the checkpoints run out — a re-entry at
// the next qualifying checkpoint. Any other exit reason (TARGET/EOD/
// TIME_EXIT), or reaching this cap, ends the day with no further entries.
// Shared by both live (vwap930.js) and backtest (vwap930Service.js) so they
// can never drift apart.
const VWAP930_MAX_TRADES_PER_DAY = 10;
// Force-exit a still-open position once it's been open this many hours AND
// its peak favorable move (peakMove) has never reached this many points —
// i.e. the trade has gone nowhere, so cut it loose instead of waiting for
// SL/Target/3:20 PM square-off. Checked live (updateAlertPnL) and mirrored
// in backtest (resolveOutcome) so both agree.
const VWAP930_STAGNANT_HOURS      = 2;
const VWAP930_STAGNANT_MAX_POINTS = 20;
// Exit statuses that are allowed to trigger a re-entry (up to
// VWAP930_MAX_TRADES_PER_DAY) — a clean SL, a stagnant timeout, or an early
// VWAP-close exit all mean "that setup didn't work, try again"; TARGET/EOD/
// TIME_EXIT do not.
const VWAP930_REENTRY_STATUSES = ["SL", "STAGNANT_EXIT", "VWAP_EXIT"];

module.exports = {
  LOT_SIZE, SENSEX_LOT_SIZE, NUM_LOTS, LOT_SIZES, getLotSize, EXCHANGE, PRODUCT,
  MIN_PREMIUM, MAX_PREMIUM, FALLBACK1_MIN, FALLBACK1_MAX, FALLBACK2_MIN, FALLBACK2_MAX, SWEET_SPOT,
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM, VWAP930_SL_PCT, VWAP930_TARGET_PCT,
  VWAP930_NUM_LOTS, VWAP930_ENTRY_HOUR, VWAP930_CANDLE_MINUTES,
  VWAP930_ENTRY_START_HOUR, VWAP930_ENTRY_START_MINUTE, VWAP930_MAX_TRADES_PER_DAY,
  VWAP930_STAGNANT_HOURS, VWAP930_STAGNANT_MAX_POINTS, VWAP930_REENTRY_STATUSES,
};
