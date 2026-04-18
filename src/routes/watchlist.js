const express = require("express");
const router  = express.Router();
const WatchlistModel = require("../models/Watchlist");
const { isConnected } = require("../config/db");

// ── Helpers ──────────────────────────────────────────────────────────────────
function useDB() { return isConnected(); }

// ── GET /api/watchlist/groups  — load all watchlist groups ──────────────────
router.get("/groups", async (req, res) => {
  if (!useDB()) return res.json({ groups: [] });
  try {
    const docs = await WatchlistModel.find({}).sort({ updatedAt: 1 }).lean();
    const groups = docs.map(d => ({ id: d.groupId, name: d.name, items: d.items ?? [] }));
    // Ensure default group always exists
    if (!groups.find(g => g.id === "wl_default")) {
      groups.unshift({ id: "wl_default", name: "My Watchlist", items: [] });
    }
    res.json({ groups });
  } catch (err) {
    console.error("[Watchlist] GET groups error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── PUT /api/watchlist/groups/:groupId  — upsert a watchlist group ──────────
router.put("/groups/:groupId", async (req, res) => {
  const { groupId } = req.params;
  const { name, items } = req.body;
  if (!name) return res.status(400).json({ error: "Missing name" });
  if (!useDB()) return res.json({ ok: true });
  try {
    await WatchlistModel.findOneAndUpdate(
      { groupId },
      { groupId, name, items: items ?? [], updatedAt: new Date() },
      { upsert: true, new: true }
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("[Watchlist] PUT group error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── DELETE /api/watchlist/groups/:groupId  — delete a watchlist group ───────
router.delete("/groups/:groupId", async (req, res) => {
  const { groupId } = req.params;
  if (groupId === "wl_default") return res.status(400).json({ error: "Cannot delete default watchlist" });
  if (!useDB()) return res.json({ ok: true });
  try {
    await WatchlistModel.deleteOne({ groupId });
    res.json({ ok: true });
  } catch (err) {
    console.error("[Watchlist] DELETE group error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ── Legacy single-list endpoints (kept for backward compat) ──────────────────
let legacyList = [];
router.get("/",        (req, res) => res.json(legacyList));
router.post("/",       (req, res) => { const { leg } = req.body; if (!leg) return res.status(400).json({ error: "Missing leg" }); legacyList.unshift({ leg, entryPrice: leg.ltp, addedAt: new Date().toLocaleTimeString("en-IN",{hour12:false}), status:"ACTIVE", currentPnL:0, pnlPct:0 }); res.json(legacyList[0]); });
router.delete("/:token", (req, res) => { legacyList = legacyList.filter(w => w.leg.token !== Number(req.params.token)); res.json({ success: true }); });
router.delete("/",     (req, res) => { legacyList = []; res.json({ success: true }); });

module.exports = router;
