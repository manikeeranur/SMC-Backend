const express = require("express");
const router  = express.Router();
const fs      = require("fs");
const path    = require("path");
const { getClient, setAccessToken, getAccessToken, getUserName, setUserName, isAuthenticated, clearToken } = require("../config/kite");
require("dotenv").config();

const ENV_PATH = path.resolve(__dirname, "../../.env");

function saveTokenToEnv(token) {
  try {
    let content = fs.readFileSync(ENV_PATH, "utf8");
    if (content.includes("KITE_ACCESS_TOKEN=")) {
      content = content.replace(/^KITE_ACCESS_TOKEN=.*$/m, `KITE_ACCESS_TOKEN=${token}`);
    } else {
      content += `\nKITE_ACCESS_TOKEN=${token}\n`;
    }
    fs.writeFileSync(ENV_PATH, content);
    console.log("[Auth] KITE_ACCESS_TOKEN saved to .env");
  } catch (err) {
    console.warn("[Auth] Could not save token to .env:", err.message);
  }
}

function removeTokenFromEnv() {
  try {
    let content = fs.readFileSync(ENV_PATH, "utf8");
    content = content.replace(/^KITE_ACCESS_TOKEN=.*\n?/m, "");
    fs.writeFileSync(ENV_PATH, content);
  } catch {}
}

const FRONTEND = process.env.FRONTEND_URL || "http://localhost:3000";

// Auto-sync token to Render env vars so it survives service restarts
async function syncTokenToRender(newToken) {
  const apiKey    = process.env.RENDER_API_KEY;
  const serviceId = process.env.RENDER_SERVICE_ID;
  if (!apiKey || !serviceId) return;
  const url     = `https://api.render.com/v1/services/${serviceId}/env-vars`;
  const headers = { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" };
  try {
    const existing = await fetch(url, { headers }).then(r => r.json());
    const vars = existing
      .map(e => ({ key: e.envVar.key, value: e.envVar.value }))
      .filter(e => e.key !== "KITE_ACCESS_TOKEN");
    vars.push({ key: "KITE_ACCESS_TOKEN", value: newToken });
    await fetch(url, { method: "PUT", headers, body: JSON.stringify(vars) });
    console.log("[Auth] KITE_ACCESS_TOKEN synced to Render env vars");
  } catch (err) {
    console.warn("[Auth] Render sync failed (non-critical):", err.message);
  }
}

// GET /api/auth/login  →  returns Kite login URL
router.get("/login", (req, res) => {
  try {
    const loginUrl = getClient().getLoginURL();
    res.json({ loginUrl });
  } catch (err) {
    res.status(500).json({ error: "Invalid API key — check KITE_API_KEY in backend/.env" });
  }
});

// GET /api/auth/callback?request_token=xxx
// Kite redirects here after user logs in.
// Exchanges request_token → access_token, then redirects browser to frontend.
router.get("/callback", async (req, res) => {
  const { request_token } = req.query;
  if (!request_token) {
    return res.redirect(`${FRONTEND}/?kite=error&msg=Missing+request_token`);
  }
  try {
    const session = await getClient().generateSession(
      request_token,
      process.env.KITE_API_SECRET
    );
    setAccessToken(session.access_token);
    setUserName(session.user_name || "");
    console.log(`[Auth] Logged in as ${session.user_name} (${session.user_id})`);
    saveTokenToEnv(session.access_token);
    syncTokenToRender(session.access_token); // fire-and-forget
    // Redirect browser back to frontend with success flag
    res.redirect(`${FRONTEND}/?kite=connected&user=${encodeURIComponent(session.user_name)}`);
  } catch (err) {
    console.error("[Auth] Callback error:", err.message);
    res.redirect(`${FRONTEND}/?kite=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// POST /api/auth/token  { access_token }  →  set token directly (dev shortcut)
router.post("/token", async (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: "Missing access_token" });
  setAccessToken(access_token);
  saveTokenToEnv(access_token);
  try {
    const profile = await getClient().getProfile();
    setUserName(profile.user_name || profile.user_id || "");
    console.log(`[Auth] Manual token set for ${profile.user_name}`);
    res.json({ success: true, authenticated: true, user_name: profile.user_name });
  } catch {
    res.json({ success: true, authenticated: true, user_name: "" });
  }
});

// GET /api/auth/status
router.get("/status", (req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

// GET /api/auth/token-value  →  returns current token + username
router.get("/token-value", (req, res) => {
  const token = getAccessToken();
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  res.json({ access_token: token, user_name: getUserName() });
});

// POST /api/auth/logout  →  clear token and session
router.post("/logout", (req, res) => {
  clearToken();
  removeTokenFromEnv();
  console.log("[Auth] Logged out — token cleared");
  res.json({ success: true, authenticated: false });
});

module.exports = router;
