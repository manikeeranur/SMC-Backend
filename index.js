require("dotenv").config();
const express = require("express");
const cors = require("cors");
const http = require("http");
const { WebSocketServer } = require("ws");
const schedule = require("node-schedule");

const authRoutes        = require("./src/routes/auth");
const optionChainRoutes = require("./src/routes/optionChain");
const analysisRoutes    = require("./src/routes/analysis");
const watchlistRoutes   = require("./src/routes/watchlist");
const smcRoutes         = require("./src/routes/smc");
const autoTradeRoutes   = require("./src/routes/autoTrade");
const resultsRoutes     = require("./src/routes/results");
const { stopTicker, subscribeTokens } = require("./src/websocket/ticker");
const { isAuthenticated } = require("./src/config/kite");
const { connectDB }       = require("./src/config/db");
const { syncAlerts }      = require("./src/services/dbSyncService");

const app = express();
const PORT = process.env.PORT || 4000;

// ─── Middleware ──────────────────────────────────────────────────────────
app.use(cors({ origin: "*" }));
app.use(express.json());

// ─── REST Routes ────────────────────────────────────────────────────────
app.use("/api/auth", authRoutes);
app.use("/api/options", optionChainRoutes);
app.use("/api/analysis", analysisRoutes);
app.use("/api/watchlist", watchlistRoutes);
app.use("/api/smc", smcRoutes);
app.use("/api/auto-trade", autoTradeRoutes);
app.use("/api/results", resultsRoutes);

app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    authenticated: isAuthenticated(),
    marketOpen: isMarketOpen(),
    serverTime: new Date().toISOString(),
  });
});

function isMarketOpen() {
  const now = new Date(),
    h = now.getHours(),
    m = now.getMinutes(),
    day = now.getDay();
  if (day === 0 || day === 6) return false;
  return (h > 9 || (h === 9 && m >= 15)) && (h < 15 || (h === 15 && m <= 30));
}

// ─── HTTP + WebSocket Server ──────────────────────────────────────────────────
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
const clients = new Set();

function broadcast(payload) {
  const msg = JSON.stringify(payload);
  clients.forEach((ws) => {
    if (ws.readyState === 1) ws.send(msg);
  });
}

wss.on("connection", (ws) => {
  clients.add(ws);
  console.log(`[WS] Client connected (total: ${clients.size})`);

  ws.send(
    JSON.stringify({
      type: "status",
      authenticated: isAuthenticated(),
      marketOpen: isMarketOpen(),
    }),
  );

  ws.on("message", (raw) => {
    try {
      const msg = JSON.parse(raw);
      // { type: "subscribe", tokens: [256265, ...] }
      if (msg.type === "subscribe" && Array.isArray(msg.tokens)) {
        subscribeTokens(msg.tokens);
      }
    } catch {}
  });

  ws.on("close", () => {
    clients.delete(ws);
    console.log(`[WS] Client disconnected (total: ${clients.size})`);
  });
  ws.on("error", () => clients.delete(ws));
});

// ─── SMC Scanner — every minute, Mon–Fri, 9:21 AM – 3:30 PM ──────────────────
schedule.scheduleJob("* 9-15 * * 1-5", async () => {
  if (!isAuthenticated()) return;

  const now = new Date();
  const h = now.getHours(),
    m = now.getMinutes();
  // Only fire 9:21 AM onwards, stop at 15:30
  if (h === 9 && m < 21) return;
  if (h === 15 && m > 30) return;

  try {
    const { getLiveExpiries } = require("./src/services/kiteService");
    const expiries = await getLiveExpiries().catch(() => []);
    if (!expiries.length) return;
    const expiry = expiries[0]; // nearest weekly expiry
    await smcRoutes.doScan(expiry);
  } catch (err) {
    console.error("[SMC Cron] Error:", err.message);
  }
});

// ─── 9:15 AM — Session open notification ──────────────────────────────────────
schedule.scheduleJob("15 9 * * 1-5", () => {
  const { sendSessionOpen } = require("./src/services/telegramService");
  sendSessionOpen();
});

// ─── 3:30 PM — Session close notification ─────────────────────────────────────
schedule.scheduleJob("30 15 * * 1-5", () => {
  const { sendSessionClose } = require("./src/services/telegramService");
  sendSessionClose();
});

// ─── Session summary at 15:21 (after all positions are force-closed at 15:20) ──
schedule.scheduleJob("21 15 * * 1-5", async () => {
  try {
    const { sendSessionSummary } = require("./src/services/telegramService");
    const todayAlerts = smcRoutes.getTodayAlerts();
    if (todayAlerts.length) {
      console.log(
        `[SMC] Sending session summary — ${todayAlerts.length} trades`,
      );
      await sendSessionSummary(todayAlerts);
    }
  } catch (err) {
    console.error("[SMC Session Summary] Error:", err.message);
  }
});

// ─── MongoDB: connect on startup + sync alerts every second ──────────────────
connectDB();
setInterval(() => {
  const all = smcRoutes.getAllAlerts?.() ?? [];
  if (all.length) syncAlerts(all).catch(() => {});
}, 1000);

// ─── Start ────────────────────────────────────────────────────────────────────
const { isConfigured: tgOk } = require("./src/services/telegramService");

server.listen(PORT, () => {
  console.log(`
╔══════════════════════════════════════════════════╗
║   NIFTY OPTIONS ALGO  —  Backend                 ║
║   REST   http://localhost:${PORT}                   ║
║   WS     ws://localhost:${PORT}                     ║
╠══════════════════════════════════════════════════╣
║   GET  /api/health                               ║
║   GET  /api/auth/login                           ║
║   GET  /api/options/chain/:expiry                ║
║   GET  /api/smc/alerts?expiry=...                ║
║   GET  /api/smc/status                           ║
║   POST /api/smc/scan?expiry=...                  ║
║   DEL  /api/smc/clear                            ║
║   GET  /api/watchlist                            ║
╚══════════════════════════════════════════════════╝
  `);
  if (tgOk()) {
    const { sendStartupPing } = require("./src/services/telegramService");
    sendStartupPing();
    console.log("[Telegram] Startup ping sent");
  }
});

process.on("SIGINT", () => {
  stopTicker();
  server.close();
  process.exit(0);
});
process.on("SIGTERM", () => {
  stopTicker();
  server.close();
});
