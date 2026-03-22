"use strict";

const express = require("express");
const router  = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const { sendAutoTradeStarted, sendAutoTradeStopped, sendAutoTradeOrder } = require("../services/telegramService");

// ─── Constants ────────────────────────────────────────────────────────────────
const LOT_SIZE = 65;   // NIFTY lot size
const EXCHANGE = "NFO";
const PRODUCT  = "MIS"; // intraday

// ─── State ────────────────────────────────────────────────────────────────────
let enabled   = false;
let positions = [];   // { alertId, tradingsymbol, entryOrderId, slOrderId, exitOrderId, status, logs[] }

function log(alertId, msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`[AutoTrade] [${alertId}] ${msg}`);
  const pos = positions.find(p => p.alertId === alertId);
  if (pos) pos.logs.push(`${ts} — ${msg}`);
}

// ─── Place entry (MARKET BUY) + SL (SL-M SELL) ───────────────────────────────
async function executeEntry(alert) {
  if (!enabled) return;
  if (!isAuthenticated()) { console.warn("[AutoTrade] Not authenticated — skipping"); return; }

  const { id: alertId, leg, rr } = alert;
  if (!leg?.tradingsymbol) { console.warn("[AutoTrade] No tradingsymbol on leg — skipping"); return; }

  const sym = leg.tradingsymbol;

  const pos = {
    alertId,
    tradingsymbol: sym,
    strike:        leg.strike,
    direction:     alert.direction,
    entryOrderId:  null,
    slOrderId:     null,
    exitOrderId:   null,
    status:        "PENDING",
    rr,
    logs:          [],
  };
  positions.unshift(pos);

  try {
    // 1. Market BUY
    const entryResp = await getClient().placeOrder("regular", {
      exchange:         EXCHANGE,
      tradingsymbol:    sym,
      transaction_type: "BUY",
      quantity:         LOT_SIZE,
      product:          PRODUCT,
      order_type:       "MARKET",
      validity:         "DAY",
      tag:              "ALGO_ENTRY",
    });
    pos.entryOrderId = entryResp.order_id;
    pos.status = "ENTRY_PLACED";
    log(alertId, `Entry order placed — ${sym} BUY 75 @ MARKET  [order_id: ${entryResp.order_id}]`);

    // 2. SL-M SELL at rr.sl
    const slResp = await getClient().placeOrder("regular", {
      exchange:         EXCHANGE,
      tradingsymbol:    sym,
      transaction_type: "SELL",
      quantity:         LOT_SIZE,
      product:          PRODUCT,
      order_type:       "SL-M",
      trigger_price:    rr.sl,
      validity:         "DAY",
      tag:              "ALGO_SL",
    });
    pos.slOrderId = slResp.order_id;
    pos.status = "ACTIVE";
    log(alertId, `SL order placed — trigger ₹${rr.sl}  [order_id: ${slResp.order_id}]`);
    sendAutoTradeOrder(pos, "ENTRY");

  } catch (err) {
    pos.status = "ERROR";
    log(alertId, `Order failed — ${err.message}`);
    sendAutoTradeOrder(pos, "ERROR");
  }
}

// ─── Exit: cancel SL + place MARKET SELL ─────────────────────────────────────
async function executeExit(alert) {
  if (!isAuthenticated()) return;

  const pos = positions.find(p => p.alertId === alert.id && p.status === "ACTIVE");
  if (!pos) return;  // not tracked or already exited

  // If SL hit by Kite itself — just mark exited (no need to place another sell)
  if (alert.status === "SL") {
    pos.status = "EXITED_SL";
    log(pos.alertId, `SL hit — Kite SL-M order already executed`);
    return;
  }

  try {
    // Cancel the pending SL order
    if (pos.slOrderId) {
      try {
        await getClient().cancelOrder("regular", pos.slOrderId);
        log(pos.alertId, `SL order cancelled [${pos.slOrderId}]`);
      } catch (e) {
        log(pos.alertId, `SL cancel warning — ${e.message} (may already be executed)`);
      }
    }

    // Place MARKET SELL to exit
    const exitResp = await getClient().placeOrder("regular", {
      exchange:         EXCHANGE,
      tradingsymbol:    pos.tradingsymbol,
      transaction_type: "SELL",
      quantity:         LOT_SIZE,
      product:          PRODUCT,
      order_type:       "MARKET",
      validity:         "DAY",
      tag:              "ALGO_EXIT",
    });
    pos.exitOrderId = exitResp.order_id;
    pos.status = `EXITED_${alert.status}`;
    log(pos.alertId, `Exit order placed — ${alert.status}  [order_id: ${exitResp.order_id}]`);
    sendAutoTradeOrder(pos, "EXIT");

  } catch (err) {
    log(pos.alertId, `Exit failed — ${err.message}`);
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/auto-trade/status
router.get("/status", (req, res) => {
  res.json({ enabled, positions });
});

// POST /api/auto-trade/enable
router.post("/enable", (req, res) => {
  enabled = true;
  console.log("[AutoTrade] ✅ Enabled");
  sendAutoTradeStarted();
  res.json({ enabled });
});

// POST /api/auto-trade/disable
router.post("/disable", (req, res) => {
  enabled = false;
  console.log("[AutoTrade] ❌ Disabled");
  sendAutoTradeStopped();
  res.json({ enabled });
});

// DELETE /api/auto-trade/positions  (clear history)
router.delete("/positions", (req, res) => {
  positions = [];
  res.json({ cleared: true });
});

module.exports        = router;
module.exports.executeEntry = executeEntry;
module.exports.executeExit  = executeExit;
module.exports.isEnabled    = () => enabled;
