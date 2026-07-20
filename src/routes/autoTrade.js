"use strict";

const express = require("express");
const router  = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const { sendAutoTradeStarted, sendAutoTradeStopped, sendAutoTradeOrder } = require("../services/telegramService");
const { LOT_SIZE, NUM_LOTS, EXCHANGE, PRODUCT } = require("../config/constants");
const settingsService = require("../services/settingsService");

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

  const defaults = settingsService.getCached().accountDefaults;
  const orderQty = LOT_SIZE * (defaults.quantity ?? NUM_LOTS);
  const product  = defaults.productType ?? PRODUCT;
  const isPaper  = defaults.tradingMode === "PAPER";

  // Account-tab defaults override the strategy's own %-based SL/Target,
  // in place on the shared alert.rr object — this is the same object the
  // exit-check logic (cron poll today, tick monitor going forward) reads,
  // so no extra propagation is needed.
  if (defaults.stopLoss != null) rr.sl = +(rr.entry - defaults.stopLoss).toFixed(2);
  if (defaults.target   != null) rr.target2 = +(rr.entry + defaults.target).toFixed(2);

  // ── Dedup guard: never place two orders for the same alertId ─────────────────
  if (positions.some(p => p.alertId === alertId)) {
    console.warn(`[AutoTrade] Duplicate entry blocked — ${alertId} already tracked`);
    return;
  }

  const sym = leg.tradingsymbol;

  const pos = {
    alertId,
    tradingsymbol: sym,
    strike:        leg.strike,
    direction:     alert.direction,
    token:         leg.token,
    entryOrderId:  null,
    slOrderId:     null,
    exitOrderId:   null,
    status:        "PENDING",
    rr,
    logs:          [],
  };
  positions.unshift(pos);

  // ── PAPER mode: simulate the fill, never touch the broker ────────────────────
  if (isPaper) {
    pos.entryOrderId = `PAPER-${Date.now()}`;
    pos.slOrderId    = `PAPER-SL-${Date.now()}`;
    pos.status = "ACTIVE";
    log(alertId, `[PAPER] Simulated entry — ${sym} BUY ${orderQty} @ ₹${rr.entry}, SL trigger ₹${rr.sl}`);
    sendAutoTradeOrder(pos, "ENTRY");
    require("../websocket/ticker").subscribeTokens([leg.token]);
    return;
  }

  // ── Kite position guard: check if we already hold this symbol ────────────────
  try {
    const { net } = await getClient().getPositions();
    const already = (net || []).some(
      p => p.tradingsymbol === leg.tradingsymbol && Math.abs(p.quantity) > 0
    );
    if (already) {
      console.warn(`[AutoTrade] Entry blocked — open Kite position already exists for ${leg.tradingsymbol}`);
      pos.status = "ERROR";
      return;
    }
  } catch (e) {
    console.warn(`[AutoTrade] Could not check Kite positions — ${e.message}. Proceeding.`);
  }

  try {
    // 1. Market BUY
    const entryResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol:     sym,
      transaction_type:  "BUY",
      quantity:          orderQty,
      product:           product,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "ALGO_ENTRY",
    });
    pos.entryOrderId = entryResp.order_id;
    pos.status = "ENTRY_PLACED";
    log(alertId, `Entry order placed — ${sym} BUY ${orderQty} @ MARKET  [order_id: ${entryResp.order_id}]`);

    // 2. SL-M SELL at rr.sl
    const slResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol:     sym,
      transaction_type:  "SELL",
      quantity:          orderQty,
      product:           product,
      order_type:        "SL-M",
      trigger_price:     rr.sl,
      validity:          "DAY",
      market_protection: 1,
      tag:               "ALGO_SL",
    });
    pos.slOrderId = slResp.order_id;
    pos.status = "ACTIVE";
    log(alertId, `SL order placed — trigger ₹${rr.sl}  [order_id: ${slResp.order_id}]`);
    sendAutoTradeOrder(pos, "ENTRY");
    require("../websocket/ticker").subscribeTokens([leg.token]);

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

  // Resolve tradingsymbol — from memory, alert.leg, or alert.tradingsymbol (MongoDB restored)
  const tradingsymbol = pos?.tradingsymbol
    ?? alert.leg?.tradingsymbol
    ?? alert.tradingsymbol;
  if (!tradingsymbol) {
    console.warn(`[AutoTrade] Exit skipped — no tradingsymbol for ${alert.id}`);
    return;
  }

  // Post-restart safety net: with no in-memory `pos` we can't tell whether this
  // position's entry was ever really sent to the broker. If the app is
  // currently in PAPER mode, never risk placing a real order for it.
  if (!pos && settingsService.getCached().accountDefaults.tradingMode === "PAPER") {
    console.log(`[AutoTrade] [PAPER] Simulated exit (post-restart) — ${tradingsymbol} ${alert.status}`);
    return;
  }

  // Mark pos early to prevent double-exit if executeExit fires twice
  if (pos) pos.status = "EXITING";

  // ── PAPER mode: this position was simulated at entry — simulate the exit too
  if (pos?.entryOrderId?.startsWith("PAPER-")) {
    pos.exitOrderId = `PAPER-EXIT-${Date.now()}`;
    pos.status = `EXITED_${alert.status}`;
    log(pos.alertId, `[PAPER] Simulated exit — ${alert.status}`);
    sendAutoTradeOrder(pos, "EXIT");
    return;
  }

  const defaults = settingsService.getCached().accountDefaults;
  const orderQty = LOT_SIZE * (defaults.quantity ?? NUM_LOTS);
  const product  = defaults.productType ?? PRODUCT;

  try {
    // Cancel the pending SL order — by stored ID if available, else search Kite orders
    let slAlreadyExecuted = false;

    if (pos?.slOrderId) {
      try {
        await getClient().cancelOrder("regular", pos.slOrderId);
        log(pos.alertId, `SL order cancelled [${pos.slOrderId}]`);
      } catch (e) {
        // Cancel failed — check if SL-M already executed (position closed by Kite)
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
      // Post-restart: no slOrderId — find and cancel any open SL-M for this symbol
      try {
        const allOrders = await getClient().getOrders();
        const openSLMs  = allOrders.filter(o =>
          o.tradingsymbol    === tradingsymbol &&
          o.order_type       === "SL-M" &&
          o.transaction_type === "SELL" &&
          (o.status === "TRIGGER PENDING" || o.status === "OPEN")
        );
        // If no open SL-M found, check if one already completed (position closed by Kite)
        if (!openSLMs.length) {
          const completedSLM = allOrders.find(o =>
            o.tradingsymbol    === tradingsymbol &&
            o.order_type       === "SL-M" &&
            o.transaction_type === "SELL" &&
            o.status           === "COMPLETE"
          );
          if (completedSLM) {
            slAlreadyExecuted = true;
            console.log(`[AutoTrade] SL-M already executed — skipping MARKET SELL for ${tradingsymbol} [${completedSLM.order_id}]`);
          }
        }
        for (const o of openSLMs) {
          await getClient().cancelOrder(o.variety || "regular", o.order_id)
            .catch(e => console.warn(`[AutoTrade] SL-M cancel warn [${o.order_id}] — ${e.message}`));
          console.log(`[AutoTrade] Cancelled open SL-M [${o.order_id}] for ${tradingsymbol}`);
        }
      } catch (e) {
        console.warn(`[AutoTrade] Could not query orders for SL-M cancel — ${e.message}`);
      }
    }

    // If SL-M already executed, position is closed by Kite — no MARKET SELL needed
    if (slAlreadyExecuted) {
      if (pos) {
        pos.status = `EXITED_${alert.status}`;
        log(pos.alertId, `Position already closed by SL-M — marked ${pos.status}`);
        sendAutoTradeOrder(pos, "EXIT");
      }
      return;
    }

    // Place MARKET SELL to exit
    const exitResp = await getClient().placeOrder("regular", {
      exchange:          EXCHANGE,
      tradingsymbol,
      transaction_type:  "SELL",
      quantity:          orderQty,
      product:           product,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "ALGO_EXIT",
    });

    if (pos) {
      pos.exitOrderId = exitResp.order_id;
      pos.status = `EXITED_${alert.status}`;
      log(pos.alertId, `Exit order placed — ${alert.status}  [order_id: ${exitResp.order_id}]`);
      sendAutoTradeOrder(pos, "EXIT");
    } else {
      console.log(`[AutoTrade] Exit order placed (post-restart) — ${tradingsymbol} ${alert.status}  [order_id: ${exitResp.order_id}]`);
    }

  } catch (err) {
    if (pos) {
      pos.status = "ERROR";
      log(pos.alertId, `Exit failed — ${err.message}`);
    } else {
      console.error(`[AutoTrade] Exit failed (post-restart) — ${tradingsymbol}: ${err.message}`);
    }
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/auto-trade/status
router.get("/status", (req, res) => {
  res.json({ enabled, positions });
});

// POST /api/auto-trade/enable
router.post("/enable", async (req, res) => {
  try {
    await settingsService.setAutoTradeEnabled("smc", true);
  } catch (err) {
    return res.status(500).json({ error: `Failed to persist enable state: ${err.message}` });
  }
  enabled = true;
  console.log("[AutoTrade] ✅ Enabled");
  sendAutoTradeStarted();
  res.json({ enabled });
});

// POST /api/auto-trade/disable
router.post("/disable", async (req, res) => {
  try {
    await settingsService.setAutoTradeEnabled("smc", false);
  } catch (err) {
    return res.status(500).json({ error: `Failed to persist disable state: ${err.message}` });
  }
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

module.exports             = router;
module.exports.executeEntry = executeEntry;
module.exports.executeExit  = executeExit;
module.exports.isEnabled    = () => enabled;
module.exports.getPositions = () => positions;
module.exports.setEnabled   = (v) => { enabled = v; };
