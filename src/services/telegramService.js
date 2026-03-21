"use strict";

const https = require("https");

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const CHAT_ID   = process.env.TELEGRAM_CHAT_ID   || "";

function isConfigured() {
  return BOT_TOKEN.length > 10 && CHAT_ID.length > 3;
}

// Post a single message (max 4096 chars — Telegram limit)
function post(text) {
  if (!isConfigured()) return Promise.resolve();
  return new Promise((resolve) => {
    const body = JSON.stringify({ chat_id: CHAT_ID, text, parse_mode: "HTML" });
    const req  = https.request({
      hostname: "api.telegram.org",
      path:     `/bot${BOT_TOKEN}/sendMessage`,
      method:   "POST",
      headers:  { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
    }, res => { res.resume(); resolve(); });
    req.on("error", () => resolve());
    req.write(body);
    req.end();
  });
}

// Split long text into ≤4000-char chunks and send sequentially
async function postChunked(lines) {
  const MAX = 4000;
  let chunk = "";
  for (const line of lines) {
    if ((chunk + "\n" + line).length > MAX) {
      await post(chunk.trim());
      await delay(400); // Telegram rate limit
      chunk = line;
    } else {
      chunk = chunk ? chunk + "\n" + line : line;
    }
  }
  if (chunk.trim()) await post(chunk.trim());
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// Alert fired message
function sendSMCAlert(alert) {
  if (!isConfigured()) return;
  const text = [
    `<b>${alert.strike} ${alert.direction}</b>`,
    ``,
    `Entry Time : ${alert.entryTime}`,
    `Entry      : ${alert.rr.entry} RS`,
    `SL         : ${alert.rr.sl} RS`,
    `Target 1   : ${alert.rr.target1} RS`,
    `Target 2   : ${alert.rr.target2} RS`,
  ].join("\n");
  post(text);
}

function exitReason(status) {
  return status === "TARGET"      ? "Target 2 Hit"
    :    status === "SL"          ? "SL Hit"
    :    status === "TIME_PROFIT" ? "60 Min Exit (Profit)"
    :    status === "TIME_EXIT"   ? "75 Min / 3:20 PM Exit"
    :    status === "EOD"         ? "End of Day"
    :    status;
}

// Result message (TARGET / SL / TIME_PROFIT / TIME_EXIT)
function sendResultAlert(alert) {
  if (!isConfigured()) return;
  const t1Hit = alert.t1Hit || alert.status === "TARGET";
  const t2Hit = alert.status === "TARGET";
  const t1Str = t1Hit ? `Hit ✅${alert.t1HitTime ? `  (${alert.t1HitTime})` : ""}` : "Not Hit ❌";
  const t2Str = t2Hit ? `Hit ✅${alert.exitTime   ? `  (${alert.exitTime})`   : ""}` : "Not Hit ❌";
  const lotPnl = alert.currentPnL * 65;
  const sign   = lotPnl >= 0 ? "+" : "-";
  const pnlStr = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;

  const text = [
    `<b>${alert.strike} ${alert.direction}</b>`,
    ``,
    `Entry Time : ${alert.entryTime}`,
    `Exit Time  : ${alert.exitTime ?? "—"}  (${exitReason(alert.status)})`,
    ``,
    `Target 1   : ${t1Str}`,
    `Target 2   : ${t2Str}`,
    `P&L        : <b>${pnlStr}</b>`,
  ].join("\n");
  post(text);
}

// ─── Backtest results ─────────────────────────────────────────────────────────
async function sendBacktestResults(data) {
  if (!isConfigured()) return;

  const { results = [], date, expiry, wins = 0, losses = 0, eod = 0, winRate } = data;
  if (!results.length) {
    await post(`📊 <b>SMC BACKTEST — ${date}</b>\n\nNo signals found for this date.\nExpiry: ${expiry}`);
    return;
  }

  const total = wins + losses;
  const wrStr = winRate !== null ? `${winRate}%` : "—";
  const bar   = wins > 0 || losses > 0
    ? "🟩".repeat(wins) + "🟥".repeat(losses) + (eod > 0 ? "🟨".repeat(eod) : "")
    : "";

  // Total lot P&L across all trades
  const totalLot = results.reduce((s, r) => s + (r.currentPnL ?? 0) * 65, 0);
  const tSign    = totalLot >= 0 ? "+" : "−";
  const tAbs     = Math.abs(totalLot);
  const totalLotStr = tAbs >= 1000
    ? `${tSign}₹${(tAbs/1000).toFixed(2)}K`
    : `${tSign}₹${tAbs.toFixed(0)}`;

  // ── Summary message ────────────────────────────────────────────────────────
  const summaryLines = [
    `📊 <b>SMC BACKTEST RESULTS — ${date}</b>`,
    `📅 Expiry : ${expiry}`,
    ``,
    `📈 Signals     : ${results.length}`,
    `🎯 TARGET      : ${wins}`,
    `🛑 SL HIT      : ${losses}`,
    `🕐 EOD/Open    : ${eod}`,
    `🏆 Win Rate    : <b>${wrStr}</b> (${wins}W / ${losses}L)`,
    `📦 LOT P&L (65): <b>${totalLotStr}</b>`,
    bar ? `\n${bar}` : "",
    ``,
    `<i>SL −12%  ·  Target +24%  ·  Entry ≥ 09:21  ·  1 lot = 65 qty</i>`,
  ].filter(l => l !== "");

  await post(summaryLines.join("\n"));
  await delay(500);

  // ── Individual trade lines ─────────────────────────────────────────────────
  const tradeLines = [
    `📋 <b>TRADE LOG — ${date}</b>`,
    ``,
  ];

  results.forEach((r, i) => {
    const t1Hit  = r.t1Hit || r.status === "TARGET";
    const t2Hit  = r.status === "TARGET";
    const t1Str  = t1Hit ? `Hit ✅${r.t1HitTime ? `  (${r.t1HitTime})` : ""}` : "Not Hit ❌";
    const t2Str  = t2Hit ? `Hit ✅${r.exitTime   ? `  (${r.exitTime})`  : ""}` : "Not Hit ❌";
    const lotPnl = r.currentPnL * 65;
    const sign   = lotPnl >= 0 ? "+" : "-";
    const pnlStr = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;
    tradeLines.push(
      `${i + 1}. <b>${r.strike} ${r.direction}</b>`,
      ``,
      `Entry Time : ${r.entryTime}`,
      `Exit Time  : ${r.exitTime ?? "—"}  (${exitReason(r.status)})`,
      `Entry      : ${r.rr?.entry?.toFixed(0) ?? "—"} RS`,
      `SL         : ${r.rr?.sl?.toFixed(0) ?? "—"} RS`,
      `Target 1   : ${r.rr?.target1?.toFixed(0) ?? "—"} RS`,
      `Target 2   : ${r.rr?.target2?.toFixed(0) ?? "—"} RS`,
      `T1         : ${t1Str}`,
      `T2         : ${t2Str}`,
      `P&L        : <b>${pnlStr}</b>`,
      ``,
    );
  });

  await postChunked(tradeLines);
}

// ─── End-of-session daily summary ────────────────────────────────────────────
async function sendSessionSummary(todayAlerts) {
  if (!isConfigured() || !todayAlerts.length) return;

  const today = new Date().toLocaleDateString("en-IN", {
    day: "2-digit", month: "short", year: "numeric", timeZone: "Asia/Kolkata",
  });

  const closed = todayAlerts.filter(a => a.status !== "ACTIVE");
  if (!closed.length) return;

  const wins     = closed.filter(a => a.status === "TARGET" || a.status === "TIME_PROFIT").length;
  const losses   = closed.length - wins;
  const wr       = closed.length > 0 ? ((wins / closed.length) * 100).toFixed(0) : 0;
  const totalLot = closed.reduce((s, a) => s + (a.currentPnL ?? 0) * 65, 0);
  const tSign    = totalLot >= 0 ? "+" : "-";
  const totalStr = `${tSign}${Math.abs(totalLot).toFixed(0)} RS`;

  const lines = [
    `📊 <b>SESSION ENDED — ${today}</b>`,
    ``,
    `Trades   : ${closed.length}  |  Win ${wins}  Loss ${losses}`,
    `Win Rate : ${wr}%`,
    `Total P&L: <b>${totalStr}</b> (1 lot)`,
    ``,
  ];

  closed.forEach((a, i) => {
    const t1Hit  = a.t1Hit || a.status === "TARGET";
    const t2Hit  = a.status === "TARGET";
    const t1Str  = t1Hit ? `✅${a.t1HitTime ? ` ${a.t1HitTime}` : ""}` : "❌";
    const t2Str  = t2Hit ? `✅${a.exitTime   ? ` ${a.exitTime}`  : ""}` : "❌";
    const lotPnl = (a.currentPnL ?? 0) * 65;
    const sign   = lotPnl >= 0 ? "+" : "-";
    const pStr   = `${sign}${Math.abs(lotPnl).toFixed(0)} RS`;
    lines.push(`${i + 1}. <b>${a.strike} ${a.direction}</b>  ${a.entryTime}→${a.exitTime ?? "—"}  (${exitReason(a.status)})`);
    lines.push(`   T1 ${t1Str}  T2 ${t2Str}  <b>${pStr}</b>`);
    lines.push(``);
  });

  await postChunked(lines);
}

// ─── Startup ping ─────────────────────────────────────────────────────────────
function sendStartupPing() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata" });
  post([
    `🚀 <b>NIFTY SMC Algo — Online</b>`,
    ``,
    `✅ Bot connected`,
    `🕐 Server time : ${time} IST`,
    `📡 SMC scanner : 09:21–15:30  Mon–Fri`,
    `📊 Live alerts + Backtest reports active`,
  ].join("\n"));
}

module.exports = { sendSMCAlert, sendResultAlert, sendBacktestResults, sendSessionSummary, sendStartupPing, isConfigured };
