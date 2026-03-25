"use strict";

const express        = require("express");
const router         = express.Router();
const Alert          = require("../models/Alert");
const BacktestResult = require("../models/BacktestResult");
const { isConnected } = require("../config/db");

// ── GET /api/results  →  available dates for live + backtest ─────────────────
router.get("/", async (req, res) => {
  const { type, date } = req.query;

  // ── Return rows for a specific date ────────────────────────────────────────
  if (type && date) {
    if (!isConnected())
      return res.status(503).json({ error: "MongoDB not connected" });

    try {
      if (type === "live") {
        const docs = await Alert.find({ date }).sort({ createdAt: 1 }).lean();
        const rows = docs.map(a => ({
          EntryTime:  a.entryTime ?? "",
          ExitTime:   a.exitTime  ?? "",
          Direction:  a.direction ?? "",
          Strike:     String(a.strike ?? ""),
          Entry:      String(a.rr?.entry?.toFixed(2) ?? ""),
          SL:         String(a.rr?.sl?.toFixed(2)    ?? ""),
          Target1:    String(a.rr?.target1?.toFixed(2) ?? ""),
          Target2:    String(a.rr?.target2?.toFixed(2) ?? ""),
          Status:     a.status ?? "",
          T1Hit:      a.t1Hit ? "Y" : "N",
          T1HitTime:  a.t1HitTime ?? "",
          PnL:        String(a.currentPnL?.toFixed(2) ?? "0"),
          PnLPct:     String(a.pnlPct?.toFixed(2)     ?? "0"),
          Concepts:   (a.concepts ?? []).join("+"),
          MaxPoints:  String(a.peakMove?.toFixed(2)   ?? "0"),
          Spot:       String(a.spot?.toFixed(2)        ?? ""),
          Expiry:     a.expiry ?? "",
        }));
        return res.json({ rows });
      }

      if (type === "backtest") {
        const doc = await BacktestResult.findOne({ date }).lean();
        if (!doc) return res.json({ rows: [] });
        const rows = (doc.results ?? []).map(a => ({
          EntryTime:  a.entryTime ?? "",
          ExitTime:   a.exitTime  ?? "",
          Direction:  a.direction ?? "",
          Strike:     String(a.strike ?? ""),
          Entry:      String(a.rr?.entry?.toFixed(2) ?? ""),
          SL:         String(a.rr?.sl?.toFixed(2)    ?? ""),
          Target1:    String(a.rr?.target1?.toFixed(2) ?? ""),
          Target2:    String(a.rr?.target2?.toFixed(2) ?? ""),
          Status:     a.status ?? "",
          T1Hit:      a.t1Hit ? "Y" : "N",
          T1HitTime:  a.t1HitTime ?? "",
          PnL:        String(a.currentPnL?.toFixed(2) ?? "0"),
          PnLPct:     String(a.pnlPct?.toFixed(2)     ?? "0"),
          Concepts:   (a.concepts ?? []).join("+"),
          MaxPoints:  String(a.peakMove?.toFixed(2)   ?? "0"),
          Spot:       String(a.spot?.toFixed(2)        ?? ""),
          Expiry:     a.expiry ?? "",
        }));
        return res.json({ rows });
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
      Alert.distinct("date").then(d => d.sort().reverse()),
      BacktestResult.distinct("date").then(d => d.sort().reverse()),
    ]);
    res.json({ live: liveDates, backtest: backtestDates });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
