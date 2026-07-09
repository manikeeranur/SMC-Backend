"use strict";

const { isConnected }      = require("../config/db");
const Alert                = require("../models/Alert");
const BacktestResult       = require("../models/BacktestResult");
const Vwap930Alert         = require("../models/Vwap930Alert");
const Vwap930BacktestResult = require("../models/Vwap930BacktestResult");

// ── Upsert a single live alert ─────────────────────────────────────────────
async function saveAlert(alert) {
  if (!isConnected()) return;
  try {
    const date = new Date(alert.createdAt)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD IST
    await Alert.updateOne(
      { alertId: alert.id },
      {
        $set: {
          alertId:       alert.id,
          date,
          tradingsymbol: alert.leg?.tradingsymbol ?? alert.tradingsymbol ?? null,
          direction:     alert.direction,
          strike:        alert.strike,
          expiry:        alert.expiry,
          entryTime:  alert.entryTime,
          exitTime:   alert.exitTime ?? null,
          spot:       alert.spot,
          concepts:   alert.concepts ?? [],
          score:      alert.score,
          effScore:   alert.effScore,
          strength:   alert.strength,
          trendOk:    alert.trendOk,
          rr:         alert.rr,
          status:     alert.status,
          currentPnL: alert.currentPnL ?? 0,
          pnlPct:     alert.pnlPct ?? 0,
          peakMove:   alert.peakMove ?? 0,
          t1Hit:      alert.t1Hit ?? false,
          t1HitTime:  alert.t1HitTime ?? null,
          lastLtp:    alert.lastLtp ?? null,
          createdAt:  alert.createdAt,
          updatedAt:  new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[MongoDB] saveAlert error:", err.message);
  }
}

// ── Sync all in-memory alerts to MongoDB (called every second) ────────────
async function syncAlerts(alerts) {
  if (!isConnected() || !alerts.length) return;
  await Promise.all(alerts.map(saveAlert));
}

// ── Save backtest result (upsert by date+expiry) ───────────────────────────
async function saveBacktest(result) {
  if (!isConnected()) return;
  try {
    await BacktestResult.updateOne(
      { date: result.date, expiry: result.expiry },
      { $set: { ...result, runAt: new Date() } },
      { upsert: true }
    );
    console.log(`[MongoDB] Backtest saved — ${result.date} ${result.expiry}`);
  } catch (err) {
    console.error("[MongoDB] saveBacktest error:", err.message);
  }
}

// ── VWAP 9:30 strategy — separate collection, same upsert pattern ─────────
async function saveVwap930Alert(alert) {
  if (!isConnected()) return;
  try {
    const date = new Date(alert.createdAt)
      .toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" }); // YYYY-MM-DD IST
    await Vwap930Alert.updateOne(
      { alertId: alert.id },
      {
        $set: {
          alertId:       alert.id,
          date,
          tradingsymbol: alert.leg?.tradingsymbol ?? alert.tradingsymbol ?? null,
          direction:     alert.direction,
          strike:        alert.strike,
          expiry:        alert.expiry,
          entryTime:  alert.entryTime,
          exitTime:   alert.exitTime ?? null,
          spot:       alert.spot,
          vwap:       alert.vwap,
          vwapCE:     alert.vwapCE,
          vwapPE:     alert.vwapPE,
          rr:         alert.rr,
          status:     alert.status,
          currentPnL: alert.currentPnL ?? 0,
          pnlPct:     alert.pnlPct ?? 0,
          peakMove:   alert.peakMove ?? 0,
          lastLtp:    alert.lastLtp ?? null,
          createdAt:  alert.createdAt,
          updatedAt:  new Date(),
        },
      },
      { upsert: true }
    );
  } catch (err) {
    console.error("[MongoDB] saveVwap930Alert error:", err.message);
  }
}

async function syncVwap930Alerts(alerts) {
  if (!isConnected() || !alerts.length) return;
  await Promise.all(alerts.map(saveVwap930Alert));
}

async function saveVwap930Backtest(result) {
  if (!isConnected()) return;
  try {
    await Vwap930BacktestResult.updateOne(
      { date: result.date, expiry: result.expiry },
      { $set: { ...result, runAt: new Date() } },
      { upsert: true }
    );
    console.log(`[MongoDB] VWAP930 backtest saved — ${result.date} ${result.expiry}`);
  } catch (err) {
    console.error("[MongoDB] saveVwap930Backtest error:", err.message);
  }
}

module.exports = {
  syncAlerts, saveAlert, saveBacktest,
  syncVwap930Alerts, saveVwap930Alert, saveVwap930Backtest,
};
