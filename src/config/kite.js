const { KiteConnect } = require("kiteconnect");
require("dotenv").config();

let kc = null;
let accessToken = null;

function getClient() {
  if (!kc) {
    kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  }
  return kc;
}

function setAccessToken(token) {
  console.log(`[Auth] Setting access token: ${token}`);
  accessToken = token;
  getClient().setAccessToken(token);
}

function getAccessToken() { return accessToken; }
function isAuthenticated() {
  console.log(`[Auth] isAuthenticated check: accessToken is ${accessToken ? "set" : "not set"}. Returning ${!!accessToken}`);
  return !!accessToken;
}

function clearToken() {
  accessToken = null;
  if (kc) kc.setAccessToken("");
}

// ── On startup: restore token from env var only (prod use) ───────────────────
try {
  const fromEnv = process.env.KITE_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    console.log(`[Auth] Restoring access token from env var: ${fromEnv}`);
    accessToken = fromEnv;
    getClient().setAccessToken(fromEnv);
    console.log("[Auth] Restored access token from env var");
  }
} catch {}

module.exports = { getClient, setAccessToken, getAccessToken, isAuthenticated, clearToken };
