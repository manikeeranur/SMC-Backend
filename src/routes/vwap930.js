"use strict";

const express  = require("express");
const router   = express.Router();
const { runVWAP930Scan, runHistoricalVWAP930Scan, updateAlertPnL } = require("../services/vwap930Service");
const { buildOptionChain }           = require("../services/optionChainService");
const { sendVwap930Alert, sendVwap930Result, sendVwap930BacktestResults } = require("../services/vwap930Telegram");
const { isAuthenticated }            = require("../config/kite");
const { VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MIN } = require("../config/constants");
const autoTrade                      = require("./vwap930AutoTrade");
const { saveVwap930Alert, saveVwap930Backtest } = require("../services/dbSyncService");
const Vwap930Alert         = require("../models/Vwap930Alert");
const Vwap930BacktestResult = require("../models/Vwap930BacktestResult");
const { isConnected }                = require("../config/db");

// ─── In-memory store ──────────────────────────────────────────────────────────
let alerts        = [];    // array of VWAP930 alert objects
let lastScanAt     = null; // ISO string of last scan time
let scanRunning    = false;
let lastMongoSync  = 0;
const MAX_ALERTS         = 50;
const MAX_TRADES_PER_DAY = 1;  // only one entry per day, by design

function timeKey() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" });
}

function todayIST() {
  return new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
}

// ─── Update P&L for all ACTIVE alerts using latest chain data ────────────────
async function refreshActivePnL(expiry) {
  const active = alerts.filter(a => a.status === "ACTIVE");
  if (!active.length || !isAuthenticated()) return;

  try {
    const chain = await buildOptionChain(expiry, 15);

    alerts = alerts.map(a => {
      if (a.status !== "ACTIVE") return a;
      const row    = chain.rows.find(r => r.strike === a.strike);
      const newLeg = a.direction === "CE" ? row?.ce : row?.pe;
      if (!newLeg) return a;

      const updated = updateAlertPnL(a, newLeg.leg?.ltp ?? newLeg.ltp);

      if (updated.status !== "ACTIVE" && a.status === "ACTIVE") {
        sendVwap930Result(updated);
        autoTrade.executeExit(updated).catch(() => {});
      }

      return { ...updated, leg: { ...a.leg, ltp: newLeg.ltp ?? a.leg.ltp } };
    });
  } catch { /* ignore — keep stale data */ }
}

// ─── Core scan + alert creation — only ever fires at exactly 09:30 IST ──────
async function doScan(expiry) {
  if (scanRunning) return;
  if (!isAuthenticated()) return;
  scanRunning = true;
  lastScanAt  = new Date().toISOString();

  try {
    await refreshActivePnL(expiry);

    // Gate: no new entry while a position is already ACTIVE
    const hasOpenAlert = alerts.some(a => a.status === "ACTIVE");
    const hasOpenTrade = autoTrade.getPositions().some(p => p.status === "ACTIVE" || p.status === "ENTRY_PLACED" || p.status === "EXITING");
    if (hasOpenAlert || hasOpenTrade) {
      console.log("[VWAP930] Skipping — open position exists, wait for exit");
      return;
    }

    // Gate: only one entry per calendar day (IST)
    const today = todayIST();
    const todayCount = alerts.filter(a => {
      const d = new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
      return d === today;
    }).length;
    if (todayCount >= MAX_TRADES_PER_DAY) {
      console.log(`[VWAP930] Daily limit (${MAX_TRADES_PER_DAY}) reached — no new entries`);
      return;
    }

    const result = await runVWAP930Scan(expiry);

    if (!result.signal) {
      console.log(`[VWAP930] No signal — ${result.reason}`);
      return;
    }

    alerts.unshift(result);
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
    saveVwap930Alert(result).catch(() => {});

    console.log(`[VWAP930] ✅ Alert: ${result.direction} ${result.strike} @ ₹${result.rr.entry}  [VWAP ${result.vwap}]`);

    sendVwap930Alert(result);
    autoTrade.executeEntry(result).catch(() => {});

  } catch (err) {
    console.error("[VWAP930] Scan error:", err.message);
  } finally {
    scanRunning = false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/vwap930/status
router.get("/status", (req, res) => {
  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
  const marketOpen = day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
  const scanActive = marketOpen && h === VWAP930_ENTRY_HOUR && m === VWAP930_ENTRY_MIN;
  const today = todayIST();
  const tradedToday = alerts.some(a => {
    const d = new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    return d === today;
  });
  const wins  = alerts.filter(a => a.status === "TARGET").length;
  const total = alerts.filter(a => a.status !== "ACTIVE").length;

  res.json({
    scanActive,
    marketOpen,
    tradedToday,
    lastScanAt,
    scanRunning,
    totalAlerts: alerts.length,
    winRate:     total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    wins,
    losses:      total - wins,
  });
});

// GET /api/vwap930/alerts?expiry=2026-03-27
router.get("/alerts", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { expiry } = req.query;
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  const now = Date.now();
  if (isConnected() && (now - lastMongoSync > 60_000)) {
    lastMongoSync = now;
    try {
      const today = new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
      const docs = await Vwap930Alert.find({ date: today }).sort({ createdAt: 1 }).lean();
      if (docs.length) {
        const inMemoryIds = new Set(alerts.map(a => a.id || a.alertId));
        const missing = docs.filter(d => !inMemoryIds.has(d.alertId));
        if (missing.length) {
          const restored = missing.map(d => ({
            id: d.alertId, alertId: d.alertId,
            date: d.date, direction: d.direction, strike: d.strike, expiry: d.expiry,
            entryTime: d.entryTime, exitTime: d.exitTime, spot: d.spot,
            vwap: d.vwap, vwapCE: d.vwapCE, vwapPE: d.vwapPE, rr: d.rr,
            status: d.status, currentPnL: d.currentPnL ?? 0,
            pnlPct: d.pnlPct ?? 0, peakMove: d.peakMove ?? 0,
            lastLtp: d.lastLtp, createdAt: d.createdAt,
            tradingsymbol: d.tradingsymbol ?? null,
            leg: d.tradingsymbol ? { tradingsymbol: d.tradingsymbol, strike: d.strike, type: d.direction } : undefined,
          }));
          alerts = [...alerts, ...restored];
          if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;
          console.log(`[VWAP930] Synced ${missing.length} missing alerts from MongoDB (total: ${alerts.length})`);
        }
      }
    } catch (e) {
      console.error("[VWAP930] MongoDB sync failed:", e.message);
    }
  }

  await refreshActivePnL(expiry).catch(() => {});

  const wins  = alerts.filter(a => a.status === "TARGET").length;
  const total = alerts.filter(a => a.status !== "ACTIVE").length;

  res.json({
    alerts,
    lastScanAt,
    scanRunning,
    winRate: total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    wins,
    losses: total - wins,
  });
});

// POST /api/vwap930/scan  (manual trigger — still gated to exactly 09:30 IST internally)
router.post("/scan", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const expiry = req.query.expiry || req.body?.expiry;
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  res.json({ queued: true, time: timeKey() });
  doScan(expiry);
});

// DELETE /api/vwap930/clear
router.delete("/clear", (req, res) => {
  alerts = [];
  res.json({ cleared: true });
});

// GET /api/vwap930/historical?date=2026-03-20&expiry=2026-03-27
router.get("/historical", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { date, expiry } = req.query;
  if (!date || !expiry)
    return res.status(400).json({ error: "date and expiry are required" });

  const today = new Date(); today.setHours(0, 0, 0, 0);
  if (new Date(date) >= today)
    return res.status(400).json({ error: "date must be a past date for backtesting" });

  try {
    console.log(`[VWAP930 Historical] Backtesting ${date} expiry ${expiry}...`);
    const result = await runHistoricalVWAP930Scan(date, expiry);
    console.log(`[VWAP930 Historical] Done — ${result.totalSignals} signal(s), winRate ${result.winRate}%`);

    sendVwap930BacktestResults(result).catch(() => {});
    saveVwap930Backtest(result).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error("[VWAP930 Historical] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/vwap930/backtest-db?date=YYYY-MM-DD
router.get("/backtest-db", async (req, res) => {
  const { date } = req.query;
  if (!date) return res.status(400).json({ error: "date required" });
  if (!isConnected()) return res.status(503).json({ error: "MongoDB not connected" });

  try {
    const doc = await Vwap930BacktestResult.findOne({ date }).lean();
    if (!doc) return res.json({ results: [], winRate: null });
    res.json({
      results:      doc.results      ?? [],
      winRate:      doc.winRate      ?? null,
      wins:         doc.wins         ?? 0,
      losses:       doc.losses       ?? 0,
      totalSignals: doc.totalSignals ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

function getTodayAlerts() {
  const today = todayIST();
  return alerts.filter(a => {
    const d = new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    return d === today;
  });
}

module.exports                = router;
module.exports.doScan         = doScan;
module.exports.getTodayAlerts = getTodayAlerts;
module.exports.getAllAlerts   = () => alerts;
