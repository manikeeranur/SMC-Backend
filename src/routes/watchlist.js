const express = require("express");
const router  = express.Router();
const { calcPnL, calcRR } = require("../services/analysisService");

let watchlist = [];

// GET /api/watchlist
router.get("/", (req, res) => res.json(watchlist));

// POST /api/watchlist  { leg }
router.post("/", (req, res) => {
  const { leg } = req.body;
  if (!leg) return res.status(400).json({ error: "Missing leg" });
  if (watchlist.find(w => w.leg.token === leg.token))
    return res.status(409).json({ error: "Already in watchlist" });

  const rr   = calcRR(leg.ltp);
  const item = {
    leg, entryPrice: leg.ltp, rr,
    addedAt:    new Date().toLocaleTimeString("en-IN", { hour12: false }),
    status:     "ACTIVE",
    currentPnL: 0,
    pnlPct:     0,
  };
  watchlist.unshift(item);
  res.json(item);
});

// PATCH /api/watchlist/:token  { currentPrice }
router.patch("/:token", (req, res) => {
  const token = Number(req.params.token);
  const { currentPrice } = req.body;
  if (!currentPrice) return res.status(400).json({ error: "Missing currentPrice" });

  const idx = watchlist.findIndex(w => w.leg.token === token);
  if (idx === -1) return res.status(404).json({ error: "Not found" });

  const w = watchlist[idx];
  const { pnl, pct, status } = calcPnL(currentPrice, w.rr);
  watchlist[idx] = {
    ...w,
    leg:        { ...w.leg, ltp: currentPrice },
    currentPnL: pnl,
    pnlPct:     pct,
    status:     w.status !== "ACTIVE" ? w.status : status,
  };
  res.json(watchlist[idx]);
});

// DELETE /api/watchlist/:token
router.delete("/:token", (req, res) => {
  const token = Number(req.params.token);
  watchlist   = watchlist.filter(w => w.leg.token !== token);
  res.json({ success: true });
});

// DELETE /api/watchlist  (clear all)
router.delete("/", (req, res) => { watchlist = []; res.json({ success: true }); });

module.exports = router;
