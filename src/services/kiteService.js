const { getClient, isAuthenticated } = require("../config/kite");

// Instrument cache (refreshed every hour)
let instrumentsCache = null;
let instrumentsCacheTime = 0;

// SENSEX instrument cache
let bfoCache = null;
let bfoCacheTime = 0;

// NSE equity instrument cache (for search)
let nseEqCache = null;
let nseEqCacheTime = 0;

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

async function getSensexSpot() {
  if (!isAuthenticated()) throw new Error("Not authenticated");
  const quotes = await getClient().getQuote(["BSE:SENSEX"]);
  return quotes["BSE:SENSEX"].last_price;
}

async function getBFOInstruments() {
  const now = Date.now();
  if (bfoCache && now - bfoCacheTime < 3600000) return bfoCache;
  const instruments = await getClient().getInstruments("BFO");
  bfoCache = instruments.filter(
    i => i.name === "SENSEX" && (i.instrument_type === "CE" || i.instrument_type === "PE")
  );
  bfoCacheTime = now;
  console.log(`[Instruments] Cached ${bfoCache.length} SENSEX option instruments`);
  return bfoCache;
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
async function getLiveExpiries(index = "NIFTY") {
  const instruments = index === "SENSEX" ? await getBFOInstruments() : await getNFOInstruments();
  const fallback    = index === "SENSEX" ? getSensexExpiriesFallback() : getNiftyExpiriesFallback();
  const todayIST = toISTDateStr(new Date());
  const unique = [...new Set(
    instruments
      .map(i => toISTDateStr(i.expiry))
      .filter(d => d >= todayIST)
  )].sort().slice(0, 6);
  console.log(`[Expiries] Live (${index}): ${unique.join(", ")}`);
  return unique.length ? unique : fallback;
}

/**
 * Fallback expiry generator — NIFTY expires Thursdays (4), SENSEX expires Fridays (5)
 */
function getExpiriesFallback(weekday = 4) {
  const out = [];
  const nowIST = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
  for (let i = 0; i < 60; i++) {
    const d = new Date(nowIST);
    d.setUTCDate(nowIST.getUTCDate() + i);
    if (d.getUTCDay() === weekday) {
      out.push(d.toISOString().split("T")[0]);
      if (out.length >= 6) break;
    }
  }
  return out;
}

function getNiftyExpiriesFallback()  { return getExpiriesFallback(4); } // Thursday
function getSensexExpiriesFallback() { return getExpiriesFallback(5); } // Friday

// Kept for frontend demo mode (no auth needed)
function getNiftyExpiries() { return getNiftyExpiriesFallback(); }

function getATM(spot, step = 50) {
  return Math.round(spot / step) * step;
}

/**
 * Filter all NFO NIFTY option instruments for a given expiry date string "YYYY-MM-DD"
 */
async function getOptionChainInstruments(expiry, index = "NIFTY") {
  const instruments = index === "SENSEX" ? await getBFOInstruments() : await getNFOInstruments();
  const matched = instruments.filter(i => {
    const iExpiry = toISTDateStr(i.expiry);
    return iExpiry === expiry;
  });
  console.log(`[Instruments] Found ${matched.length} ${index} instruments for expiry ${expiry}`);

  if (matched.length === 0) {
    const available = [...new Set(instruments.map(i => toISTDateStr(i.expiry)))].sort().slice(0, 8);
    console.log(`[Instruments] Available expiries: ${available.join(", ")}`);
  }
  return matched;
}

async function getOptionQuotes(instruments, index = "NIFTY") {
  if (!isAuthenticated()) throw new Error("Not authenticated");
  const exch = index === "SENSEX" ? "BFO" : "NFO";
  const symbols = instruments.map(i => `${exch}:${i.tradingsymbol}`);
  const chunks  = [];
  for (let i = 0; i < symbols.length; i += 500) chunks.push(symbols.slice(i, i + 500));
  let quotes = {};
  for (const chunk of chunks) {
    const result = await getClient().getQuote(chunk);
    Object.assign(quotes, result);
  }
  return quotes;
}

/**
 * Search NSE equity + NFO F&O instruments by symbol or company name.
 * Returns up to `limit` matches sorted by relevance.
 */
async function searchInstruments(query, limit = 15) {
  if (!query || query.trim().length < 1) return [];
  const q = query.trim().toUpperCase();

  // Refresh NSE equity cache every 6 hours
  const now = Date.now();
  if (!nseEqCache || now - nseEqCacheTime > 6 * 3600000) {
    try {
      const [nseInst, bseInst, nfoInst] = await Promise.all([
        getClient().getInstruments("NSE"),
        getClient().getInstruments("BSE"),
        getClient().getInstruments("NFO"),
      ]);
      // NSE equities
      const nseEquities = nseInst
        .filter(i => i.instrument_type === "EQ")
        .map(i => ({ token: i.instrument_token, tradingsymbol: i.tradingsymbol, name: i.name, exchange: "NSE", type: "EQ", ltp: i.last_price || 0 }));
      // BSE equities + indices (SENSEX, BANKEX, etc.)
      const bseEquities = bseInst
        .filter(i => i.instrument_type === "EQ" || i.instrument_type === "INDEX")
        .map(i => ({ token: i.instrument_token, tradingsymbol: i.tradingsymbol, name: i.name, exchange: "BSE", type: "EQ", ltp: i.last_price || 0 }));
      const equities = [...nseEquities, ...bseEquities];
      // NFO F&O stocks (not NIFTY/SENSEX, just stock options)
      const foStocks = [...new Set(nfoInst.filter(i => i.name && i.name !== "NIFTY").map(i => i.name))];
      nseEqCache = { equities, foStocks };
      nseEqCacheTime = now;
      console.log(`[Search] Cached ${nseEquities.length} NSE + ${bseEquities.length} BSE equities, ${foStocks.length} F&O stocks`);
    } catch (e) {
      console.error("[Search] Failed to load instruments:", e.message);
      return [];
    }
  }

  const { equities } = nseEqCache;

  // Score each instrument: exact symbol match = 100, starts-with = 50, contains = 10
  const scored = equities
    .map(inst => {
      const sym = inst.tradingsymbol.toUpperCase();
      const name = (inst.name || "").toUpperCase();
      let score = 0;
      if (sym === q) score = 100;
      else if (sym.startsWith(q)) score = 50 + (1 / sym.length);
      else if (name.startsWith(q)) score = 30;
      else if (sym.includes(q)) score = 10;
      else if (name.includes(q)) score = 5;
      return { ...inst, score };
    })
    .filter(i => i.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  return scored;
}

/**
 * Fetch live quotes for given instrument tokens.
 * tokens: array of "NSE:SYMBOL" or "NFO:SYMBOL" strings
 */
async function getQuotes(instruments) {
  if (!instruments.length) return {};
  const CHUNK = 200;
  let quotes = {};
  for (let i = 0; i < instruments.length; i += CHUNK) {
    const chunk = instruments.slice(i, i + CHUNK);
    try {
      const result = await getClient().getQuote(chunk);
      Object.assign(quotes, result);
    } catch {}
  }
  return quotes;
}

module.exports = {
  getNiftySpot,
  getSensexSpot,
  getNFOInstruments,
  getBFOInstruments,
  getNiftyExpiries,
  getLiveExpiries,
  getATM,
  getOptionChainInstruments,
  getOptionQuotes,
  toISTDateStr,
  searchInstruments,
  getQuotes,
};
