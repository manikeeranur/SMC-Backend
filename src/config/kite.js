const { KiteConnect } = require("kiteconnect");
const fs   = require("fs");
const path = require("path");
require("dotenv").config();

const TOKEN_FILE = path.join(__dirname, "../../.kite_token");

let kc = null;
let accessToken = null;

function getClient() {
  if (!kc) {
    kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  }
  return kc;
}

function setAccessToken(token) {
  accessToken = token;
  getClient().setAccessToken(token);
  // Persist to disk so backend restarts don't require re-login
  try { fs.writeFileSync(TOKEN_FILE, token, "utf8"); } catch {}
}

function getAccessToken() { return accessToken; }
function isAuthenticated() { return !!accessToken; }

function clearToken() {
  accessToken = null;
  if (kc) kc.setAccessToken("");
  try { fs.unlinkSync(TOKEN_FILE); } catch {}
}

// ── On startup: restore token from env var (prod) or disk (local) ────────────
try {
  const fromEnv  = process.env.KITE_ACCESS_TOKEN?.trim();
  const fromDisk = (() => { try { return fs.readFileSync(TOKEN_FILE, "utf8").trim(); } catch { return null; } })();
  const saved    = fromEnv || fromDisk;
  if (saved) {
    accessToken = saved;
    getClient().setAccessToken(saved);
    console.log("[Auth] Restored access token from", fromEnv ? "env var" : "disk");
  }
} catch {}

module.exports = { getClient, setAccessToken, getAccessToken, isAuthenticated, clearToken };
