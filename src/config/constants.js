// ─── Trading Constants ─────────────────────────────────────────────────────────
// Edit LOT_SIZE here — it is used everywhere (auto-trade entry, SL, exit orders)
const LOT_SIZE = 65;   // NIFTY lot size (1 lot = 65 shares)
const EXCHANGE = "NFO";
const PRODUCT  = "MIS"; // intraday

module.exports = { LOT_SIZE, EXCHANGE, PRODUCT };
