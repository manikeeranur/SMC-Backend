const { getClient, isAuthenticated } = require("../config/kite");

// Instrument cache (refreshed every hour)
let instrumentsCache = null;
let instrumentsCacheTime = 0;

/**
 * Kite returns expiry as a JavaScript Date object set to midnight UTC,
 * but the actual expiry is midnight IST (UTC+5:30).
 * e.g. 2026-03-26 IST  →  2026-03-25T18:30:00Z UTC  →  toISOString = "2026-03-25" ← WRONG
 * Fix: add IST offset before formatting so we get the correct calendar date.
 */
function toISTDateStr(d) {
  const dt = d instanceof Date ? d : new Date(d);
  // Add 5h30m (IST offset) to shift from UTC back to the IST calendar date
  return new Date(dt.getTime() + 5.5 * 60 * 60 * 1000).toISOString().split("T")[0];
}

async function getNiftySpot() {
  if (!isAuthenticated()) throw new Error("Not authenticated");
  const quotes = await getClient().getQuote(["NSE:NIFTY 50"]);
  return quotes["NSE:NIFTY 50"].last_price;
}

async function getNFOInstruments() {
  const now = Date.now();
  if (instrumentsCache && now - instrumentsCacheTime < 3600000) return instrumentsCache;
  const instruments = await getClient().getInstruments("NFO");
  // Only keep NIFTY weekly/monthly options (not futures)
  instrumentsCache = instruments.filter(
    i => i.name === "NIFTY" && (i.instrument_type === "CE" || i.instrument_type === "PE")
  );
  instrumentsCacheTime = now;
  console.log(`[Instruments] Cached ${instrumentsCache.length} NIFTY option instruments`);
  return instrumentsCache;
}

/**
 * Get upcoming weekly expiry dates from LIVE Kite instruments.
 * Returns actual NSE dates (handles holidays when expiry moves off Thursday).
 */
async function getLiveExpiries() {
  const instruments = await getNFOInstruments();
  const todayIST = toISTDateStr(new Date());
  const unique = [...new Set(
    instruments
      .map(i => toISTDateStr(i.expiry))
      .filter(d => d >= todayIST)
  )].sort().slice(0, 6);
  console.log(`[Expiries] Live: ${unique.join(", ")}`);
  return unique.length ? unique : getNiftyExpiriesFallback();
}

/**
 * Fallback: next 6 Thursdays (used when not authenticated / instruments not loaded)
 */
function getNiftyExpiriesFallback() {
  const out = [];
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  for (let i = 0; i < 60; i++) {
    const d = new Date(nowIST);
    d.setUTCDate(nowIST.getUTCDate() + i);
    if (d.getUTCDay() === 4) {
      out.push(d.toISOString().split("T")[0]);
      if (out.length >= 6) break;
    }
  }
  return out;
}

// Kept for frontend demo mode (no auth needed)
function getNiftyExpiries() { return getNiftyExpiriesFallback(); }

function getATM(spot, step = 50) {
  return Math.round(spot / step) * step;
}

/**
 * Filter all NFO NIFTY option instruments for a given expiry date string "YYYY-MM-DD"
 */
async function getOptionChainInstruments(expiry) {
  const instruments = await getNFOInstruments();
  const matched = instruments.filter(i => {
    const iExpiry = toISTDateStr(i.expiry);  // fix timezone
    return iExpiry === expiry;
  });
  console.log(`[Instruments] Found ${matched.length} instruments for expiry ${expiry}`);

  // Debug: show available expiries if nothing matched
  if (matched.length === 0) {
    const available = [...new Set(instruments.map(i => toISTDateStr(i.expiry)))].sort().slice(0, 8);
    console.log(`[Instruments] Available expiries: ${available.join(", ")}`);
  }

  return matched;
}

async function getOptionQuotes(instruments) {
  if (!isAuthenticated()) throw new Error("Not authenticated");
  const symbols = instruments.map(i => `NFO:${i.tradingsymbol}`);
  const chunks  = [];
  for (let i = 0; i < symbols.length; i += 500) chunks.push(symbols.slice(i, i + 500));
  let quotes = {};
  for (const chunk of chunks) {
    const result = await getClient().getQuote(chunk);
    Object.assign(quotes, result);
  }
  return quotes;
}

module.exports = {
  getNiftySpot,
  getNFOInstruments,
  getNiftyExpiries,
  getLiveExpiries,
  getATM,
  getOptionChainInstruments,
  getOptionQuotes,
  toISTDateStr,
};
