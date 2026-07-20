const { KiteTicker } = require("kiteconnect");
const { getAccessToken, isAuthenticated } = require("../config/kite");
const tickExitMonitor = require("../services/tickExitMonitor");
require("dotenv").config();

// Always-on index tokens: NIFTY50, SENSEX, BANKNIFTY, FINNIFTY, MIDCAP, NIFTY NEXT50, BANKEX, VIX
const INDEX_TOKENS = [256265, 265, 260105, 257801, 288009, 270857, 274441, 264969];

let ticker       = null;
let clients      = new Set();
let subscribedTokens = new Set(INDEX_TOKENS); // accumulate all tokens across calls

// Our own reconnect loop — NOT the kiteconnect SDK's built-in one. The SDK's
// own attemptReconnection() calls process.exit(1) once it exhausts its retry
// budget, which kills the whole backend (not just the ticker) on something as
// routine as a stale/expired access token. We disable that (`reconnect:
// false` below) and handle reconnection ourselves so a dead broker session
// never takes down auto-trading, order placement, or anything else.
let reconnectTimer = null;
const RECONNECT_BASE_MS = 5_000;
const RECONNECT_MAX_MS  = 60_000;
let reconnectAttempt = 0;

function scheduleReconnect() {
  if (reconnectTimer) return; // already scheduled
  const delay = Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt++;
  console.log(`[Ticker] Reconnecting in ${delay / 1000}s (attempt ${reconnectAttempt})`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!isAuthenticated()) { console.log("[Ticker] No valid access token — will keep retrying"); }
    startTicker(clients);
  }, delay);
}

function startTicker(wsClients) {
  clients = wsClients;
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ticker) { ticker.disconnect(); ticker = null; }

  const accessToken = getAccessToken();
  if (!accessToken) { console.log("[Ticker] No access token — not started"); scheduleReconnect(); return; }

  ticker = new KiteTicker({ api_key: process.env.KITE_API_KEY, access_token: accessToken, reconnect: false });
  ticker.connect();

  ticker.on("ticks", (ticks) => {
    const msg = JSON.stringify({ type: "ticks", data: ticks });
    clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
    try { tickExitMonitor.onTicks(ticks); } catch (e) { console.error("[Ticker] tickExitMonitor error:", e.message); }
  });

  ticker.on("connect", () => {
    console.log("[Ticker] Connected");
    reconnectAttempt = 0;
    const tokens = [...subscribedTokens];
    if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
    console.log(`[Ticker] Subscribed ${tokens.length} tokens (incl. ${INDEX_TOKENS.length} indices)`);
  });

  ticker.on("disconnect", e => { console.log("[Ticker] Disconnected", e?.message ?? ""); scheduleReconnect(); });
  ticker.on("error",      e => console.error("[Ticker] Error", e?.message ?? ""));
}

function stopTicker() {
  if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  if (ticker) { ticker.disconnect(); ticker = null; }
}

function subscribeTokens(tokens) {
  if (!tokens?.length) return;
  tokens.forEach(t => subscribedTokens.add(t));
  if (!ticker) return;
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeFull, tokens);
}

module.exports = { startTicker, stopTicker, subscribeTokens };
