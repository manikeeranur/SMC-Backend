"use strict";

// VWAP 9:30 strategy notifications — reuses the low-level Telegram sender
// from telegramService, but with its own labelled message templates
// (single target, not target1/target2, unlike SMC).
const { post, postChunked, exitReason, isConfigured } = require("./telegramService");
const {
  LOT_SIZE, VWAP930_NUM_LOTS, VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM,
  VWAP930_SL_PCT, VWAP930_TARGET_PCT, VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MINUTES,
  VWAP930_MAX_TRADES_PER_DAY,
} = require("../config/constants");
const ORDER_QTY = LOT_SIZE * VWAP930_NUM_LOTS;

// "09:30, 09:35, ... or 10:55" — built from VWAP930_ENTRY_HOUR ×
// VWAP930_ENTRY_MINUTES so this text can never drift from the actual
// checkpoints.
function checkpointsStr() {
  const list = [];
  for (const h of VWAP930_ENTRY_HOUR) {
    for (const m of VWAP930_ENTRY_MINUTES) {
      list.push(`${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`);
    }
  }
  return list.join(", ").replace(/, ([^,]*)$/, " or $1");
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function sendVwap930Alert(alert) {
  if (!isConfigured()) return;
  const text = [
    `🎯 <b>VWAP 9:30 — ${alert.strike} ${alert.direction}</b>`,
    ``,
    `Entry Time : ${alert.entryTime}`,
    `Entry      : ${alert.rr.entry} RS`,
    `VWAP       : ${alert.vwap} RS`,
    `SL (−8%)   : ${alert.rr.sl} RS`,
    `Target(+30%): ${alert.rr.target} RS`,
  ].join("\n");
  post(text);
}

function sendVwap930Result(alert) {
  if (!isConfigured()) return;
  const lotPnl = alert.currentPnL * ORDER_QTY;
  const sign   = lotPnl >= 0 ? "+" : "-";
  const pnlStr = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;
  const text = [
    `<b>VWAP 9:30 — ${alert.strike} ${alert.direction}</b>`,
    ``,
    `Entry Time : ${alert.entryTime}`,
    `Exit Time  : ${alert.exitTime ?? "—"}  (${exitReason(alert.status)})`,
    `P&L        : <b>${pnlStr}</b>`,
  ].join("\n");
  post(text);
}

async function sendVwap930BacktestResults(data) {
  if (!isConfigured()) return;
  const { results = [], date, expiry, wins = 0, losses = 0, eod = 0, winRate } = data;
  if (!results.length) {
    await post(`📊 <b>VWAP 9:30 BACKTEST — ${date}</b>\n\nNo qualifying signal at ${checkpointsStr()} for this date.\nExpiry: ${expiry}`);
    return;
  }
  const lines = [
    `📊 <b>VWAP 9:30 BACKTEST — ${date}</b>`,
    `📅 Expiry : ${expiry}`,
  ];
  results.forEach((r, i) => {
    const lotPnl = (r.currentPnL ?? 0) * ORDER_QTY;
    const sign   = lotPnl >= 0 ? "+" : "-";
    const pnlStr = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;
    lines.push(
      ``,
      `<b>${i > 0 ? `Re-entry ${i + 1}: ` : ""}${r.strike} ${r.direction}</b>`,
      `Entry Time : ${r.entryTime}`,
      `Exit Time  : ${r.exitTime ?? "—"}  (${exitReason(r.status)})`,
      `Entry      : ${r.rr?.entry?.toFixed(0) ?? "—"} RS`,
      `VWAP       : ${r.vwap ?? "—"} RS`,
      `SL         : ${r.rr?.sl?.toFixed(0) ?? "—"} RS`,
      `Target     : ${r.rr?.target?.toFixed(0) ?? "—"} RS`,
      `P&L        : <b>${pnlStr}</b> (${VWAP930_NUM_LOTS} lot${VWAP930_NUM_LOTS > 1 ? "s" : ""} = ${ORDER_QTY} qty)`,
    );
  });
  lines.push(
    ``,
    `<i>Premium ₹${VWAP930_MIN_PREMIUM}–₹${VWAP930_MAX_PREMIUM} · VWAP touch/above · SL −${VWAP930_SL_PCT}% · Target +${VWAP930_TARGET_PCT}% · Entry @ ${checkpointsStr()} · re-entry only after SL · max ${VWAP930_MAX_TRADES_PER_DAY} trade${VWAP930_MAX_TRADES_PER_DAY > 1 ? "s" : ""}/day</i>`,
  );
  await postChunked(lines);
}

async function sendVwap930SessionSummary(todayAlerts) {
  if (!isConfigured() || !todayAlerts.length) return;
  const closed = todayAlerts.filter(a => a.status !== "ACTIVE");
  if (!closed.length) return;
  const lines = [`📊 <b>VWAP 9:30 — SESSION ENDED</b>`, ``];
  let totalLotPnl = 0;
  closed.forEach((a, i) => {
    const lotPnl = (a.currentPnL ?? 0) * ORDER_QTY;
    totalLotPnl += lotPnl;
    const sign   = lotPnl >= 0 ? "+" : "-";
    const pnlStr = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;
    lines.push(
      `${i > 0 ? "Re-entry: " : ""}<b>${a.strike} ${a.direction}</b>  ${a.entryTime}→${a.exitTime ?? "—"}  (${exitReason(a.status)})`,
      `P&L: <b>${pnlStr}</b> (${VWAP930_NUM_LOTS} lot${VWAP930_NUM_LOTS > 1 ? "s" : ""})`,
    );
  });
  if (closed.length > 1) {
    const sign = totalLotPnl >= 0 ? "+" : "-";
    lines.push(``, `Day total: <b>${sign}${Math.abs(totalLotPnl).toFixed(0)} RS</b>`);
  }
  await postChunked(lines);
}

function sendVwap930AutoTradeStarted() {
  const time = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
  post([
    `🟢 <b>VWAP 9:30 AUTO TRADE — STARTED</b>`,
    ``,
    `🕐 Time   : ${time} IST`,
    `📦 Lot    : ${VWAP930_NUM_LOTS} lot${VWAP930_NUM_LOTS > 1 ? "s" : ""} (${ORDER_QTY} qty)`,
    `⚡ Orders : MARKET entry + SL-M stop loss`,
    ``,
    `<i>Live VWAP 9:30 signal will place a real Kite order — only at ${checkpointsStr()} IST.</i>`,
  ].join("\n"));
}

function sendVwap930AutoTradeStopped() {
  const time = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
  post([
    `🔴 <b>VWAP 9:30 AUTO TRADE — STOPPED</b>`,
    ``,
    `🕐 Time : ${time} IST`,
    ``,
    `<i>No new orders will be placed. Existing Kite orders remain open.</i>`,
  ].join("\n"));
}

function sendVwap930AutoTradeOrder(pos, type) {
  const time = new Date().toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
  const emoji = type === "ENTRY" ? "📥" : type === "EXIT" ? "📤" : "⚠️";
  const lines = [
    `${emoji} <b>VWAP 9:30 AUTO TRADE ${type} — ${pos.tradingsymbol}</b>`,
    ``,
    `🕐 Time      : ${time} IST`,
    `📊 Direction : ${pos.direction}`,
    `💰 Entry     : ₹${pos.rr?.entry?.toFixed(2) ?? "—"}`,
    `🛑 SL        : ₹${pos.rr?.sl?.toFixed(2) ?? "—"}`,
    `🎯 Target    : ₹${pos.rr?.target?.toFixed(2) ?? "—"}`,
  ];
  if (type === "ENTRY") {
    lines.push(``, `📋 Entry Order : ${pos.entryOrderId ?? "—"}`);
    lines.push(`📋 SL Order    : ${pos.slOrderId ?? "—"}`);
  } else if (type === "EXIT") {
    lines.push(``, `📋 Exit Order  : ${pos.exitOrderId ?? "—"}`);
    lines.push(`📊 Status      : ${pos.status}`);
  } else {
    lines.push(``, `❌ ${pos.logs?.[pos.logs.length - 1] ?? "Unknown error"}`);
  }
  post(lines.join("\n"));
}

module.exports = {
  sendVwap930Alert, sendVwap930Result, sendVwap930BacktestResults, sendVwap930SessionSummary,
  sendVwap930AutoTradeStarted, sendVwap930AutoTradeStopped, sendVwap930AutoTradeOrder,
};
