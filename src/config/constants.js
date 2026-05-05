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

module.exports = {
  LOT_SIZE, SENSEX_LOT_SIZE, NUM_LOTS, LOT_SIZES, getLotSize, EXCHANGE, PRODUCT,
  MIN_PREMIUM, MAX_PREMIUM, FALLBACK1_MIN, FALLBACK1_MAX, FALLBACK2_MIN, FALLBACK2_MAX, SWEET_SPOT,
};
