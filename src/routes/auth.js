const express = require("express");
const router  = express.Router();
const { getClient, setAccessToken, getAccessToken, isAuthenticated, clearToken } = require("../config/kite");
require("dotenv").config();

const FRONTEND = process.env.FRONTEND_URL || "http://localhost:3000";

const ALLOWED_FRONTENDS = [
  "https://smcfrontend.manikandan.site",
  "http://13.61.175.6:3000",
  "http://localhost:3000",
  FRONTEND,
].filter((v, i, a) => v && a.indexOf(v) === i);

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
    let loginUrl = getClient().getLoginURL();
    const origin = req.query.origin;
    if (origin && ALLOWED_FRONTENDS.includes(origin)) {
      loginUrl += `&redirect_params=${encodeURIComponent(`origin=${encodeURIComponent(origin)}`)}`;
    }
    res.json({ loginUrl });
  } catch (err) {
    res.status(500).json({ error: "Invalid API key — check KITE_API_KEY in backend/.env" });
  }
});

// GET /api/auth/callback?request_token=xxx
// Kite redirects here after user logs in.
// Exchanges request_token → access_token, then redirects browser to frontend.
router.get("/callback", async (req, res) => {
  const { request_token, origin } = req.query;
  const frontend = (origin && ALLOWED_FRONTENDS.includes(origin)) ? origin : FRONTEND;
  if (!request_token) {
    return res.redirect(`${frontend}/?kite=error&msg=Missing+request_token`);
  }
  try {
    const session = await getClient().generateSession(
      request_token,
      process.env.KITE_API_SECRET
    );
    setAccessToken(session.access_token);
    console.log(`[Auth] Logged in as ${session.user_name} (${session.user_id})`);
    syncTokenToRender(session.access_token); // fire-and-forget
    // Redirect browser back to frontend with success flag
    res.redirect(`${frontend}/?kite=connected&user=${encodeURIComponent(session.user_name)}`);
  } catch (err) {
    console.error("[Auth] Callback error:", err.message);
    res.redirect(`${frontend}/?kite=error&msg=${encodeURIComponent(err.message)}`);
  }
});

// POST /api/auth/token  { access_token }  →  set token directly (dev shortcut)
router.post("/token", (req, res) => {
  const { access_token } = req.body;
  if (!access_token) return res.status(400).json({ error: "Missing access_token" });
  setAccessToken(access_token);
  res.json({ success: true, authenticated: true });
});

// GET /api/auth/status
router.get("/status", (req, res) => {
  res.json({ authenticated: isAuthenticated() });
});

// GET /api/auth/token-value  →  returns current token (use once to copy into Render env var)
router.get("/token-value", (req, res) => {
  const token = getAccessToken();
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  res.json({ access_token: token });
});

// GET /api/auth/profile  →  Kite user profile (name, id, avatar)
router.get("/profile", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  try {
    const p = await getClient().getProfile();
    res.json({
      user_id:    p.user_id,
      user_name:  p.user_name,
      email:      p.email      || null,
      avatar_url: p.avatar_url || p.avatar || null,
      broker:     p.broker     || "ZERODHA",
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/logout  →  UI logout only, backend retains token for scanning
router.post("/logout", (req, res) => {
  console.log("[Auth] UI logout — backend token retained, scanning continues");
  res.json({ success: true, authenticated: false });
});

module.exports = router;
