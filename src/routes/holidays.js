"use strict";

const express = require("express");
const router  = express.Router();

// ─── NSE market holidays ──────────────────────────────────────────────────────
// Kite Connect has no holiday-calendar endpoint. Upstox publishes the same
// NSE/BSE holiday calendar on a free, unauthenticated public endpoint — the
// standard community workaround for this gap (see
// https://kite.trade/forum/discussion/3069/check-market-holiday-market-holiday-or-muhurat-solution).
// Cached in-memory since the yearly calendar essentially never changes.
const UPSTOX_HOLIDAYS_URL = "https://api.upstox.com/v2/market/holidays";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000; // 12h

let cache = { at: 0, holidays: [] };

// A "full holiday" = NSE is in closed_exchanges and NOT also listed in
// open_exchanges (some entries, e.g. Budget Day, close settlement segments
// but keep NSE/NFO open on a special timing — those aren't trading holidays).
function isFullHoliday(entry) {
  return !!entry.closed_exchanges?.includes("NSE")
    && !entry.open_exchanges?.some(e => e.exchange === "NSE");
}

async function fetchHolidays() {
  const res = await fetch(UPSTOX_HOLIDAYS_URL);
  if (!res.ok) throw new Error(`Upstox holidays fetch failed: ${res.status}`);
  const json = await res.json();
  return (json.data ?? [])
    .filter(isFullHoliday)
    .map(e => ({ date: e.date, name: e.description }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

// GET /api/holidays — full-day NSE/NFO trading holidays
router.get("/", async (_req, res) => {
  try {
    if (Date.now() - cache.at > CACHE_TTL_MS || cache.holidays.length === 0) {
      cache = { at: Date.now(), holidays: await fetchHolidays() };
    }
    res.json({ holidays: cache.holidays });
  } catch (err) {
    if (cache.holidays.length > 0) {
      // Serve the stale cache rather than fail outright
      return res.json({ holidays: cache.holidays, stale: true });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
