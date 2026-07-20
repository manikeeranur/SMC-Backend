"use strict";

// Pure SL/Target touch check shared between the cron/poll-driven P&L refresh
// and the tick-driven exit monitor, so the two paths can never disagree about
// whether a price has touched SL/Target. `targetField` lets callers use their
// own rr shape (SMC: "target2", VWAP930: "target").
function checkPriceTouch(rr, ltp, targetField = "target") {
  if (ltp <= rr.sl) return "SL";
  if (ltp >= rr[targetField]) return "TARGET";
  return null;
}

module.exports = { checkPriceTouch };
