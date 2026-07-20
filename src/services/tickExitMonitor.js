"use strict";

// Thin dispatcher wired into the KiteTicker "ticks" event (see
// websocket/ticker.js). For every tick, offers it to each strategy's
// O(1) token index — a cheap no-op for the vast majority of ticks/tokens
// that aren't part of an open auto-trade position.
function onTicks(ticks) {
  if (!Array.isArray(ticks) || !ticks.length) return;

  const smc      = require("../routes/smc");
  const vwap930  = require("../routes/vwap930");

  for (const tick of ticks) {
    const token = tick.instrument_token;
    const ltp   = tick.last_price;
    if (!token || !ltp) continue;
    smc.handleTick(token, ltp);
    vwap930.handleTick(token, ltp);
  }
}

module.exports = { onTicks };
