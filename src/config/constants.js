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
// Exact 09:30 IST entry only · CE/PE whose premium is ₹130–₹150 AND price is
// touching/above its own VWAP · single entry per day · Target +30% / SL −8%
const VWAP930_MIN_PREMIUM = Number(process.env.VWAP930_MIN_PREMIUM) || 130;
const VWAP930_MAX_PREMIUM = Number(process.env.VWAP930_MAX_PREMIUM) || 150;
const VWAP930_SL_PCT      = 8;   // stop loss  −8%
const VWAP930_TARGET_PCT  = 30;  // target     +30%
const VWAP930_NUM_LOTS    = 10;  // 10 lots, single entry per day
const VWAP930_ENTRY_HOUR  = 9;
const VWAP930_ENTRY_MIN   = 30;

module.exports = {
  LOT_SIZE, SENSEX_LOT_SIZE, NUM_LOTS, LOT_SIZES, getLotSize, EXCHANGE, PRODUCT,
  MIN_PREMIUM, MAX_PREMIUM, FALLBACK1_MIN, FALLBACK1_MAX, FALLBACK2_MIN, FALLBACK2_MAX, SWEET_SPOT,
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM, VWAP930_SL_PCT, VWAP930_TARGET_PCT,
  VWAP930_NUM_LOTS, VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MIN,
};
