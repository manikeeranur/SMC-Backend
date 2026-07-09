"use strict";

const express        = require("express");
const router         = express.Router();
const Alert          = require("../models/Alert");
const BacktestResult = require("../models/BacktestResult");
const Vwap930Alert         = require("../models/Vwap930Alert");
const Vwap930BacktestResult = require("../models/Vwap930BacktestResult");
const { isConnected } = require("../config/db");

// ── Pick the right pair of Mongo models for the requested strategy ───────────
function modelsFor(strategy) {
  return strategy === "vwap930"
    ? { AlertModel: Vwap930Alert, BacktestModel: Vwap930BacktestResult }
    : { AlertModel: Alert,        BacktestModel: BacktestResult };
}

// ── Normalize a stored alert/backtest doc into the shared row shape ──────────
// VWAP 9:30 only has a single target (no T1/T2, no concepts) — map its target
// into both Target1/Target2 slots and its VWAP value into Concepts so the
// existing SMC-shaped table/journal UI can render it without any changes.
function mapRow(a, strategy) {
  const isVwap = strategy === "vwap930";
  const target1 = isVwap ? a.rr?.target : a.rr?.target1;
  const target2 = isVwap ? a.rr?.target : a.rr?.target2;
  const t1Hit   = isVwap ? a.status === "TARGET" : !!a.t1Hit;

  return {
    EntryTime:  a.entryTime ?? "",
    ExitTime:   a.exitTime  ?? "",
    Direction:  a.direction ?? "",
    Strike:     String(a.strike ?? ""),
    Entry:      String(a.rr?.entry?.toFixed(2) ?? ""),
    SL:         String(a.rr?.sl?.toFixed(2)    ?? ""),
    Target1:    String(target1?.toFixed(2) ?? ""),
    Target2:    String(target2?.toFixed(2) ?? ""),
    Status:     a.status ?? "",
    T1Hit:      t1Hit ? "Y" : "N",
    T1HitTime:  (isVwap ? (t1Hit ? a.exitTime ?? "" : "") : a.t1HitTime) ?? "",
    PnL:        String(a.currentPnL?.toFixed(2) ?? "0"),
    PnLPct:     String(a.pnlPct?.toFixed(2)     ?? "0"),
    Concepts:   isVwap ? (a.vwap != null ? `VWAP ₹${Number(a.vwap).toFixed(2)}` : "") : (a.concepts ?? []).join("+"),
    MaxPoints:  String(a.peakMove?.toFixed(2)   ?? "0"),
    Spot:       String(a.spot?.toFixed(2)        ?? ""),
    Expiry:     a.expiry ?? "",
  };
}

// ── GET /api/results?strategy=smc|vwap930  →  available dates for live + backtest ──
router.get("/", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { type, date } = req.query;
  const strategy = req.query.strategy === "vwap930" ? "vwap930" : "smc";
  const { AlertModel, BacktestModel } = modelsFor(strategy);

  // ── Return rows for a specific date ────────────────────────────────────────
  if (type && date) {
    if (!isConnected())
      return res.status(503).json({ error: "MongoDB not connected" });

    try {
      if (type === "live") {
        const docs = await AlertModel.find({ date }).sort({ createdAt: 1 }).lean();
        return res.json({ rows: docs.map(a => mapRow(a, strategy)) });
      }

      if (type === "backtest") {
        const doc = await BacktestModel.findOne({ date }).lean();
        if (!doc) return res.json({ rows: [] });
        return res.json({ rows: (doc.results ?? []).map(a => mapRow(a, strategy)) });
      }

      return res.status(400).json({ error: "type must be live or backtest" });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── Return available dates list ─────────────────────────────────────────────
  if (!isConnected()) return res.json({ backtest: [], live: [] });

  try {
    const [liveDates, backtestDates] = await Promise.all([
      AlertModel.distinct("date").then(d => d.sort().reverse()),
      BacktestModel.distinct("date").then(d => d.sort().reverse()),
    ]);
    res.json({ live: liveDates, backtest: backtestDates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── GET /api/results/summary?type=live|backtest&strategy=smc|vwap930 ─────────
router.get("/summary", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  const { type } = req.query;
  const strategy = req.query.strategy === "vwap930" ? "vwap930" : "smc";
  const { AlertModel, BacktestModel } = modelsFor(strategy);
  if (!isConnected()) return res.json({ summary: [] });

  try {
    if (type === "live") {
      const agg = await AlertModel.aggregate([
        { $group: {
          _id:      "$date",
          totalPnL: { $sum: "$currentPnL" },
          trades:   { $sum: 1 },
          wins:     { $sum: { $cond: [{ $in: ["$status", ["TARGET", "TIME_PROFIT"]] }, 1, 0] } },
        }},
        { $sort: { _id: 1 } },
      ]);
      return res.json({ summary: agg.map(r => ({ date: r._id, totalPnL: r.totalPnL ?? 0, trades: r.trades, wins: r.wins })) });
    }

    if (type === "backtest") {
      const docs = await BacktestModel.find({}, { date: 1, results: 1 }).lean();
      const summary = docs.map(doc => {
        const rows     = doc.results ?? [];
        const totalPnL = rows.reduce((s, r) => s + (r.currentPnL ?? 0), 0);
        const wins     = rows.filter(r => r.status === "TARGET" || r.status === "TIME_PROFIT").length;
        return { date: doc.date, totalPnL, trades: rows.length, wins };
      }).sort((a, b) => a.date.localeCompare(b.date));
      return res.json({ summary });
    }

    return res.status(400).json({ error: "type must be live or backtest" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
