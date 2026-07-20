"use strict";

const express = require("express");
const router  = express.Router();
const settingsService = require("../services/settingsService");

// GET /api/settings — read-or-create the single shared settings document
router.get("/", async (req, res) => {
  try {
    const settings = await settingsService.loadOrCreate();
    res.json(settings);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/settings/account-defaults — partial update of accountDefaults
router.patch("/account-defaults", async (req, res) => {
  try {
    const settings = await settingsService.patchAccountDefaults(req.body || {});
    res.json(settings);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

// PATCH /api/settings/global-lock — partial update of { on, pts }
router.patch("/global-lock", async (req, res) => {
  try {
    const settings = await settingsService.setGlobalLock(req.body || {});
    res.json(settings);
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

module.exports = router;
