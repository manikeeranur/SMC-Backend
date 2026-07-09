"use strict";

const express = require("express");
const router  = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const {
  sendVwap930AutoTradeStarted, sendVwap930AutoTradeStopped, sendVwap930AutoTradeOrder,
} = require("../services/vwap930Telegram");
const { LOT_SIZE, VWAP930_NUM_LOTS, EXCHANGE, PRODUCT } = require("../config/constants");
const ORDER_QTY = LOT_SIZE * VWAP930_NUM_LOTS;

// ─── State — independent from the SMC auto-trade engine ─────────────────────
let enabled   = false;
let positions = [];   // { alertId, tradingsymbol, entryOrderId, slOrderId, exitOrderId, status, logs[] }

function log(alertId, msg) {
  const ts = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata" });
  console.log(`[VWAP930 AutoTrade] [${alertId}] ${msg}`);
  const pos = positions.find(p => p.alertId === alertId);
  if (pos) pos.logs.push(`${ts} — ${msg}`);
}

// ─── Place entry (MARKET BUY) + SL (SL-M SELL) ───────────────────────────────
async function executeEntry(alert) {
  if (!enabled) return;
  if (!isAuthenticated()) { console.warn("[VWAP930 AutoTrade] Not authenticated — skipping"); return; }

  const { id: alertId, leg, rr } = alert;
  if (!leg?.tradingsymbol) { console.warn("[VWAP930 AutoTrade] No tradingsymbol on leg — skipping"); return; }

  if (positions.some(p => p.alertId === alertId)) {
    console.warn(`[VWAP930 AutoTrade] Duplicate entry blocked — ${alertId} already tracked`);
    return;
  }

  try {
    const { net } = await getClient().getPositions();
    const already = (net || []).some(
      p => p.tradingsymbol === leg.tradingsymbol && Math.abs(p.quantity) > 0
    );
    if (already) {
      console.warn(`[VWAP930 AutoTrade] Entry blocked — open Kite position already exists for ${leg.tradingsymbol}`);
      return;
    }
  } catch (e) {
    console.warn(`[VWAP930 AutoTrade] Could not check Kite positions — ${e.message}. Proceeding.`);
  }

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
    const entryResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol:     sym,
      transaction_type:  "BUY",
      quantity:          ORDER_QTY,
      product:           PRODUCT,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "VWAP930_ENTRY",
    });
    pos.entryOrderId = entryResp.order_id;
    pos.status = "ENTRY_PLACED";
    log(alertId, `Entry order placed — ${sym} BUY ${ORDER_QTY} (${VWAP930_NUM_LOTS} lot${VWAP930_NUM_LOTS > 1 ? "s" : ""}) @ MARKET  [order_id: ${entryResp.order_id}]`);

    const slResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol:     sym,
      transaction_type:  "SELL",
      quantity:          ORDER_QTY,
      product:           PRODUCT,
      order_type:        "SL-M",
      trigger_price:     rr.sl,
      validity:          "DAY",
      market_protection: 1,
      tag:               "VWAP930_SL",
    });
    pos.slOrderId = slResp.order_id;
    pos.status = "ACTIVE";
    log(alertId, `SL order placed — trigger ₹${rr.sl}  [order_id: ${slResp.order_id}]`);
    sendVwap930AutoTradeOrder(pos, "ENTRY");

  } catch (err) {
    pos.status = "ERROR";
    log(alertId, `Order failed — ${err.message}`);
    sendVwap930AutoTradeOrder(pos, "ERROR");
  }
}

// ─── Exit: cancel SL + place MARKET SELL ─────────────────────────────────────
async function executeExit(alert) {
  if (!isAuthenticated()) return;

  const pos = positions.find(p => p.alertId === alert.id && p.status === "ACTIVE");

  const tradingsymbol = pos?.tradingsymbol
    ?? alert.leg?.tradingsymbol
    ?? alert.tradingsymbol;
  if (!tradingsymbol) {
    console.warn(`[VWAP930 AutoTrade] Exit skipped — no tradingsymbol for ${alert.id}`);
    return;
  }

  if (pos) pos.status = "EXITING";

  try {
    let slAlreadyExecuted = false;

    if (pos?.slOrderId) {
      try {
        await getClient().cancelOrder("regular", pos.slOrderId);
        log(pos.alertId, `SL order cancelled [${pos.slOrderId}]`);
      } catch (e) {
        try {
          const history = await getClient().getOrderHistory(pos.slOrderId);
          const lastStatus = history?.[history.length - 1]?.status;
          if (lastStatus === "COMPLETE") {
            slAlreadyExecuted = true;
            log(pos.alertId, `SL-M already executed — skipping MARKET SELL [${pos.slOrderId}]`);
          } else {
            log(pos.alertId, `SL cancel warning — ${e.message} (status: ${lastStatus})`);
          }
        } catch {
          log(pos.alertId, `SL cancel warning — ${e.message} (may already be executed)`);
        }
      }
    } else {
      try {
        const allOrders = await getClient().getOrders();
        const openSLMs  = allOrders.filter(o =>
          o.tradingsymbol    === tradingsymbol &&
          o.order_type       === "SL-M" &&
          o.transaction_type === "SELL" &&
          (o.status === "TRIGGER PENDING" || o.status === "OPEN")
        );
        if (!openSLMs.length) {
          const completedSLM = allOrders.find(o =>
            o.tradingsymbol    === tradingsymbol &&
            o.order_type       === "SL-M" &&
            o.transaction_type === "SELL" &&
            o.status           === "COMPLETE"
          );
          if (completedSLM) {
            slAlreadyExecuted = true;
            console.log(`[VWAP930 AutoTrade] SL-M already executed — skipping MARKET SELL for ${tradingsymbol} [${completedSLM.order_id}]`);
          }
        }
        for (const o of openSLMs) {
          await getClient().cancelOrder(o.variety || "regular", o.order_id)
            .catch(e => console.warn(`[VWAP930 AutoTrade] SL-M cancel warn [${o.order_id}] — ${e.message}`));
          console.log(`[VWAP930 AutoTrade] Cancelled open SL-M [${o.order_id}] for ${tradingsymbol}`);
        }
      } catch (e) {
        console.warn(`[VWAP930 AutoTrade] Could not query orders for SL-M cancel — ${e.message}`);
      }
    }

    if (slAlreadyExecuted) {
      if (pos) {
        pos.status = `EXITED_${alert.status}`;
        log(pos.alertId, `Position already closed by SL-M — marked ${pos.status}`);
        sendVwap930AutoTradeOrder(pos, "EXIT");
      }
      return;
    }

    const exitResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol,
      transaction_type:  "SELL",
      quantity:          ORDER_QTY,
      product:           PRODUCT,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "VWAP930_EXIT",
    });

    if (pos) {
      pos.exitOrderId = exitResp.order_id;
      pos.status = `EXITED_${alert.status}`;
      log(pos.alertId, `Exit order placed — ${alert.status}  [order_id: ${exitResp.order_id}]`);
      sendVwap930AutoTradeOrder(pos, "EXIT");
    } else {
      console.log(`[VWAP930 AutoTrade] Exit order placed (post-restart) — ${tradingsymbol} ${alert.status}  [order_id: ${exitResp.order_id}]`);
    }

  } catch (err) {
    if (pos) {
      pos.status = "ERROR";
      log(pos.alertId, `Exit failed — ${err.message}`);
    } else {
      console.error(`[VWAP930 AutoTrade] Exit failed (post-restart) — ${tradingsymbol}: ${err.message}`);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

router.get("/status", (req, res) => {
  res.json({ enabled, positions });
});

router.post("/enable", (req, res) => {
  enabled = true;
  console.log("[VWAP930 AutoTrade] ✅ Enabled");
  sendVwap930AutoTradeStarted();
  res.json({ enabled });
});

router.post("/disable", (req, res) => {
  enabled = false;
  console.log("[VWAP930 AutoTrade] ❌ Disabled");
  sendVwap930AutoTradeStopped();
  res.json({ enabled });
});

router.delete("/positions", (req, res) => {
  positions = [];
  res.json({ cleared: true });
});

module.exports              = router;
module.exports.executeEntry = executeEntry;
module.exports.executeExit  = executeExit;
module.exports.isEnabled    = () => enabled;
module.exports.getPositions = () => positions;
