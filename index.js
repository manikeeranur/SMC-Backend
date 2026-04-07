process.env.TZ = "Asia/Kolkata"; // MUST be first line — fixes all getHours()/cron on UTC servers (AWS)
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
  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes(), day = ist.getDay();
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

// ─── SMC Scanner — every minute, Mon–Fri, 9:21 AM – 3:30 PM IST ──────────────
schedule.scheduleJob({ rule: "* 9-15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
  if (!isAuthenticated()) return;

  const ist = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
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

// ─── 9:15 AM IST — Session open notification ──────────────────────────────────
schedule.scheduleJob({ rule: "15 9 * * 1-5", tz: "Asia/Kolkata" }, () => {
  const { sendSessionOpen } = require("./src/services/telegramService");
  sendSessionOpen();
});

// ─── 3:30 PM IST — Session close notification ─────────────────────────────────
schedule.scheduleJob({ rule: "30 15 * * 1-5", tz: "Asia/Kolkata" }, () => {
  const { sendSessionClose } = require("./src/services/telegramService");
  sendSessionClose();
});

// ─── 15:20 IST — Safety-net square-off (cancel SL-M + exit all open NFO MIS) ──
schedule.scheduleJob({ rule: "20 15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
  if (!isAuthenticated()) return;
  console.log("[EOD] 15:20 square-off triggered");
  const { getClient } = require("./src/config/kite");
  const { EXCHANGE, PRODUCT } = require("./src/config/constants");
  try {
    // 1. Cancel all open SL-M orders in NFO
    const allOrders = await getClient().getOrders().catch(() => []);
    const openSLMs  = allOrders.filter(o =>
      o.exchange         === EXCHANGE &&
      o.order_type       === "SL-M" &&
      o.transaction_type === "SELL" &&
      (o.status === "TRIGGER PENDING" || o.status === "OPEN")
    );
    for (const o of openSLMs) {
      await getClient().cancelOrder(o.variety || "regular", o.order_id)
        .catch(e => console.warn(`[EOD] SL-M cancel warn [${o.order_id}] — ${e.message}`));
      console.log(`[EOD] Cancelled SL-M [${o.order_id}] ${o.tradingsymbol}`);
    }

    // 2. Exit all open MIS long positions in NFO
    const { net } = await getClient().getPositions();
    const openLongs = (net || []).filter(p =>
      p.exchange === EXCHANGE && p.product === PRODUCT && p.quantity > 0
    );
    for (const p of openLongs) {
      await getClient().placeOrder("regular", {
        exchange:          EXCHANGE,
        tradingsymbol:     p.tradingsymbol,
        transaction_type:  "SELL",
        quantity:          p.quantity,
        product:           PRODUCT,
        order_type:        "MARKET",
        validity:          "DAY",
        market_protection: 1,
        tag:               "EOD_EXIT",
      }).catch(e => console.error(`[EOD] Exit failed ${p.tradingsymbol} — ${e.message}`));
      console.log(`[EOD] Exited ${p.tradingsymbol} qty=${p.quantity}`);
    }
  } catch (err) {
    console.error("[EOD] Square-off error:", err.message);
  }
});

// ─── Session summary at 15:21 IST ─────────────────────────────────────────────
schedule.scheduleJob({ rule: "21 15 * * 1-5", tz: "Asia/Kolkata" }, async () => {
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
