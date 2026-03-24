const { KiteConnect } = require("kiteconnect");
const path = require("path");
require("dotenv").config({ path: path.resolve(__dirname, "../../.env") });

let kc = null;
let accessToken = null;
let userName = "";

function getClient() {
  if (!kc) {
    kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  }
  return kc;
}

function setAccessToken(token) {
  accessToken = token;
  getClient().setAccessToken(token);
}

function getAccessToken() { return accessToken; }
function getUserName()    { return userName; }
function setUserName(n)   { userName = n; }
function isAuthenticated() { return !!accessToken; }

function clearToken() {
  accessToken = null;
  userName = "";
  if (kc) kc.setAccessToken("");
}

// ── On startup: restore token from env var only (prod use) ───────────────────
try {
  const fromEnv = process.env.KITE_ACCESS_TOKEN?.trim();
  if (fromEnv) {
    accessToken = fromEnv;
    getClient().setAccessToken(fromEnv);
    console.log("[Auth] Restored access token from env var");
  }
} catch {}

module.exports = { getClient, setAccessToken, getAccessToken, getUserName, setUserName, isAuthenticated, clearToken };
