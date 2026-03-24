/**
 * Harmonic Pattern Scanner — NSE Historical Data (Real Kite API)
 * GET /api/harmonics/scan?interval=1D&from=2025-12-01&to=2026-03-23&pattern=All&maxPrice=10000
 */

const express = require("express");
const router  = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");

// ─── NSE F&O Stocks (price < 10,000 only, excluding MARUTI/BANKNIFTY at times) ──
const NSE_STOCKS = [
  { symbol:"RELIANCE",   token:738561  },
  { symbol:"TCS",        token:2953217 },
  { symbol:"HDFCBANK",   token:341249  },
  { symbol:"INFY",       token:408065  },
  { symbol:"ICICIBANK",  token:1270529 },
  { symbol:"BAJFINANCE", token:225537  },
  { symbol:"SBIN",       token:779521  },
  { symbol:"TATAMOTORS", token:884737  },
  { symbol:"WIPRO",      token:969473  },
  { symbol:"AXISBANK",   token:1510401 },
  { symbol:"KOTAKBANK",  token:492033  },
  { symbol:"LT",         token:2939649 },
  { symbol:"TATASTEEL",  token:895745  },
  { symbol:"TITAN",      token:897537  },
  { symbol:"NIFTY 50",   token:256265  },
  { symbol:"BANKNIFTY",  token:260105  },
  { symbol:"BHARTIARTL", token:2714625 },
  { symbol:"ITC",        token:424961  },
  { symbol:"ONGC",       token:633601  },
  { symbol:"NTPC",       token:2977281 },
  { symbol:"POWERGRID",  token:3834113 },
  { symbol:"ASIANPAINT", token:60417   },
  { symbol:"HINDUNILVR", token:356865  },
  { symbol:"SUNPHARMA",  token:857857  },
  { symbol:"ULTRACEMCO", token:2952193 },
  { symbol:"JSWSTEEL",   token:3001089 },
  { symbol:"NESTLEIND",  token:4598529 },
];

// ─── Interval map ─────────────────────────────────────────────────────────────
const INTERVAL_MAP = {
  "5m":"5minute", "15m":"15minute", "30m":"30minute",
  "1H":"60minute", "4H":"60minute",
  "1D":"day", "1W":"week",
};

// Pattern shape type for UI
const SHAPE_MAP = {
  "Bat":"XABCD", "Half Bat":"XABCD", "Cypher":"XABCD",
  "Gartley":"XABCD", "Crab":"XABCD", "Butterfly":"XABCD",
  "ABCD":"ABCD",
  "N Pattern":"Continuation", "M Pattern":"Double Top", "W Pattern":"Double Bottom",
};

// How many candles to request based on interval
const DAYS_MAP = {
  "5m":10, "15m":20, "30m":30, "1H":60, "4H":90, "1D":180, "1W":365,
};

// ─── Chunked Historical Fetch (handles Kite's 100-day limit) ─────────────────
const CHUNK_DAYS = { day:90, week:400, "60minute":60, "15minute":30, "5minute":10 };

async function fetchChunkedCandles(token, kiteInterval, from, to) {
  const chunkDays = CHUNK_DAYS[kiteInterval] || 90;
  const MS = chunkDays * 86400000;
  const allCandles = [];
  let cursor = new Date(from);
  const toTime = new Date(to).getTime();

  while (cursor.getTime() < toTime) {
    const chunkTo = new Date(Math.min(cursor.getTime() + MS, toTime));
    const candles  = await getClient().getHistoricalData(
      token, kiteInterval, cursor, chunkTo, false, false
    );
    if (candles.length) allCandles.push(...candles);
    cursor = new Date(chunkTo.getTime() + 86400000); // next chunk starts day after
  }

  // Deduplicate by date string (overlapping boundaries)
  const seen = new Set();
  return allCandles.filter(c => {
    const key = String(c.date);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ─── ZigZag Swing Detector ────────────────────────────────────────────────────
function detectSwings(candles, deviation = 0.03) {
  const swings = [];
  if (candles.length < 5) return swings;

  let lastType  = null;
  let lastIdx   = 0;
  let lastPrice = candles[0].high;

  for (let i = 1; i < candles.length; i++) {
    const c = candles[i];
    if (lastType !== "low") {
      if (c.high >= lastPrice) { lastPrice = c.high; lastIdx = i; }
      else if ((lastPrice - c.low) / lastPrice >= deviation) {
        swings.push({ index:lastIdx, price:lastPrice, date:candles[lastIdx].date, type:"high" });
        lastType = "low"; lastPrice = c.low; lastIdx = i;
      }
    } else {
      if (c.low <= lastPrice) { lastPrice = c.low; lastIdx = i; }
      else if ((c.high - lastPrice) / c.high >= deviation) {
        swings.push({ index:lastIdx, price:lastPrice, date:candles[lastIdx].date, type:"low" });
        lastType = "high"; lastPrice = c.high; lastIdx = i;
      }
    }
  }
  if (lastIdx > 0) {
    swings.push({ index:lastIdx, price:lastPrice, date:candles[lastIdx].date, type:lastType||"high" });
  }
  return swings;
}

// ─── Fibonacci Helpers ────────────────────────────────────────────────────────
function retrace(from, to, point) {
  const full = Math.abs(to - from);
  return full === 0 ? 0 : Math.abs(point - to) / full;
}
function within(val, target, tol = 0.06) { return Math.abs(val - target) <= tol; }
function extension(from, to, point) {
  const full = Math.abs(to - from);
  return full === 0 ? 0 : Math.abs(point - from) / full;
}

// ─── Pattern Validators — returns { valid, ratios } ──────────────────────────
function checkBat(X, A, B, C, D) {
  const ab = retrace(X, A, B);
  const bc = retrace(A, B, C);
  const xd = retrace(X, A, D);
  return ab >= 0.33 && ab <= 0.55 && bc >= 0.33 && bc <= 0.91 && within(xd, 0.886, 0.04);
}

function checkHalfBat(X, A, B, C, D) {
  const ab = retrace(X, A, B);
  const bc = retrace(A, B, C);
  const xd = retrace(X, A, D);
  return ab >= 0.38 && ab <= 0.62 && bc >= 0.33 && bc <= 0.91 && within(xd, 0.500, 0.05);
}

function checkCypher(X, A, B, C, D) {
  const xaLen = Math.abs(A - X);
  const bcLen = Math.abs(C - B);
  const bcExt = xaLen > 0 ? bcLen / xaLen : 0;
  const xc    = Math.abs(C - X);
  const cd    = xc > 0 ? Math.abs(D - C) / xc : 0;
  const xcRet = retrace(X, C, D);
  return bcExt >= 1.20 && bcExt <= 1.45 && within(xcRet, 0.786, 0.05);
}

function checkGartley(X, A, B, C, D) {
  const ab = retrace(X, A, B);
  const bc = retrace(A, B, C);
  const xd = retrace(X, A, D);
  return within(ab, 0.618, 0.05) && bc >= 0.33 && bc <= 0.91 && within(xd, 0.786, 0.04);
}

function checkCrab(X, A, B, C, D) {
  const ab    = retrace(X, A, B);
  const bc    = retrace(A, B, C);
  const xaLen = Math.abs(A - X);
  const xdLen = Math.abs(D - X);
  const xd    = xaLen > 0 ? xdLen / xaLen : 0;
  return ab >= 0.33 && ab <= 0.65 && bc >= 0.33 && bc <= 0.91 && within(xd, 1.618, 0.08);
}

function checkButterfly(X, A, B, C, D) {
  const ab    = retrace(X, A, B);
  const bc    = retrace(A, B, C);
  const xaLen = Math.abs(A - X);
  const xdLen = Math.abs(D - X);
  const xd    = xaLen > 0 ? xdLen / xaLen : 0;
  return within(ab, 0.786, 0.05) && bc >= 0.33 && bc <= 0.91 && xd >= 1.20 && xd <= 1.70;
}

function checkABCD(A, B, C, D) {
  const bc   = retrace(A, B, C);
  const abLen = Math.abs(B - A);
  const cdLen = Math.abs(D - C);
  const abcd  = abLen > 0 ? cdLen / abLen : 0;
  return bc >= 0.58 && bc <= 0.82 && abcd >= 0.90 && abcd <= 1.30;
}

// TradingView drawing guide per pattern
function tvGuide(pattern, swings, tf, direction) {
  const bull = direction === "bull";
  const fmt  = (n) => n ? n.toLocaleString("en-IN", { maximumFractionDigits:2 }) : "—";
  const dir  = bull ? "bullish reversal" : "bearish reversal";

  if (["Bat","Half Bat","Cypher","Gartley","Crab","Butterfly"].includes(pattern)) {
    const [X,A,B,C,D] = [swings.X, swings.A, swings.B, swings.C, swings.D].map(fmt);
    return [
      `1. Switch TradingView to ${tf} timeframe`,
      `2. Identify pivot X at ₹${X} — the origin swing ${bull?"low":"high"}`,
      `3. Mark A at ₹${A} — strong ${bull?"impulse high":"impulse low"} leg`,
      `4. Mark B at ₹${B} — pullback from A`,
      `5. Mark C at ₹${C} — extension / counter-rally from B`,
      `6. PRZ (D) at ₹${D} — expected ${dir} zone`,
      `7. Use "XABCD Pattern" tool → connect X→A→B→C→D`,
      `8. Apply Fibonacci Retracement X→A to verify B & D ratios`,
      `9. Apply Fibonacci Extension A→B→C to verify C & D`,
      `10. Wait for reversal candle at D with volume spike before entry`,
    ].join("\n");
  }
  if (pattern === "ABCD") {
    const [A,B,C,D] = [swings.A, swings.B, swings.C, swings.D].map(fmt);
    return [
      `1. Switch TradingView to ${tf} timeframe`,
      `2. Mark A at ₹${A} — initial swing ${bull?"low":"high"}`,
      `3. Mark B at ₹${B} — first impulse ${bull?"high":"low"}`,
      `4. Mark C at ₹${C} — 0.618–0.786 retracement of AB`,
      `5. Mark D at ₹${D} — 1.272–1.618 extension of BC (≈ AB length)`,
      `6. Use "ABCD Pattern" tool in TradingView`,
      `7. Verify AB = CD in both price and time bars`,
      `8. Enter at D on ${dir} confirmation candle`,
    ].join("\n");
  }
  if (pattern === "N Pattern") {
    const [A,B,C,D] = [swings.A, swings.B, swings.C, swings.D].map(fmt);
    return [
      `1. Switch TradingView to ${tf} timeframe`,
      `2. Mark A at ₹${A} — trend start`,
      `3. Mark B at ₹${B} — first impulse`,
      `4. Mark C at ₹${C} — shallow pullback (< 50% of AB)`,
      `5. D target at ₹${D} — extension beyond B`,
      `6. Draw trendline A→B and C→D`,
      `7. Use Fibonacci Extension from A→B→C to project D`,
      `8. Enter at C when price holds above/below B, target D`,
    ].join("\n");
  }
  if (pattern === "M Pattern") {
    const [P1,neck,P2,target] = [swings.A, swings.B, swings.C, swings.D].map(fmt);
    return [
      `1. Switch TradingView to ${tf} timeframe`,
      `2. Mark Peak 1 at ₹${P1} — first top`,
      `3. Mark Neckline at ₹${neck} — low between the two peaks`,
      `4. Mark Peak 2 at ₹${P2} — second top (≈ Peak 1, lower volume)`,
      `5. Draw horizontal neckline at ₹${neck}`,
      `6. Short on neckline break — target ₹${target}`,
      `7. Confirm: RSI bearish divergence at Peak 2`,
      `8. Stop loss above Peak 2`,
    ].join("\n");
  }
  if (pattern === "W Pattern") {
    const [B1,neck,B2,target] = [swings.A, swings.B, swings.C, swings.D].map(fmt);
    return [
      `1. Switch TradingView to ${tf} timeframe`,
      `2. Mark Bottom 1 at ₹${B1} — first trough`,
      `3. Mark Neckline at ₹${neck} — high between the two bottoms`,
      `4. Mark Bottom 2 at ₹${B2} — second trough (≈ Bottom 1, lower volume)`,
      `5. Draw horizontal neckline at ₹${neck}`,
      `6. Buy on neckline breakout — target ₹${target}`,
      `7. Confirm: RSI bullish divergence at Bottom 2`,
      `8. Stop loss below Bottom 2`,
    ].join("\n");
  }
  return "";
}

// ─── Auto-detect status from candles after D point ───────────────────────────
function resolveStatus(p, candles, dSwingIndex) {
  // candles after D
  const after = candles.slice(dSwingIndex + 1);
  if (!after.length) return "waiting";

  const bull    = p.direction === "bull";
  const entry   = p.dPoint;
  const sl      = p.stop;
  const t1      = p.t1;
  const t2      = p.t2;

  let entryHit = false;
  let status   = "waiting";

  for (const c of after) {
    // Check entry touched
    if (!entryHit) {
      const touched = bull ? c.low <= entry * 1.005 : c.high >= entry * 0.995;
      if (touched) { entryHit = true; status = "triggered"; }
    }

    if (entryHit) {
      // Check SL hit first (stop out)
      if (bull  && c.low  <= sl) { status = "sl"; break; }
      if (!bull && c.high >= sl) { status = "sl"; break; }

      // Check T2 hit
      if (bull  && c.high >= t2) { status = "t2"; break; }
      if (!bull && c.low  <= t2) { status = "t2"; break; }

      // Check T1 hit
      if (bull  && c.high >= t1) status = "t1";
      if (!bull && c.low  <= t1) status = "t1";
    }
  }

  return status;
}

// ─── Detect patterns from swing array ────────────────────────────────────────
function detectPatterns(swings, symbol, candles) {
  const results = [];
  const n = swings.length;
  if (n < 5) return results;

  // XABCD patterns — 5 swing window
  const xabcdChecks = [
    { name:"Bat",       color:"#0ea5e9", rel:82, check:checkBat       },
    { name:"Half Bat",  color:"#38bdf8", rel:78, check:checkHalfBat   },
    { name:"Cypher",    color:"#a855f7", rel:80, check:checkCypher    },
    { name:"Gartley",   color:"#22c55e", rel:78, check:checkGartley   },
    { name:"Crab",      color:"#f97316", rel:76, check:checkCrab      },
    { name:"Butterfly", color:"#ec4899", rel:74, check:checkButterfly },
  ];

  for (let i = Math.max(0, n - 10); i <= n - 5; i++) {
    const pts = swings.slice(i, i + 5);
    const [X, A, B, C, D] = pts.map(s => s.price);
    const bullish = X < A;
    const dSwingIndex = pts[4].index; // candle index of D point

    for (const { name, color, rel, check } of xabcdChecks) {
      if (check(X, A, B, C, D)) {
        const xaLen = Math.abs(A - X);
        const sl    = bullish ? D - xaLen * 0.15 : D + xaLen * 0.15;
        const t1    = bullish ? D + xaLen * 0.382 : D - xaLen * 0.382;
        const t2    = bullish ? D + xaLen * 0.618 : D - xaLen * 0.618;
        const rrRaw = Math.abs(t2 - D) / Math.abs(D - sl);
        const swingPrices = { X, A, B, C, D };
        const p = {
          stock: symbol, pattern: name, shape: "XABCD",
          direction: bullish ? "bull" : "bear",
          swings: swingPrices,
          dPoint: Math.round(D * 100) / 100,
          stop:   Math.round(sl * 100) / 100,
          t1:     Math.round(t1 * 100) / 100,
          t2:     Math.round(t2 * 100) / 100,
          rr:     `1:${rrRaw.toFixed(1)}`,
          confidence: rel, color, tf: "",
          tvGuide: tvGuide(name, swingPrices, "", bullish ? "bull" : "bear"),
        };
        p.status = resolveStatus(p, candles, dSwingIndex);
        results.push(p);
        break;
      }
    }
  }

  // ABCD — 4 swing window
  for (let i = Math.max(0, n - 8); i <= n - 4; i++) {
    const pts = swings.slice(i, i + 4);
    const [A, B, C, D] = pts.map(s => s.price);
    if (checkABCD(A, B, C, D)) {
      const bullish = A < B;
      const abLen   = Math.abs(B - A);
      const sl      = bullish ? D - abLen * 0.2 : D + abLen * 0.2;
      const t1      = bullish ? D + abLen * 0.382 : D - abLen * 0.382;
      const t2      = bullish ? D + abLen * 0.618 : D - abLen * 0.618;
      const rrRaw   = Math.abs(t2 - D) / Math.abs(D - sl);
      const swingPrices = { A, B, C, D };
      const p = {
        stock: symbol, pattern: "ABCD", shape: "ABCD",
        direction: bullish ? "bull" : "bear",
        swings: swingPrices,
        dPoint: Math.round(D * 100) / 100,
        stop:   Math.round(sl * 100) / 100,
        t1:     Math.round(t1 * 100) / 100,
        t2:     Math.round(t2 * 100) / 100,
        rr:     `1:${rrRaw.toFixed(1)}`,
        confidence: 72, color: "#f59e0b", tf: "",
        tvGuide: tvGuide("ABCD", swingPrices, "", bullish ? "bull" : "bear"),
      };
      p.status = resolveStatus(p, candles, pts[3].index);
      results.push(p);
    }
  }

  // N, M, W — 5 swing window
  for (let i = Math.max(0, n - 8); i <= n - 5; i++) {
    const pts = swings.slice(i, i + 5);
    const [p1, p2, p3, p4, p5] = pts.map(s => s.price);
    const lastIdx = pts[4].index;

    // N Pattern bullish
    const bcBull = Math.abs(p3 - p2) / Math.abs(p2 - p1);
    if (bcBull < 0.55 && p5 > p2) {
      const abLen = Math.abs(p2 - p1);
      const sl    = p3 - abLen * 0.1;
      const t1    = p5 + abLen * 0.272;
      const t2    = p5 + abLen * 0.618;
      const rrRaw = Math.abs(t2 - p5) / Math.abs(p5 - sl);
      const sw    = { A:p1, B:p2, C:p3, D:p5 };
      const p = {
        stock: symbol, pattern: "N Pattern", shape: "Continuation",
        direction: "bull", swings: sw,
        dPoint: Math.round(p3 * 100) / 100,
        stop:   Math.round(sl * 100) / 100,
        t1:     Math.round(t1 * 100) / 100,
        t2:     Math.round(t2 * 100) / 100,
        rr:     `1:${rrRaw.toFixed(1)}`,
        confidence: 70, color: "#06b6d4", tf: "",
        tvGuide: tvGuide("N Pattern", sw, "", "bull"),
      };
      p.status = resolveStatus(p, candles, pts[2].index);
      results.push(p);
    }

    // N Pattern bearish
    const bcBear = Math.abs(p3 - p2) / Math.abs(p1 - p2);
    if (bcBear < 0.55 && p5 < p2) {
      const abLen = Math.abs(p1 - p2);
      const sl    = p3 + abLen * 0.1;
      const t1    = p5 - abLen * 0.272;
      const t2    = p5 - abLen * 0.618;
      const rrRaw = Math.abs(p5 - t2) / Math.abs(sl - p5);
      const sw    = { A:p1, B:p2, C:p3, D:p5 };
      const p = {
        stock: symbol, pattern: "N Pattern", shape: "Continuation",
        direction: "bear", swings: sw,
        dPoint: Math.round(p3 * 100) / 100,
        stop:   Math.round(sl * 100) / 100,
        t1:     Math.round(t1 * 100) / 100,
        t2:     Math.round(t2 * 100) / 100,
        rr:     `1:${rrRaw.toFixed(1)}`,
        confidence: 70, color: "#06b6d4", tf: "",
        tvGuide: tvGuide("N Pattern", sw, "", "bear"),
      };
      p.status = resolveStatus(p, candles, pts[2].index);
      results.push(p);
    }

    // W Pattern
    const troughDiff = Math.abs(p3 - p1) / (Math.abs(p1) || 1);
    const neck       = Math.max(p2, p4);
    if (troughDiff <= 0.04 && p5 > neck && p1 < p2 && p3 < p4) {
      const height = Math.abs(p2 - p1);
      const sl     = Math.min(p1, p3) - height * 0.1;
      const t1     = neck + height * 0.5;
      const t2     = neck + height;
      const rrRaw  = Math.abs(t2 - neck) / Math.abs(neck - sl);
      const sw     = { A:p1, B:p2, C:p3, D:t2 };
      const p = {
        stock: symbol, pattern: "W Pattern", shape: "Double Bottom",
        direction: "bull", swings: sw,
        dPoint: Math.round(neck * 100) / 100,
        stop:   Math.round(sl * 100) / 100,
        t1:     Math.round(t1 * 100) / 100,
        t2:     Math.round(t2 * 100) / 100,
        rr:     `1:${rrRaw.toFixed(1)}`,
        confidence: 68, color: "#10b981", tf: "",
        tvGuide: tvGuide("W Pattern", sw, "", "bull"),
      };
      p.status = resolveStatus(p, candles, lastIdx);
      results.push(p);
    }

    // M Pattern
    const peakDiff = Math.abs(p3 - p1) / (Math.abs(p1) || 1);
    const neckLow  = Math.min(p2, p4);
    if (peakDiff <= 0.04 && p5 < neckLow && p1 > p2 && p3 > p4) {
      const height = Math.abs(p1 - p2);
      const sl     = Math.max(p1, p3) + height * 0.1;
      const t1     = neckLow - height * 0.5;
      const t2     = neckLow - height;
      const rrRaw  = Math.abs(neckLow - t2) / Math.abs(sl - neckLow);
      const sw     = { A:p1, B:p2, C:p3, D:t2 };
      const p = {
        stock: symbol, pattern: "M Pattern", shape: "Double Top",
        direction: "bear", swings: sw,
        dPoint: Math.round(neckLow * 100) / 100,
        stop:   Math.round(sl * 100) / 100,
        t1:     Math.round(t1 * 100) / 100,
        t2:     Math.round(t2 * 100) / 100,
        rr:     `1:${rrRaw.toFixed(1)}`,
        confidence: 68, color: "#e11d48", tf: "",
        tvGuide: tvGuide("M Pattern", sw, "", "bear"),
      };
      p.status = resolveStatus(p, candles, lastIdx);
      results.push(p);
    }
  }

  return results;
}

// ─── Scan Route ───────────────────────────────────────────────────────────────
// GET /api/harmonics/scan?interval=1D&from=2025-12-01&to=2026-03-23&pattern=All&maxPrice=10000
router.get("/scan", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const interval  = req.query.interval  || "1D";
  const maxPrice  = parseFloat(req.query.maxPrice) || 10000;
  const filterPat = req.query.pattern   || "All";
  const filterStk = req.query.stock     || "All";

  // Date range
  const to   = req.query.to   ? new Date(req.query.to)   : new Date();
  const days  = req.query.from ? null : (parseInt(req.query.days) || DAYS_MAP[interval] || 120);
  const from  = req.query.from ? new Date(req.query.from) : (() => {
    const d = new Date(to); d.setDate(d.getDate() - days); return d;
  })();

  // For intraday intervals cap fetch window
  const kiteInterval = INTERVAL_MAP[interval] || "day";
  const fetchInterval = interval === "4H" ? "60minute" : kiteInterval;

  const stocks = filterStk === "All"
    ? NSE_STOCKS
    : NSE_STOCKS.filter(s => s.symbol === filterStk);

  const allResults = [];
  const BATCH = 3;

  for (let i = 0; i < stocks.length; i += BATCH) {
    const batch = stocks.slice(i, i + BATCH);
    await Promise.all(batch.map(async ({ symbol, token }) => {
      try {
        const rawCandles = await fetchChunkedCandles(token, fetchInterval, from, to);

        // Skip stocks priced above maxPrice (use last close)
        const lastClose = rawCandles[rawCandles.length - 1]?.close;
        if (lastClose && lastClose > maxPrice) return;

        let candles = rawCandles;

        // Aggregate 60min → 4H
        if (interval === "4H") {
          const grouped = [];
          for (let j = 0; j < rawCandles.length; j += 4) {
            const sl = rawCandles.slice(j, j + 4);
            if (!sl.length) continue;
            grouped.push({
              date:   sl[0].date,
              open:   sl[0].open,
              high:   Math.max(...sl.map(c => c.high)),
              low:    Math.min(...sl.map(c => c.low)),
              close:  sl[sl.length - 1].close,
              volume: sl.reduce((s, c) => s + c.volume, 0),
            });
          }
          candles = grouped;
        }

        if (candles.length < 10) return;

        const deviation = interval === "1W" ? 0.06 : interval === "1D" ? 0.04 : 0.03;
        const swings    = detectSwings(candles, deviation);
        const patterns  = detectPatterns(swings, symbol, candles);

        for (const p of patterns) {
          if (filterPat !== "All" && p.pattern !== filterPat) continue;
          // Update tvGuide with correct tf
          p.tf      = interval;
          p.tvGuide = p.tvGuide.replace(/Switch TradingView to .* timeframe/, `Switch TradingView to ${interval} timeframe`);
          allResults.push(p);
        }
      } catch (err) {
        console.error(`[Harmonics] ${symbol}: ${err.message}`);
      }
    }));

    if (i + BATCH < stocks.length) await new Promise(r => setTimeout(r, 350));
  }

  // Deduplicate: keep highest confidence per stock+pattern
  const seen = new Map();
  const deduped = [];
  for (const r of allResults) {
    const key = `${r.stock}|${r.pattern}|${r.direction}`;
    if (!seen.has(key) || seen.get(key).confidence < r.confidence) {
      seen.set(key, r);
    }
  }
  for (const r of seen.values()) deduped.push(r);
  deduped.sort((a, b) => b.confidence - a.confidence || a.stock.localeCompare(b.stock));

  res.json({
    results:   deduped,
    scannedAt: new Date().toISOString(),
    interval,
    from:      from.toISOString().split("T")[0],
    to:        to.toISOString().split("T")[0],
    count:     deduped.length,
  });
});

// ─── Candles for chart ────────────────────────────────────────────────────────
router.get("/candles", async (req, res) => {
  if (!isAuthenticated())
    return res.status(401).json({ error: "Not authenticated" });

  const { token, interval = "1D", days = 90 } = req.query;
  if (!token) return res.status(400).json({ error: "token required" });

  const kiteInterval = INTERVAL_MAP[interval] || "day";
  const to   = new Date();
  const from = new Date(); from.setDate(from.getDate() - parseInt(days));

  try {
    const candles = await getClient().getHistoricalData(parseInt(token), kiteInterval, from, to, false, false);
    res.json({ candles: candles.map(c => ({
      time: Math.floor(new Date(c.date).getTime() / 1000),
      open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume,
    }))});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
