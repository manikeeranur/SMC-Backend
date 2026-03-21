const express  = require("express");
const router   = express.Router();
const { buildOptionChain } = require("../services/optionChainService");
const { runScanner, calcRR, is926 } = require("../services/analysisService");
const { isAuthenticated } = require("../config/kite");

let lastScan = null;

// GET /api/analysis/scan/:expiry?min_premium=200&force=true
router.get("/scan/:expiry", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  // Block before 9:26 unless force=true
  if (!is926() && req.query.force !== "true") {
    const n = new Date();
    const h = n.getHours(), m = n.getMinutes(), s = n.getSeconds();
    const totalSec = (9-h)*3600 + (26-m-1)*60 + (60-s);
    const mm = Math.floor(totalSec/60), ss = totalSec%60;
    return res.json({
      active: false,
      message: "Scanner activates at 9:26 AM",
      countdown: `${String(mm).padStart(2,"0")}:${String(ss).padStart(2,"0")}`,
    });
  }

  try {
    const { expiry }   = req.params;
    const minPremium   = Number(req.query.min_premium) || 200;
    const data         = await buildOptionChain(expiry);
    const result       = runScanner(data.rows, data.spot, minPremium);

    if (result.ce) result.ce.rr = calcRR(result.ce.ltp);
    if (result.pe) result.pe.rr = calcRR(result.pe.ltp);

    lastScan = { ...result, expiry, scannedAt: new Date().toISOString() };
    res.json(lastScan);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/analysis/last-scan
router.get("/last-scan", (req, res) => {
  res.json(lastScan ?? { active: false, message: "No scan run yet" });
});

// GET /api/analysis/rr?entry=300
router.get("/rr", (req, res) => {
  const entry = Number(req.query.entry);
  if (!entry || entry <= 0) return res.status(400).json({ error: "Provide ?entry=price" });
  const { calcRR } = require("../services/analysisService");
  res.json(calcRR(entry));
});

module.exports = router;
module.exports.setLastScan = (data) => { lastScan = data; };
