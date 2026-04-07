"use strict";

const express   = require("express");
const router    = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const autoTrade = require("./autoTrade");
const smcRoutes = require("./smc");

// ─── IST HH:MM:SS from any timestamp string/Date ─────────────────────────────
function toISTTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString("en-IN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true, timeZone: "Asia/Kolkata",
    });
  } catch { return null; }
}

// ─── Zerodha charges for NSE F&O options (matches Kite Console breakdown) ────
// Rates: https://zerodha.com/charges
function calcCharges(trades) {
  if (!trades || !trades.length) {
    return { brokerage: 0, stt: 0, txn: 0, clearing: 0, gst: 0, sebi: 0, stampDuty: 0, total: 0 };
  }
  const orderIds   = new Set();
  let buyTurnover  = 0;
  let sellTurnover = 0;
  for (const t of trades) {
    if (t.exchange !== "NFO") continue;
    const fillPrice = t.average_price || t.price || 0;
    const turnover  = fillPrice * (t.quantity || 0);
    orderIds.add(t.order_id);
    if (t.transaction_type === "BUY")  buyTurnover  += turnover;
    if (t.transaction_type === "SELL") sellTurnover += turnover;
  }
  const totalTurnover = buyTurnover + sellTurnover;

  // ₹20 per executed order (flat for F&O)
  const brokerage = orderIds.size * 20;
  // STT: 0.01% on sell-side premium only
  const stt       = sellTurnover * 0.0001;
  // NSE exchange transaction charge: 0.053% of total premium turnover
  const txn       = totalTurnover * 0.00053;
  // NSCCL clearing charge: 0.05% of total premium turnover (shown separately in Kite Console)
  const clearing  = totalTurnover * 0.0005;
  // SEBI turnover fee: ₹10 per crore = 0.000001
  const sebi      = totalTurnover * 0.000001;
  // GST 18% on all service charges (brokerage + exchange + clearing + SEBI)
  const gst       = (brokerage + txn + clearing + sebi) * 0.18;
  // Stamp duty: 0.003% on buy-side only
  const stampDuty = buyTurnover * 0.00003;

  const total = brokerage + stt + txn + clearing + gst + sebi + stampDuty;
  return {
    brokerage:  +brokerage.toFixed(2),
    stt:        +stt.toFixed(2),
    txn:        +txn.toFixed(2),
    clearing:   +clearing.toFixed(2),
    gst:        +gst.toFixed(2),
    sebi:       +sebi.toFixed(4),
    stampDuty:  +stampDuty.toFixed(2),
    total:      +total.toFixed(2),
  };
}

// ─── GET /api/account ─────────────────────────────────────────────────────────
router.get("/", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });

  try {
    const client = getClient();

    const [margins, positionsData, trades] = await Promise.all([
      client.getMargins().catch(() => null),
      client.getPositions().catch(() => ({ day: [], net: [] })),
      client.getTrades().catch(() => []),
    ]);

    // ── Build entry/exit time maps directly from trades fill_timestamp ────────
    // Keyed by tradingsymbol; entry = earliest BUY fill, exit = latest SELL fill
    const entryTimeMap = {};   // tradingsymbol → IST time string
    const exitTimeMap  = {};

    for (const t of trades) {
      const sym = t.tradingsymbol;
      const ts  = t.fill_timestamp || t.exchange_timestamp || t.order_timestamp;
      if (!sym || !ts) continue;

      if (t.transaction_type === "BUY") {
        // Keep earliest buy (first fill)
        if (!entryTimeMap[sym]) entryTimeMap[sym] = toISTTime(ts);
      } else if (t.transaction_type === "SELL") {
        // Keep latest sell (last fill = actual exit)
        exitTimeMap[sym] = toISTTime(ts);
      }
    }

    // ── Wallet ────────────────────────────────────────────────────────────────
    const eq = margins?.equity || {};
    const wallet = {
      available: +(eq.available?.live_balance ?? eq.net ?? 0).toFixed(2),
      used:      +(eq.utilised?.debits ?? 0).toFixed(2),
      net:       +(eq.net ?? 0).toFixed(2),
    };

    // ── Charges ───────────────────────────────────────────────────────────────
    const charges = calcCharges(trades);

    // ── P&L from day positions ────────────────────────────────────────────────
    const dayPositions  = positionsData.day || [];
    const realisedPnL   = dayPositions.reduce((s, p) => s + (p.realised   || 0), 0);
    const unrealisedPnL = dayPositions.reduce((s, p) => s + (p.unrealised || 0), 0);
    const pnl = {
      realised:   +realisedPnL.toFixed(2),
      unrealised: +unrealisedPnL.toFixed(2),
      total:      +(realisedPnL + unrealisedPnL).toFixed(2),
    };

    // ── Positions — merge Kite day data with autoTrade + SMC state ────────────
    const atPositions = autoTrade.getPositions();
    const smcAlerts   = smcRoutes.getAllAlerts?.() ?? [];

    const positions = dayPositions.map(p => {
      const at    = atPositions.find(a => a.tradingsymbol === p.tradingsymbol);
      const alert = at ? smcAlerts.find(a => a.id === at.alertId) : null;
      const sym   = p.tradingsymbol || "";
      const isOpen = p.quantity !== 0;

      return {
        tradingsymbol: sym,
        direction:     at?.direction ?? (sym.endsWith("CE") ? "CE" : "PE"),
        strike:        at?.strike ?? null,
        quantity:      p.day_buy_quantity || p.buy_quantity || 0,
        currentQty:    p.quantity,
        buyPrice:      +(p.buy_price  || p.average_price || 0).toFixed(2),
        sellPrice:     +(p.sell_price || 0).toFixed(2),
        currentPrice:  +(p.last_price || 0).toFixed(2),
        pnl:           +((p.realised || 0) + (p.unrealised || 0)).toFixed(2),
        realisedPnl:   +(p.realised   || 0).toFixed(2),
        unrealisedPnl: +(p.unrealised || 0).toFixed(2),
        status:        isOpen ? "OPEN" : "CLOSED",
        atStatus:      at?.status ?? null,
        // Times come from trades fill_timestamp — reliable regardless of server restart
        entryTime:     entryTimeMap[sym] ?? null,
        exitTime:      exitTimeMap[sym]  ?? null,
      };
    });

    res.json({ wallet, charges, pnl, positions });
  } catch (err) {
    console.error("[Account] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
