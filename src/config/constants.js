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
// Entry checkpoints, premium band, SL/Target, and daily trade cap are ALL
// defined below — this is the single source of truth for VWAP930 timing and
// premium filtering. Every other file (live scan, backtest, cron, Telegram
// messages, status display) must read these constants, never hardcode its
// own copy of a time or a premium number.
const VWAP930_MIN_PREMIUM = Number(process.env.VWAP930_MIN_PREMIUM) || 100; // 130;
const VWAP930_MAX_PREMIUM = Number(process.env.VWAP930_MAX_PREMIUM) || 150; // 150
const VWAP930_SL_PCT      = 8;   // stop loss  −8%
const VWAP930_TARGET_PCT  = 30;  // target     +30%
const VWAP930_NUM_LOTS    = 10;  // 10 lots, single entry per day
// Fixed entry checkpoints = every hour below × every minute below (e.g.
// [9,10] × [30,35,40,45,50,55] = 9:30, 9:35, ..., 9:55, 10:30, ..., 10:55).
// Checked in order, each a further try if the earlier ones found no
// qualifying CE/PE. Not a continuous window.
const VWAP930_ENTRY_HOUR    = [9, 10, 11, 12, 13, 14, 15];
const VWAP930_ENTRY_MINUTES = [30, 35, 40, 45, 50, 55];
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
// VWAP930_MAX_TRADES_PER_DAY) — a clean SL, or a stagnant timeout, both
// mean "that setup didn't work, try again"; TARGET/EOD/TIME_EXIT do not.
const VWAP930_REENTRY_STATUSES = ["SL", "STAGNANT_EXIT"];

module.exports = {
  LOT_SIZE, SENSEX_LOT_SIZE, NUM_LOTS, LOT_SIZES, getLotSize, EXCHANGE, PRODUCT,
  MIN_PREMIUM, MAX_PREMIUM, FALLBACK1_MIN, FALLBACK1_MAX, FALLBACK2_MIN, FALLBACK2_MAX, SWEET_SPOT,
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM, VWAP930_SL_PCT, VWAP930_TARGET_PCT,
  VWAP930_NUM_LOTS, VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MINUTES, VWAP930_MAX_TRADES_PER_DAY,
  VWAP930_STAGNANT_HOURS, VWAP930_STAGNANT_MAX_POINTS, VWAP930_REENTRY_STATUSES,
};
