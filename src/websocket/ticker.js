const { KiteTicker } = require("kiteconnect");
const { getAccessToken } = require("../config/kite");
require("dotenv").config();

let ticker  = null;
let clients = new Set();

function startTicker(wsClients, tokens = []) {
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
    if (tokens.length) { ticker.subscribe(tokens); ticker.setMode(ticker.modeFull, tokens); }
  });

  ticker.on("disconnect", e  => console.log("[Ticker] Disconnected", e?.message ?? ""));
  ticker.on("error",      e  => console.error("[Ticker] Error", e?.message ?? ""));
  ticker.on("noreconnect",() => console.log("[Ticker] No reconnect"));
  ticker.on("reconnect",  (a,d) => console.log(`[Ticker] Reconnect #${a}, delay ${d}s`));
}

function stopTicker() { if (ticker) { ticker.disconnect(); ticker = null; } }

function subscribeTokens(tokens) {
  if (!ticker || !tokens?.length) return;
  ticker.subscribe(tokens);
  ticker.setMode(ticker.modeFull, tokens);
}

module.exports = { startTicker, stopTicker, subscribeTokens };
