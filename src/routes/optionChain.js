const express = require("express");
const router  = express.Router();
const { buildOptionChain } = require("../services/optionChainService");
const { getLiveExpiries, getNiftyExpiries, getATM, getOptionChainInstruments } = require("../services/kiteService");
const { isAuthenticated, clearToken, getClient } = require("../config/kite");

// ── RSI helpers ───────────────────────────────────────────────────────────────
function calcRollingRSI(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  if (closes.length < 2) return out;

  // Progressive warmup: use simple average until we have `period` changes,
  // then switch to Wilder's smoothed EMA. This ensures RSI values from candle 2
  // instead of leaving the first `period` candles empty.
  let sumGain = 0, sumLoss = 0;
  let ag = 0, al = 0;
  let warmedUp = false;

  for (let i = 1; i < closes.length; i++) {
    const d    = closes[i] - closes[i - 1];
    const gain = Math.max(d, 0);
    const loss = Math.max(-d, 0);

    if (!warmedUp) {
      sumGain += gain;
      sumLoss += loss;
      const count = i;                         // number of changes seen so far
      const simAG = sumGain / count;
      const simAL = sumLoss / count;
      out[i] = simAL === 0 ? 100 : +(100 - 100 / (1 + simAG / simAL)).toFixed(2);
      if (count >= period) {
        ag = sumGain / period;
        al = sumLoss / period;
        warmedUp = true;
      }
    } else {
      ag = (ag * (period - 1) + gain) / period;
      al = (al * (period - 1) + loss) / period;
      out[i] = al === 0 ? 100 : +(100 - 100 / (1 + ag / al)).toFixed(2);
    }
  }
  return out;
}

function calcEMA(closes, period) {
  if (!closes.length) return [];
  const k = 2 / (period + 1);
  const out = [closes[0]];
  for (let i = 1; i < closes.length; i++)
    out.push(+(out[i - 1] * (1 - k) + closes[i] * k).toFixed(2));
  return out;
}

function calcBB(closes, period = 20, mult = 2) {
  return closes.map((_, i) => {
    if (i < period - 1) return { mid: null, up: null, dn: null };
    const sl  = closes.slice(i - period + 1, i + 1);
    const mid = sl.reduce((a, b) => a + b, 0) / period;
    const sd  = Math.sqrt(sl.reduce((a, b) => a + (b - mid) ** 2, 0) / period);
    return { mid: +mid.toFixed(2), up: +(mid + mult * sd).toFixed(2), dn: +(mid - mult * sd).toFixed(2) };
  });
}

function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const ef = calcEMA(closes, fast);
  const es = calcEMA(closes, slow);
  const ml = ef.map((v, i) => +(v - es[i]).toFixed(2));
  const sl = calcEMA(ml, signal);
  return ml.map((v, i) => ({
    macd: v,
    sig:  +sl[i].toFixed(2),
    hist: +(v - sl[i]).toFixed(2),
  }));
}

function fmtIST(d) {
  const ist = new Date((d instanceof Date ? d : new Date(d)).getTime() + 5.5 * 60 * 60 * 1000);
  const dd = String(ist.getUTCDate()).padStart(2, "0");
  const mm = String(ist.getUTCMonth() + 1).padStart(2, "0");
  const hh = String(ist.getUTCHours()).padStart(2, "0");
  const mi = String(ist.getUTCMinutes()).padStart(2, "0");
  return `${dd}-${mm}-${ist.getUTCFullYear()} ${hh}:${mi}`;
}

// Per-expiry cache (2s TTL)
const cache = {};

// GET /api/options/expiries
// Returns live expiry dates from Kite when authenticated,
// fallback to Thursday-generation when not.
router.get("/expiries", async (req, res) => {
  try {
    const expiries = isAuthenticated()
      ? await getLiveExpiries()
      : getNiftyExpiries();
    res.json({ expiries });
  } catch (err) {
    res.json({ expiries: getNiftyExpiries() });
  }
});

// GET /api/options/chain/:expiry?strikes=15
router.get("/chain/:expiry", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated. POST /api/auth/token first." });

  const { expiry } = req.params;
  const cached = cache[expiry];
  if (cached && Date.now() - cached.ts < 500) return res.json(cached.data);

  try {
    const data = await buildOptionChain(expiry, Number(req.query.strikes) || 15);
    cache[expiry] = { ts: Date.now(), data };
    res.json(data);
  } catch (err) {
    console.error(`[Chain] Error for ${expiry}:`, err.message);
    // Kite returns this message when token is expired/invalid
    if (err.message && err.message.toLowerCase().includes("incorrect")) {
      clearToken();
      return res.status(401).json({ error: "Session expired. Please login again.", code: "TOKEN_INVALID" });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/options/open-prices?date=2026-03-21&tokens=123,456,789
// Returns the 9:15 AM open price for each token on the given date
router.get("/open-prices", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { date, tokens } = req.query;
  if (!date || !tokens)
    return res.status(400).json({ error: "date and tokens are required" });

  const tokenList = String(tokens).split(",").map(Number).filter(Boolean);
  const from = new Date(date); from.setHours(9, 15, 0, 0);
  const to   = new Date(date); to.setHours(9, 16, 0, 0);

  // Batch 5 at a time to stay within Kite rate limits
  const BATCH = 5;
  const prices = {};
  for (let i = 0; i < tokenList.length; i += BATCH) {
    const batch = tokenList.slice(i, i + BATCH);
    await Promise.all(batch.map(async token => {
      try {
        // args: (token, interval, from, to, continuous=false, oi=true)
        const candles = await getClient().getHistoricalData(token, "minute", from, to, false, true);
        prices[token] = candles[0]?.open ?? null;
      } catch {
        prices[token] = null;
      }
    }));
  }

  res.json({ prices });
});

// GET /api/options/candles?token=123456&date=2026-03-21&interval=minute   (single day)
// GET /api/options/candles?token=123456&from=2026-03-17&to=2026-03-21&interval=minute  (range)
router.get("/candles", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { token, date, from: fromParam, to: toParam, interval = "minute" } = req.query;
  if (!token || (!date && !fromParam))
    return res.status(400).json({ error: "token and date (or from/to) are required" });

  try {
    const from = new Date(fromParam || date); from.setHours(9, 15, 0, 0);
    const to   = new Date(toParam   || date); to.setHours(15, 30, 0, 0);

    // args: (token, interval, from, to, continuous=false, oi=true)
    const candles = await getClient().getHistoricalData(
      parseInt(token), interval, from, to, false, true
    );

    const closes  = candles.map(c => c.close);
    const rsiArr  = calcRollingRSI(closes, 14);
    const ema9arr  = calcEMA(closes, 9);
    const ema21arr = calcEMA(closes, 21);
    const bbArr    = calcBB(closes, 20, 2);
    const macdArr  = calcMACD(closes);

    const rows = candles.map((c, i) => ({
      date:     fmtIST(c.date),
      open:     c.open,
      high:     c.high,
      low:      c.low,
      close:    c.close,
      volume:   c.volume,
      oi:       c.oi,
      rsi14:    rsiArr[i],
      ema9:     ema9arr[i],
      ema21:    ema21arr[i],
      bbMid:    bbArr[i].mid,
      bbUp:     bbArr[i].up,
      bbDn:     bbArr[i].dn,
      macd:     macdArr[i].macd,
      macdSig:  macdArr[i].sig,
      macdHist: macdArr[i].hist,
    }));

    res.json({ rows });
  } catch (err) {
    console.error("[Candles] Error:", err.message);
    if (err.message && err.message.toLowerCase().includes("incorrect")) {
      clearToken();
      return res.status(401).json({ error: "Session expired. Please login again.", code: "TOKEN_INVALID" });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/options/historical-open-prices?date=2026-03-21&expiry=2026-03-27
// Fetches NIFTY spot at 9:15 AM on the selected date, calculates the historical ATM,
// then returns ±15 strikes from that ATM with their 9:15 AM opening prices.
router.get("/historical-open-prices", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { date, expiry } = req.query;
  if (!date || !expiry)
    return res.status(400).json({ error: "date and expiry are required" });

  try {
    const NIFTY50_TOKEN = 256265;
    const from = new Date(date); from.setHours(9, 15, 0, 0);
    const to   = new Date(date); to.setHours(9, 16, 0, 0);

    // 1. Fetch historical NIFTY 50 spot at 9:15 AM on the selected date
    const spotCandles = await getClient().getHistoricalData(NIFTY50_TOKEN, "minute", from, to, false, false);
    const spot = spotCandles[0]?.open ?? null;
    if (!spot) return res.status(404).json({ error: "No NIFTY data found for selected date" });

    // 2. Calculate historical ATM from that day's spot
    const atm = getATM(spot);

    // 3. Get instruments for the expiry
    const allInst = await getOptionChainInstruments(expiry);
    if (!allInst.length)
      return res.status(404).json({ error: `No instruments found for expiry ${expiry}` });

    // 4. Filter ±15 strikes from the historical ATM
    const N_EACH = 15;
    const wantStrikes = new Set();
    for (let i = -N_EACH; i <= N_EACH; i++) wantStrikes.add(atm + i * 50);
    let instruments = allInst.filter(i => wantStrikes.has(Number(i.strike)));
    if (!instruments.length) instruments = allInst;

    // 5. Build strike → {CE token, PE token} map
    const strikeMap = {};
    for (const inst of instruments) {
      const K = Number(inst.strike);
      if (!strikeMap[K]) strikeMap[K] = {};
      strikeMap[K][inst.instrument_type] = inst.instrument_token;
    }

    const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b)
      .filter(s => strikeMap[s].CE && strikeMap[s].PE);

    // 6. Batch fetch 9:15 AM open prices for all tokens
    const tokens = strikes.flatMap(s => [strikeMap[s].CE, strikeMap[s].PE]);
    const BATCH = 5;
    const prices = {};
    for (let i = 0; i < tokens.length; i += BATCH) {
      const batch = tokens.slice(i, i + BATCH);
      await Promise.all(batch.map(async token => {
        try {
          const candles = await getClient().getHistoricalData(token, "minute", from, to, false, true);
          prices[token] = candles[0]?.open ?? null;
        } catch {
          prices[token] = null;
        }
      }));
    }

    // 7. Build rows
    const rows = strikes.map(s => ({
      strike: s,
      isATM:  s === atm,
      ce: { token: strikeMap[s].CE, open: prices[strikeMap[s].CE] ?? null },
      pe: { token: strikeMap[s].PE, open: prices[strikeMap[s].PE] ?? null },
    }));

    console.log(`[HistoricalOpenPrices] date=${date} expiry=${expiry} spot=${spot} atm=${atm} rows=${rows.length}`);
    res.json({ spot: +spot.toFixed(2), atm, rows });
  } catch (err) {
    console.error("[HistoricalOpenPrices] Error:", err.message);
    if (err.message && err.message.toLowerCase().includes("incorrect")) {
      clearToken();
      return res.status(401).json({ error: "Session expired. Please login again.", code: "TOKEN_INVALID" });
    }
    res.status(500).json({ error: err.message });
  }
});

// GET /api/options/historical-scan?date=2026-03-20&expiry=2026-03-27
// Fetches 9:15–9:26 AM candles.
// OI/Vol ratio: computed from 9:15–9:25 window (scan window).
// Entry price (ltp): 9:26 AM candle open (actual trade entry candle).
router.get("/historical-scan", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { date, expiry } = req.query;
  if (!date || !expiry)
    return res.status(400).json({ error: "date and expiry are required" });

  try {
    const NIFTY50_TOKEN = 256265;
    // Fetch 9:15 to 9:27 so we get candles for 9:15, 9:16 … 9:25 AND the 9:26 entry candle
    const from = new Date(date); from.setHours(9, 15, 0, 0);
    const to   = new Date(date); to.setHours(9, 27, 0, 0);

    // 1. NIFTY spot at 9:15 AM
    const spotCandles = await getClient().getHistoricalData(NIFTY50_TOKEN, "minute", from, to, false, false);
    const spot = spotCandles[0]?.open ?? null;
    if (!spot) return res.status(404).json({ error: "No NIFTY spot data for this date (holiday or weekend?)" });

    const atm = getATM(spot);

    // 2. Get option instruments for the expiry
    const allInst = await getOptionChainInstruments(expiry);
    if (!allInst.length)
      return res.status(404).json({ error: `No instruments found for expiry ${expiry}. Expiry may have already passed.` });

    // Filter ±10 strikes around historical ATM
    const N_EACH = 10;
    const wantStrikes = new Set();
    for (let i = -N_EACH; i <= N_EACH; i++) wantStrikes.add(atm + i * 50);
    let instruments = allInst.filter(i => wantStrikes.has(Number(i.strike)));
    if (!instruments.length) instruments = allInst;

    // 3. Batch fetch 9:15–9:27 minute candles for each instrument
    const BATCH = 5;
    const candleMap = {};
    for (let i = 0; i < instruments.length; i += BATCH) {
      const batch = instruments.slice(i, i + BATCH);
      await Promise.all(batch.map(async inst => {
        try {
          const candles = await getClient().getHistoricalData(
            inst.instrument_token, "minute", from, to, false, true
          );
          candleMap[inst.instrument_token] = candles;
        } catch {
          candleMap[inst.instrument_token] = [];
        }
      }));
    }

    // Helper: is this candle's time the 9:26 candle?
    // Kite returns candle.date as a Date (UTC). 9:26 IST = 03:56 UTC.
    function is926Candle(c) {
      const d = new Date(c.date);
      const utcH = d.getUTCHours(), utcM = d.getUTCMinutes();
      return utcH === 3 && utcM === 56; // 9:26 IST = 3:56 UTC
    }
    function isScanWindow(c) {
      const d = new Date(c.date);
      const utcH = d.getUTCHours(), utcM = d.getUTCMinutes();
      // 9:15–9:25 IST = 3:45–3:55 UTC
      return (utcH === 3 && utcM >= 45 && utcM <= 55);
    }

    // 4. Build per-strike data
    const strikeMap = {};
    for (const inst of instruments) {
      const K   = Number(inst.strike);
      const typ = inst.instrument_type;
      const candles = candleMap[inst.instrument_token] || [];
      if (!candles.length) continue;

      // Scan window candles: 9:15–9:25 for OI/Vol
      const scanCandles = candles.filter(isScanWindow);
      // Entry candle: 9:26 AM open; fallback to last scan candle close
      const entryCandleVal = candles.find(is926Candle)?.open ?? candles[candles.length - 1]?.close ?? 0;

      const ltp    = entryCandleVal;                   // 9:26 AM entry price
      const volume = scanCandles.reduce((s, c) => s + (c.volume || 0), 0); // 9:15–9:25 cumulative
      const oi     = scanCandles.length ? scanCandles[scanCandles.length - 1].oi ?? 0 : 0;
      const openOI = scanCandles.length ? scanCandles[0].oi ?? oi : oi;

      if (!strikeMap[K]) strikeMap[K] = {};
      strikeMap[K][typ] = {
        token:      inst.instrument_token,
        strike:     K, type: typ,
        ltp,        volume,
        oi,         oiChange: oi - openOI,
        oiVolRatio: volume > 0 ? +(oi / volume).toFixed(3) : 999,
      };
    }

    // 5. Build rows (both CE + PE present)
    const strikes = Object.keys(strikeMap).map(Number).sort((a, b) => a - b)
      .filter(s => strikeMap[s].CE && strikeMap[s].PE);
    const rows = strikes.map(s => ({ strike: s, isATM: s === atm, ce: strikeMap[s].CE, pe: strikeMap[s].PE }));

    // 6. Scanner logic — filter LTP ≥ 200, sort by OI/Vol asc
    const MIN = 200;
    const sortBy = arr => [...arr].sort((a, b) => a.oiVolRatio - b.oiVolRatio);
    let ces = rows.filter(r => r.ce.ltp >= MIN).map(r => r.ce);
    let pes = rows.filter(r => r.pe.ltp >= MIN).map(r => r.pe);
    // Fallback thresholds if nothing found
    if (!ces.length && !pes.length) { ces = rows.filter(r => r.ce.ltp >= 100).map(r => r.ce); pes = rows.filter(r => r.pe.ltp >= 100).map(r => r.pe); }
    if (!ces.length && !pes.length) { ces = rows.map(r => r.ce); pes = rows.map(r => r.pe); }
    ces = sortBy(ces); pes = sortBy(pes);

    const bestCE = ces[0] ?? null;
    const bestPE = pes[0] ?? null;
    const ceOIVol = bestCE?.oiVolRatio ?? Infinity;
    const peOIVol = bestPE?.oiVolRatio ?? Infinity;
    let leader = null;
    if (bestCE && bestPE) leader = ceOIVol <= peOIVol ? bestCE : bestPE;
    else leader = bestCE ?? bestPE;

    console.log(`[HistoricalScan] date=${date} expiry=${expiry} spot=${spot} atm=${atm} leader=${leader?.type} ${leader?.strike} OIVol=${leader?.oiVolRatio}`);

    res.json({
      spot: +spot.toFixed(2), atm, date, expiry,
      leader, ce: bestCE, pe: bestPE,
      ceOIVol: ceOIVol === Infinity ? 0 : +ceOIVol.toFixed(3),
      peOIVol: peOIVol === Infinity ? 0 : +peOIVol.toFixed(3),
      atmIV: 15, // placeholder — IV at 9:15 AM not available without live quote
      scanTime: "09:26", active: !!leader,
      topCEs: ces.slice(0, 5), topPEs: pes.slice(0, 5),
    });
  } catch (err) {
    console.error("[HistoricalScan] Error:", err.message);
    if (err.message && err.message.toLowerCase().includes("incorrect")) {
      clearToken();
      return res.status(401).json({ error: "Session expired. Please login again.", code: "TOKEN_INVALID" });
    }
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
