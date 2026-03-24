"use strict";

const express  = require("express");
const router   = express.Router();
const { runSMCScan, runHistoricalSMCScan, updateAlertPnL } = require("../services/smcService");
const { buildOptionChain }           = require("../services/optionChainService");
const { sendSMCAlert, sendResultAlert, sendBacktestResults } = require("../services/telegramService");
const { isAuthenticated }            = require("../config/kite");
const autoTrade                      = require("./autoTrade");

// ─── In-memory store ──────────────────────────────────────────────────────────
let alerts      = [];          // array of SMC alert objects
let lastScanAt  = null;        // ISO string of last scan time
let scanRunning = false;       // guard against concurrent scans
let lastSLExitAt = null;       // timestamp of most recent SL exit
const MAX_ALERTS         = 100;
const COOLDOWN_MS        = 3 * 60 * 1000;   // 3 min per (strike+direction)
const SL_COOLDOWN_MS     = 5 * 60 * 1000;   // 5 min pause after any SL hit
const MAX_TRADES_PER_DAY = 25;

// ─── Concepts required for a valid signal (empty = accept all) ────────────────
// Set to e.g. ["OB"] to only alert when Order Block is present
// Set to ["OB","FVG"] to require BOTH OB and FVG
const REQUIRED_CONCEPTS = [];   // ← edit this to filter setups

// Returns time in HH:MM (IST) format
function timeKey() {
  const n = new Date();
  return `${String(n.getHours()).padStart(2,"0")}:${String(n.getMinutes()).padStart(2,"0")}`;
}

// ─── Dedup: same strike+direction within cooldown ─────────────────────────────
function isDuplicate(alert) {
  const key  = `${alert.direction}_${alert.strike}`;
  const now  = Date.now();
  return alerts.some(a =>
    `${a.direction}_${a.strike}` === key &&
    (now - new Date(a.createdAt).getTime()) < COOLDOWN_MS
  );
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

      // Fire Telegram + auto-trade exit when status changes
      if (updated.status !== "ACTIVE" && a.status === "ACTIVE") {
        sendResultAlert(updated);
        autoTrade.executeExit(updated).catch(() => {});
        if (updated.status === "SL") lastSLExitAt = Date.now();
      }

      return { ...updated, leg: { ...a.leg, ltp: newLeg.ltp ?? a.leg.ltp } };
    });
  } catch { /* ignore — keep stale data */ }
}

// ─── Core scan + alert creation ───────────────────────────────────────────────
async function doScan(expiry) {
  if (scanRunning) return;
  if (!isAuthenticated()) return;
  scanRunning = true;
  lastScanAt  = new Date().toISOString();

  try {
    // 1. Update P&L on existing active alerts
    await refreshActivePnL(expiry);

    // 2a. Gate: no new entry while a position is already ACTIVE
    const hasOpen = alerts.some(a => a.status === "ACTIVE");
    if (hasOpen) {
      console.log("[SMC] Skipping — open position exists, wait for exit");
      return;
    }

    // 2b. Gate: 20-min cooldown after any SL hit
    if (lastSLExitAt && (Date.now() - lastSLExitAt) < SL_COOLDOWN_MS) {
      const waitMin = Math.ceil((SL_COOLDOWN_MS - (Date.now() - lastSLExitAt)) / 60000);
      console.log(`[SMC] Skipping — SL cooldown active (${waitMin} min remaining)`);
      return;
    }

    // 2c. Gate: max 25 trades per calendar day (IST)
    const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    const todayCount = alerts.filter(a => {
      const d = new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
      return d === todayIST;
    }).length;
    if (todayCount >= MAX_TRADES_PER_DAY) {
      console.log(`[SMC] Daily limit (${MAX_TRADES_PER_DAY}) reached — no new entries`);
      return;
    }

    // 3. Run SMC analysis
    const result = await runSMCScan(expiry);

    if (!result.signal) {
      console.log(`[SMC] No signal — ${result.reason}`);
      return;
    }

    // 4. Concept filter — skip if required setup is not present
    if (REQUIRED_CONCEPTS.length > 0) {
      const missing = REQUIRED_CONCEPTS.filter(c => !result.concepts.includes(c));
      if (missing.length > 0) {
        console.log(`[SMC] Filtered — missing concepts: ${missing.join(", ")}`);
        return;
      }
    }

    // 5. Dedup check
    if (isDuplicate(result)) {
      console.log(`[SMC] Duplicate suppressed — ${result.direction} ${result.strike}`);
      return;
    }

    // 5. Add to alerts list
    alerts.unshift(result);
    if (alerts.length > MAX_ALERTS) alerts.length = MAX_ALERTS;

    console.log(`[SMC] ✅ Alert: ${result.direction} ${result.strike} @ ₹${result.rr.entry}  [${result.concepts.join("+")}]  strength=${result.strength}`);

    // 5. Telegram notification
    sendSMCAlert(result);

    // 6. Broadcast to all WebSocket clients
    if (_broadcast) _broadcast({ type: "scan_result", active: true, alert: result });

    // 7. Auto-trade entry (non-blocking)
    autoTrade.executeEntry(result).catch(() => {});

  } catch (err) {
    console.error("[SMC] Scan error:", err.message);
  } finally {
    scanRunning = false;
  }
}

// ─── Routes ───────────────────────────────────────────────────────────────────

// GET /api/smc/status
router.get("/status", (req, res) => {
  const now = new Date();
  const h   = now.getHours(), m = now.getMinutes(), day = now.getDay();
  const marketOpen = day >= 1 && day <= 5 && (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
  const scanActive = marketOpen && (h > 9 || (h === 9 && m >= 21));
  const wins  = alerts.filter(a => a.status === "TARGET").length;
  const total = alerts.filter(a => a.status !== "ACTIVE").length;

  res.json({
    scanActive,
    marketOpen,
    lastScanAt,
    scanRunning,
    totalAlerts: alerts.length,
    winRate:     total > 0 ? +((wins / total) * 100).toFixed(1) : null,
    wins,
    losses:      total - wins,
  });
});

// GET /api/smc/alerts?expiry=2026-03-27
router.get("/alerts", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { expiry } = req.query;
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  // On each GET, also refresh active P&L (lightweight — reuses cached chain)
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

// POST /api/smc/scan  (manual trigger from frontend)
router.post("/scan", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const expiry = req.query.expiry || req.body?.expiry;
  if (!expiry) return res.status(400).json({ error: "expiry required" });

  // Non-blocking — respond immediately
  res.json({ queued: true, time: timeKey() });
  doScan(expiry);
});

// DELETE /api/smc/clear
router.delete("/clear", (req, res) => {
  alerts = [];
  res.json({ cleared: true });
});

// GET /api/smc/historical?date=2026-03-20&expiry=2026-03-27
// Full-day backtest: walk every minute, find SMC signals, resolve SL/Target
router.get("/historical", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { date, expiry } = req.query;
  if (!date || !expiry)
    return res.status(400).json({ error: "date and expiry are required" });

  // Reject future dates; allow today only after market close (15:30 IST)
  const nowIST   = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  const today    = new Date(nowIST); today.setUTCHours(0, 0, 0, 0);
  const reqDate  = new Date(date);
  const isToday  = reqDate.toISOString().slice(0, 10) === today.toISOString().slice(0, 10);
  const marketClosed = nowIST.getUTCHours() > 15 || (nowIST.getUTCHours() === 15 && nowIST.getUTCMinutes() >= 30);
  if (reqDate > today || (isToday && !marketClosed))
    return res.status(400).json({ error: "Today's backtest is available after market close (15:30 IST)" });

  try {
    console.log(`[SMC Historical] Backtesting ${date} expiry ${expiry}...`);
    const result = await runHistoricalSMCScan(date, expiry);
    console.log(`[SMC Historical] Done — ${result.totalSignals} signals, winRate ${result.winRate}%`);

    // Send Telegram summary (non-blocking)
    sendBacktestResults(result).catch(() => {});

    res.json(result);
  } catch (err) {
    console.error("[SMC Historical] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Return today's alerts for session summary
function getTodayAlerts() {
  const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
  return alerts.filter(a => {
    const d = new Date(a.createdAt).toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata" });
    return d === todayIST;
  });
}

// Injected broadcast function (set by index.js after WS server is ready)
let _broadcast = null;
function setBroadcast(fn) { _broadcast = fn; }

// Export doScan + getTodayAlerts for cron
module.exports                = router;
module.exports.doScan         = doScan;
module.exports.getTodayAlerts = getTodayAlerts;
module.exports.setBroadcast   = setBroadcast;
