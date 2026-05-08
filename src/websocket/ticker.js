const { KiteTicker } = require("kiteconnect");
const { getAccessToken } = require("../config/kite");
require("dotenv").config();

// Always-on index tokens: NIFTY50, SENSEX, BANKNIFTY, FINNIFTY, MIDCAP, NIFTY NEXT50, BANKEX, VIX
const INDEX_TOKENS = [256265, 265, 260105, 257801, 288009, 270857, 274441, 264969];

let ticker       = null;
let clients      = new Set();
let subscribedTokens = new Set(INDEX_TOKENS); // accumulate all tokens across calls

function startTicker(wsClients) {
  clients = wsClients;
  if (ticker) { ticker.disconnect(); ticker = null; }

  const accessToken = getAccessToken();
  if (!accessToken) { console.log("[Ticker] No access token — not started"); return; }

  ticker = new KiteTicker({ api_key: process.env.KITE_API_KEY, access_token: accessToken });
  ticker.connect();

  ticker.on("ticks", (ticks) => {
    const msg = JSON.stringify({ type: "ticks", data: ticks });
    clients.forEach(ws => { if (ws.readyState === 1) ws.send(msg); });
  });

  ticker.on("connect", () => {
    console.log("[Ticker] Connected");
    const tokens = [...subscribedTokens];
    if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
    console.log(`[Ticker] Subscribed ${tokens.length} tokens (incl. ${INDEX_TOKENS.length} indices)`);
  });

  ticker.on("disconnect", e  => console.log("[Ticker] Disconnected", e?.message ?? ""));
  ticker.on("error",      e  => console.error("[Ticker] Error", e?.message ?? ""));
  ticker.on("noreconnect",() => console.log("[Ticker] No reconnect"));
  ticker.on("reconnect",  (a,d) => console.log(`[Ticker] Reconnect #${a}, delay ${d}s`));
}

function stopTicker() { if (ticker) { ticker.disconnect(); ticker = null; } }

function subscribeTokens(tokens) {
  if (!tokens?.length) return;
  tokens.forEach(t => subscribedTokens.add(t));
  if (!ticker) return;
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeFull, tokens);
}

module.exports = { startTicker, stopTicker, subscribeTokens };
