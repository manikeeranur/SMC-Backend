const express = require("express");
const router  = express.Router();
const { getClient, setAccessToken, getAccessToken, isAuthenticated, clearToken } = require("../config/kite");
require("dotenv").config();

const FRONTEND = process.env.FRONTEND_URL || "http://localhost:3000";

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
    console.log(`[Auth] Logged in as ${session.user_name} (${session.user_id})`);
    // Redirect browser back to frontend with success flag
    res.redirect(`${FRONTEND}/?kite=connected&user=${encodeURIComponent(session.user_name)}`);
  } catch (err) {
    console.error("[Auth] Callback error:", err.message);
    res.redirect(`${FRONTEND}/?kite=error&msg=${encodeURIComponent(err.message)}`);
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

// POST /api/auth/logout  →  clear token and session
router.post("/logout", (req, res) => {
  clearToken();
  console.log("[Auth] Logged out — token cleared");
  res.json({ success: true, authenticated: false });
});

module.exports = router;
