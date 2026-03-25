"use strict";

const { getClient, isAuthenticated } = require("../config/kite");
const { getATM }                      = require("./kiteService");
const { buildOptionChain }            = require("./optionChainService");

const NIFTY_TOKEN = 256265; // NSE:NIFTY 50 index

// ─── Candle micro-helpers ─────────────────────────────────────────────────────
const cBody  = c => Math.abs(c.close - c.open);
const cRange = c => Math.max(c.high - c.low, 0.01);
const isBull = c => c.close > c.open;
const isBear = c => c.close < c.open;
const isStrong = (c, minPts = 8) =>
  cBody(c) >= minPts && (cBody(c) / cRange(c)) >= 0.35;

// simple EMA
function ema(vals, p) {
  const k = 2 / (p + 1);
  return vals.reduce((acc, v, i) => {
    acc.push(i === 0 ? v : +(acc[i - 1] * (1 - k) + v * k));
    return acc;
  }, []);
}

// ─── 1. Liquidity Grab (Sweep + Rejection) ────────────────────────────────────
// Candle[-2] sweeps below/above a recent extreme; candle[-1] closes opposite
function detectLiqGrab(cs) {
  if (cs.length < 12) return { bull: false, bear: false };
  const n    = cs.length;
  const c0   = cs[n - 1];   // confirmation candle (just closed)
  const c1   = cs[n - 2];   // sweep candle

  const lookback = cs.slice(Math.max(0, n - 26), n - 3);
  const recentLow  = Math.min(...lookback.map(c => c.low));
  const recentHigh = Math.max(...lookback.map(c => c.high));

  return {
    bull: c1.low < recentLow - 1
       && c0.close > recentLow
       && isBull(c0)
       && isStrong(c0, 5),
    bear: c1.high > recentHigh + 1
       && c0.close < recentHigh
       && isBear(c0)
       && isStrong(c0, 5),
  };
}

// ─── 2. Fair Value Gap ────────────────────────────────────────────────────────
// 3-candle pattern: impulse candle leaves a price gap
function detectFVG(cs) {
  if (cs.length < 3) return { bull: false, bear: false };
  const n = cs.length;
  const a = cs[n - 3]; // left anchor
  const b = cs[n - 2]; // impulse candle
  const c = cs[n - 1]; // right anchor
  return {
    bull: a.high < c.low && isBull(b) && isStrong(b, 15),   // gap above a.high, below c.low
    bear: a.low  > c.high && isBear(b) && isStrong(b, 15),  // gap below a.low, above c.high
  };
}

// ─── 3. Order Block ───────────────────────────────────────────────────────────
// Last opposite candle before an impulse; price returns to that zone
function detectOB(cs, spot) {
  if (cs.length < 8) return { bull: false, bear: false };
  const look = cs.slice(Math.max(0, cs.length - 40));
  let bull = false, bear = false;

  for (let i = 0; i < look.length - 2; i++) {
    const a = look[i], b = look[i + 1], c2 = look[i + 2];

    // Bullish OB: bearish → 2 bullish strong candles → spot in OB zone
    if (isBear(a) && isStrong(a, 5) && isBull(b) && isStrong(b, 10) && isBull(c2)) {
      if (spot >= a.low - 30 && spot <= a.high + 40) bull = true;
    }
    // Bearish OB: bullish → 2 bearish strong candles → spot in OB zone
    if (isBull(a) && isStrong(a, 5) && isBear(b) && isStrong(b, 10) && isBear(c2)) {
      if (spot >= a.low - 40 && spot <= a.high + 30) bear = true;
    }
  }
  return { bull, bear };
}

// ─── 4. Breaker Block ─────────────────────────────────────────────────────────
// An old OB that price subsequently broke through — now it flips polarity
function detectBreaker(cs, spot) {
  if (cs.length < 18) return { bull: false, bear: false };
  const look = cs.slice(Math.max(0, cs.length - 60));
  let bull = false, bear = false;

  for (let i = 0; i < look.length - 4; i++) {
    const a = look[i], b = look[i + 1], c2 = look[i + 2];
    const later = look.slice(i + 3);

    // Old bearish OB → price broke above → bullish breaker
    if (isBear(a) && isStrong(a, 5) && isBull(b) && isStrong(b, 10) && isBull(c2)) {
      if (later.some(c => c.close > a.high + 5)) {
        // Price now pulling back to test zone from above
        if (spot >= a.low - 20 && spot <= a.high + 25) bull = true;
      }
    }
    // Old bullish OB → price broke below → bearish breaker
    if (isBull(a) && isStrong(a, 5) && isBear(b) && isStrong(b, 10) && isBear(c2)) {
      if (later.some(c => c.close < a.low - 5)) {
        // Price now pulling back to test zone from below
        if (spot >= a.low - 25 && spot <= a.high + 20) bear = true;
      }
    }
  }
  return { bull, bear };
}

// ─── 5. Smart Money Trap / Market Structure Shift ─────────────────────────────
// Stop hunt below/above swing extreme followed by powerful reversal
function detectSMT(cs) {
  if (cs.length < 10) return { bull: false, bear: false };
  const n    = cs.length;
  const c0   = cs[n - 1]; // strong reversal candle
  const c1   = cs[n - 2]; // trap / sweep candle
  const c2   = cs[n - 3]; // structure reference

  const look       = cs.slice(Math.max(0, n - 22), n - 3);
  const recentLow  = Math.min(...look.map(c => c.low));
  const recentHigh = Math.max(...look.map(c => c.high));

  return {
    bull: c1.low  < recentLow  - 2 && isBull(c0) && c0.close > c2.high && isStrong(c0, 12),
    bear: c1.high > recentHigh + 2 && isBear(c0) && c0.close < c2.low  && isStrong(c0, 12),
  };
}

// ─── EMA trend filter ─────────────────────────────────────────────────────────
function emaTrend(cs) {
  if (cs.length < 5) return { bull: false, bear: false };
  const closes  = cs.map(c => c.close);
  const ema20   = ema(closes, 20);
  const last    = closes[closes.length - 1];
  const lastEMA = ema20[ema20.length - 1];
  const prevEMA = ema20[ema20.length - 3] ?? lastEMA;
  return {
    bull: last > lastEMA && lastEMA > prevEMA,
    bear: last < lastEMA && lastEMA < prevEMA,
  };
}

// ─── Combine all SMC signals ──────────────────────────────────────────────────
function analyzeCandles(cs, spot) {
  const lg  = detectLiqGrab(cs);
  const fvg = detectFVG(cs);
  const ob  = detectOB(cs, spot);
  const bb  = detectBreaker(cs, spot);
  const smt = detectSMT(cs);
  const trend = emaTrend(cs);

  function buildSide(key) {
    const list = [
      lg[key]  && "LiqGrab",
      fvg[key] && "FVG",
      ob[key]  && "OrdBlock",
      bb[key]  && "Breaker",
      smt[key] && "SMTrap",
    ].filter(Boolean);
    // EMA trend alignment adds +1 to score (bonus point)
    const trendBonus = trend[key] ? 1 : 0;
    return { score: list.length, bonus: trendBonus, concepts: list, trendOk: trend[key] };
  }

  return {
    bull: buildSide("bull"),
    bear: buildSide("bear"),
  };
}

// ─── Find best option in LTP ₹200–₹300 ───────────────────────────────────────
async function findBestLeg(direction, expiry, spot) {
  const chain = await buildOptionChain(expiry, 15);
  const atm   = getATM(spot);

  const all = chain.rows.flatMap(r => direction === "CE" ? [r.ce] : [r.pe]);

  // Primary filter: ₹200–₹300
  let candidates = all.filter(l => l.ltp >= 200 && l.ltp <= 300);

  // Fallback 1: ₹150–₹350
  if (!candidates.length)
    candidates = all.filter(l => l.ltp >= 150 && l.ltp <= 350);

  // Fallback 2: ₹100–₹400
  if (!candidates.length)
    candidates = all.filter(l => l.ltp >= 100 && l.ltp <= 400);

  if (!candidates.length) return null;

  // Sort: closest to ATM → closest to ₹250 sweet-spot
  candidates.sort((a, b) => {
    const da = Math.abs(a.strike - atm), db = Math.abs(b.strike - atm);
    if (Math.abs(da - db) > 50) return da - db;
    return Math.abs(a.ltp - 250) - Math.abs(b.ltp - 250);
  });

  return candidates[0];
}

// ─── Main scan ────────────────────────────────────────────────────────────────
async function runSMCScan(expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  // ── Time gate: 9:21 AM – 3:30 PM ──────────────────────────────────────────
  const now = new Date();
  const h   = now.getHours(), m = now.getMinutes();
  if (h < 9 || (h === 9 && m < 21))
    return { signal: false, reason: `Too early (${h}:${String(m).padStart(2,"0")}) — scan starts at 09:21` };
  if (h >= 15)
    return { signal: false, reason: "No new entries after 15:00" };

  // ── Fetch NIFTY 1-min candles from 9:15 AM ─────────────────────────────────
  const from = new Date(now); from.setHours(9, 15, 0, 0);
  const rawCandles = await getClient().getHistoricalData(
    NIFTY_TOKEN, "minute", from, now, false, false
  );

  if (rawCandles.length < 10)
    return { signal: false, reason: "Insufficient candle data (<10 candles)" };

  // Exclude the currently forming candle (last one may be incomplete)
  const candles = rawCandles.slice(0, -1).map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date,
  }));

  const spot = candles[candles.length - 1].close;

  // ── SMC pattern analysis ───────────────────────────────────────────────────
  const sigs = analyzeCandles(candles, spot);
  const { bull, bear } = sigs;

  // Effective score = raw score + trend bonus (trend alignment = high conviction)
  const bullEff = bull.score + bull.bonus;
  const bearEff = bear.score + bear.bonus;

  // Need at least 2 raw concept matches (not counting trend bonus)
  let dir = null, score = 0, effScore = 0, concepts = [], trendOk = false;

  if (bull.score >= 2 && bullEff >= bearEff) {
    dir = "CE"; score = bull.score; effScore = bullEff; concepts = bull.concepts; trendOk = bull.trendOk;
  } else if (bear.score >= 2 && bearEff > bullEff) {
    dir = "PE"; score = bear.score; effScore = bearEff; concepts = bear.concepts; trendOk = bear.trendOk;
  } else if (bull.score >= 2) {
    dir = "CE"; score = bull.score; effScore = bullEff; concepts = bull.concepts; trendOk = bull.trendOk;
  } else if (bear.score >= 2) {
    dir = "PE"; score = bear.score; effScore = bearEff; concepts = bear.concepts; trendOk = bear.trendOk;
  }

  if (!dir) {
    return {
      signal: false,
      reason: `No confluence — bull:${bull.score} bear:${bear.score}`,
      debug: { bull, bear, spot, candleCount: candles.length },
    };
  }

  // ── Find option in price band ──────────────────────────────────────────────
  const leg = await findBestLeg(dir, expiry, spot);
  if (!leg) return { signal: false, reason: "No options found in ₹200–₹300 range" };

  // ── Build R:R (12% SL / 24% Target) ───────────────────────────────────────
  const entry  = leg.ltp;
  const risk   = +(entry * 0.12).toFixed(2);
  const reward = +(entry * 0.24).toFixed(2);
  const rr     = {
    entry,
    sl:      +(entry - risk).toFixed(2),
    target1: +(entry + risk).toFixed(2),
    target2: +(entry + reward).toFixed(2),
    risk, reward, riskPct: 12, rewardPct: 24,
  };

  const entryTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  const strength  = effScore >= 5 ? "STRONG" : effScore >= 3 ? "GOOD" : "MODERATE";

  return {
    signal:     true,
    id:         `${dir}_${leg.strike}_${Date.now()}`,
    entryTime,
    direction:  dir,
    strike:     leg.strike,
    leg,
    rr,
    score,
    effScore,
    strength,
    trendOk,
    concepts,
    status:     "ACTIVE",
    currentPnL: 0,
    pnlPct:     0,
    spot,
    expiry,
    createdAt:  now.toISOString(),
  };
}

// ─── Update P&L for an existing alert ─────────────────────────────────────────
function updateAlertPnL(alert, currentLtp) {
  const pnl    = +(currentLtp - alert.rr.entry).toFixed(2);
  const pct    = +(pnl / alert.rr.entry * 100).toFixed(2);
  let   status = alert.status;

  let t1Hit     = alert.t1Hit     || false;
  let t1HitTime = alert.t1HitTime || null;

  if (alert.status === "ACTIVE") {
    const now        = new Date();
    const elapsedMin = (now.getTime() - new Date(alert.createdAt).getTime()) / 60000;
    const h = now.getHours(), m = now.getMinutes();

    // Track T1 milestone — record hit time once
    if (!t1Hit && currentLtp >= alert.rr.target1) {
      t1Hit     = true;
      t1HitTime = now.toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" });
    }

    if      (currentLtp <= alert.rr.sl)                        status = "SL";
    else if (currentLtp >= alert.rr.target2)                   status = "TARGET";
    else if (h === 15 && m >= 20)                              status = "TIME_EXIT";
    else if (elapsedMin >= 60 && currentLtp > alert.rr.entry)  status = "TIME_PROFIT";
    else if (elapsedMin >= 75)                                  status = "TIME_EXIT";
  }

  // Record exit time when position first closes
  const exitTime = (status !== "ACTIVE" && alert.status === "ACTIVE")
    ? new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    : alert.exitTime;

  const peakMove = +(Math.max(alert.peakMove ?? 0, currentLtp - alert.rr.entry)).toFixed(2);
  return { ...alert, currentPnL: pnl, pnlPct: pct, status, t1Hit, t1HitTime, exitTime, lastLtp: currentLtp, peakMove };
}

// ─── IST time helper (Render runs UTC — always use this for IST comparisons) ──
function toIST(date) {
  const ms  = (date instanceof Date ? date : new Date(date)).getTime();
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return { h: ist.getUTCHours(), m: ist.getUTCMinutes() };
}

// ─── Historical / Backtest scan ───────────────────────────────────────────────
// Walks minute-by-minute through a past day, finds every SMC signal,
// fetches the matching option candles, then resolves each trade (SL / TARGET / EOD).
async function runHistoricalSMCScan(date, expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  const from = new Date(date); from.setHours(9, 15, 0, 0);
  const to   = new Date(date); to.setHours(15, 30, 0, 0);

  // 1. Fetch NIFTY spot candles for the full day
  const rawNifty = await getClient().getHistoricalData(
    NIFTY_TOKEN, "minute", from, to, false, false
  );
  if (!rawNifty || rawNifty.length < 10)
    throw new Error(`No NIFTY candle data for ${date}. Market may have been closed.`);

  const niftyCandles = rawNifty.map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close,
    volume: c.volume, date: c.date,
  }));

  // 2. Walk minute by minute from 9:21 AM, collect signals
  const signals  = [];
  const cooldown = new Map(); // `${dir}_${atm}` → last fire time (ms)
  const COOLDOWN_MS = 3 * 60 * 1000;

  for (let i = 6; i < niftyCandles.length; i++) {
    const candle = niftyCandles[i];
    const { h, m } = toIST(candle.date);
    if (h < 9 || (h === 9 && m < 21)) continue;
    if (h >= 15) break; // no new entries at or after 15:00

    const slice = niftyCandles.slice(0, i + 1);
    const spot  = candle.close;
    const sigs  = analyzeCandles(slice, spot);
    const { bull, bear } = sigs;

    let dir = null, score = 0, effScore = 0, concepts = [], trendOk = false;
    if (bull.score >= 2 && (bull.score + bull.bonus) >= (bear.score + bear.bonus)) {
      dir = "CE"; score = bull.score; effScore = bull.score + bull.bonus;
      concepts = bull.concepts; trendOk = bull.trendOk;
    } else if (bear.score >= 2) {
      dir = "PE"; score = bear.score; effScore = bear.score + bear.bonus;
      concepts = bear.concepts; trendOk = bear.trendOk;
    }
    if (!dir) continue;

    const atm      = getATM(spot);
    const cdKey    = `${dir}_${atm}`;
    const lastFire = cooldown.get(cdKey) ?? 0;
    const candleMs = new Date(candle.date).getTime();
    if (candleMs - lastFire < COOLDOWN_MS) continue;
    cooldown.set(cdKey, candleMs);

    signals.push({
      signalTime: candle.date,
      entryTime:  `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`, // h,m already IST
      direction:  dir,
      atm,
      spot,
      score,
      effScore,
      concepts,
      trendOk,
      strength: effScore >= 5 ? "STRONG" : effScore >= 3 ? "GOOD" : "MODERATE",
      candleIdx: i,
    });
  }

  if (!signals.length) {
    return { results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null,
      message: "No SMC signals found for this date" };
  }

  // 3. Get option instruments for the expiry
  const { getOptionChainInstruments } = require("./kiteService");
  let instruments = [];
  try { instruments = await getOptionChainInstruments(expiry); } catch {}

  // Build token lookup: strike+type → token
  const tokenMap = {};
  for (const inst of instruments) {
    const key = `${Number(inst.strike)}_${inst.instrument_type}`;
    tokenMap[key] = inst.instrument_token;
  }

  // 4. Collect unique option tokens needed
  const neededTokens = new Map(); // key → {token, strike, type}
  for (const sig of signals) {
    // Check ATM and ±1 strikes for options in ₹150–₹350 range
    for (const offset of [0, -50, 50, -100, 100]) {
      const strike = sig.atm + offset;
      const key    = `${strike}_${sig.direction}`;
      if (tokenMap[key] && !neededTokens.has(key))
        neededTokens.set(key, { token: tokenMap[key], strike, type: sig.direction });
    }
  }

  // 5. Fetch candles for all needed option tokens in batches of 3
  const optCandlesMap = new Map(); // key → candle[]
  const BATCH = 3;
  const tokenList = [...neededTokens.entries()];
  for (let i = 0; i < tokenList.length; i += BATCH) {
    await Promise.all(tokenList.slice(i, i + BATCH).map(async ([key, info]) => {
      try {
        const oc = await getClient().getHistoricalData(
          info.token, "minute", from, to, false, true
        );
        optCandlesMap.set(key, oc);
      } catch {
        optCandlesMap.set(key, []);
      }
    }));
  }

  // 6. Resolve each signal → entry, SL, Target or EOD
  //    Rules: no new entry while previous position is open; max 25 trades/day
  const results   = [];
  let openExitMs  = 0; // timestamp when the current open position closed
  const MAX_TRADES = 25;

  for (const sig of signals) {
    // Gate A: daily limit
    if (results.length >= MAX_TRADES) break;

    // Gate B: no new entry while previous position still open
    const sigMs = new Date(sig.signalTime).getTime();
    if (sigMs <= openExitMs) continue;

    // Find best option candidate with LTP ≥ ₹150
    let chosenKey = null, entryCandle = null;
    for (const offset of [0, -50, 50, -100, 100]) {
      const strike = sig.atm + offset;
      const key    = `${strike}_${sig.direction}`;
      const oc     = optCandlesMap.get(key);
      if (!oc || !oc.length) continue;

      // Find entry candle: first candle at or after signal time (within 2 min)
      const sigMs = new Date(sig.signalTime).getTime();
      const ec = oc.find(c => {
        const ct = new Date(c.date).getTime();
        return ct >= sigMs && ct <= sigMs + 2 * 60 * 1000;
      });
      if (!ec) continue;
      const entryPrice = ec.close || ec.open;
      if (entryPrice < 150 || entryPrice > 400) continue;

      chosenKey   = key;
      entryCandle = ec;
      sig.strike  = strike;
      break;
    }

    if (!chosenKey || !entryCandle) continue;

    const entry  = entryCandle.close || entryCandle.open;
    const risk   = +(entry * 0.12).toFixed(2);
    const reward = +(entry * 0.24).toFixed(2);
    const rr     = {
      entry,
      sl:      +(entry - risk).toFixed(2),
      target1: +(entry + risk).toFixed(2),
      target2: +(entry + reward).toFixed(2),
      risk, reward, riskPct: 12, rewardPct: 24,
    };

    // Walk forward candles to find SL / Target hit
    const oc         = optCandlesMap.get(chosenKey);
    const entryMs    = new Date(entryCandle.date).getTime();
    const laterCandles = oc.filter(c => new Date(c.date).getTime() > entryMs);

    let status = "ACTIVE", exitPrice = entry, exitTime = null, t1Hit = false, t1HitTime = null;
    for (const c of laterCandles) {
      const elapsedMin = (new Date(c.date).getTime() - entryMs) / 60000;
      const { h: ch, m: cm } = toIST(c.date);
      // Track T1 milestone — record hit time once
      if (!t1Hit && c.high >= rr.target1) {
        t1Hit     = true;
        t1HitTime = `${String(ch).padStart(2,"0")}:${String(cm).padStart(2,"0")}`;
      }
      if (c.low  <= rr.sl)                               { status = "SL";          exitPrice = rr.sl;      exitTime = c.date; break; }
      if (c.high >= rr.target2)                          { status = "TARGET";      exitPrice = rr.target2; exitTime = c.date; break; }
      if (ch === 15 && cm >= 20)                         { status = "TIME_EXIT";   exitPrice = c.close;    exitTime = c.date; break; }
      if (elapsedMin >= 60 && c.close > entry)           { status = "TIME_PROFIT"; exitPrice = c.close;    exitTime = c.date; break; }
      if (elapsedMin >= 75)                              { status = "TIME_EXIT";   exitPrice = c.close;    exitTime = c.date; break; }
    }
    if (status === "ACTIVE" && laterCandles.length) {
      exitPrice = laterCandles[laterCandles.length - 1].close;
      status    = "EOD"; // end-of-day, no hit
      exitTime  = laterCandles[laterCandles.length - 1].date;
    }

    // Advance the position gate to the exit time of this trade
    openExitMs = exitTime ? new Date(exitTime).getTime() : to.getTime();

    const pnl = +(exitPrice - entry).toFixed(2);
    const pct = +(pnl / entry * 100).toFixed(2);

    const exitT = exitTime
      ? (() => { const d = new Date(exitTime); return `${String(d.getHours()).padStart(2,"0")}:${String(d.getMinutes()).padStart(2,"0")}`; })()
      : null;

    results.push({
      id:         `hist_${sig.direction}_${sig.strike}_${sig.entryTime}`,
      entryTime:  sig.entryTime,
      exitTime:   exitT,
      direction:  sig.direction,
      strike:     sig.strike,
      leg:        { token: neededTokens.get(chosenKey)?.token, strike: sig.strike, type: sig.direction, ltp: exitPrice },
      rr,
      score:      sig.score,
      effScore:   sig.effScore,
      strength:   sig.strength,
      trendOk:    sig.trendOk,
      concepts:   sig.concepts,
      status,
      t1Hit,
      t1HitTime,
      currentPnL: pnl,
      pnlPct:     pct,
      spot:       sig.spot,
      expiry,
      createdAt:  sig.signalTime,
      isHistorical: true,
      date,
    });
  }

  const wins   = results.filter(r => r.status === "TARGET").length;
  const eodCount = results.filter(r => r.status === "EOD").length;
  const closed = results.filter(r => r.status !== "ACTIVE").length;

  return {
    results,
    date,
    expiry,
    totalSignals: results.length,
    wins,
    losses: results.filter(r => r.status === "SL").length,
    eod: eodCount,
    winRate: closed > 0 ? +((wins / closed) * 100).toFixed(1) : null,
  };
}

module.exports = { runSMCScan, runHistoricalSMCScan, updateAlertPnL, analyzeCandles };
