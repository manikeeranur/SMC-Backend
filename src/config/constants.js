// ─── Trading Constants ─────────────────────────────────────────────────────────
// Edit lot sizes here — used everywhere (auto-trade entry, SL, exit orders, Telegram)
const LOT_SIZE        = 65; // NIFTY lot size  (1 lot = 65 shares)
const SENSEX_LOT_SIZE = 20; // SENSEX lot size (1 lot = 20 shares)

const LOT_SIZES = {
  NIFTY:  LOT_SIZE,
  SENSEX: SENSEX_LOT_SIZE,
};

function getLotSize(index) {
  return LOT_SIZES[(index || "").toUpperCase()] ?? LOT_SIZE;
}

const EXCHANGE = "NFO";
const PRODUCT  = "MIS"; // intraday

module.exports = { LOT_SIZE, SENSEX_LOT_SIZE, LOT_SIZES, getLotSize, EXCHANGE, PRODUCT };
