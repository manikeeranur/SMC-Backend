"use strict";

const { getClient, isAuthenticated } = require("../config/kite");
const { getATM }                      = require("./kiteService");
const { buildOptionChain }            = require("./optionChainService");
const { latestVWAP, calcVWAP }        = require("../utils/vwap");
const {
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM,
  VWAP930_SL_PCT, VWAP930_TARGET_PCT,
  VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MIN,
} = require("../config/constants");

const NIFTY_TOKEN = 256265; // NSE:NIFTY 50 index

// ─── Build R:R (SL −8% / Target +30%) ────────────────────────────────────────
function buildRR(entry) {
  const risk   = +(entry * (VWAP930_SL_PCT / 100)).toFixed(2);
  const reward = +(entry * (VWAP930_TARGET_PCT / 100)).toFixed(2);
  return {
    entry,
    sl:     +(entry - risk).toFixed(2),
    target: +(entry + reward).toFixed(2),
    risk, reward, riskPct: VWAP930_SL_PCT, rewardPct: VWAP930_TARGET_PCT,
  };
}

// ─── Find the CE / PE candidate legs whose premium is ₹130–₹150 ─────────────
// Among multiple strikes in-band on the same side, pick the one closest to ATM.
async function findCandidateLegs(expiry) {
  const chain = await buildOptionChain(expiry, 15);
  const atm   = getATM(chain.spot);

  function pick(side) {
    const all = chain.rows.flatMap(r => [side === "CE" ? r.ce : r.pe]);
    const inBand = all.filter(l => l.ltp >= VWAP930_MIN_PREMIUM && l.ltp <= VWAP930_MAX_PREMIUM);
    if (!inBand.length) return null;
    inBand.sort((a, b) => Math.abs(a.strike - atm) - Math.abs(b.strike - atm));
    return inBand[0];
  }

  return { ce: pick("CE"), pe: pick("PE"), spot: chain.spot, atm };
}

// ─── IST time helper (Render runs UTC — always use this for IST comparisons) ──
function toIST(date) {
  const ms  = (date instanceof Date ? date : new Date(date)).getTime();
  const ist = new Date(ms + 5.5 * 60 * 60 * 1000);
  return { h: ist.getUTCHours(), m: ist.getUTCMinutes() };
}

// ─── Fetch a leg's own 1-min candles from 09:15 up to `now`, and its VWAP ────
async function getLegVWAP(token, from, now) {
  const raw = await getClient().getHistoricalData(token, "minute", from, now, false, true);
  if (!raw || raw.length < 2) return null;
  // Exclude the currently-forming candle
  const completed = raw.slice(0, -1).map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date,
  }));
  if (!completed.length) return null;
  return latestVWAP(completed);
}

// ─── Decide CE vs PE from {ce, pe} candidates given their VWAP + current LTP ─
// Returns { direction, leg, vwap, ceQualifies, peQualifies, vwapCE, vwapPE } or null
function decideDirection(ce, pe, vwapCE, vwapPE) {
  const ceQualifies = ce != null && vwapCE != null && ce.ltp >= vwapCE;
  const peQualifies = pe != null && vwapPE != null && pe.ltp >= vwapPE;

  if (!ceQualifies && !peQualifies) return null;

  if (ceQualifies && peQualifies) {
    // Tie-break: greater distance above its own VWAP wins
    const ceDist = ce.ltp - vwapCE;
    const peDist = pe.ltp - vwapPE;
    return ceDist >= peDist
      ? { direction: "CE", leg: ce, vwap: vwapCE }
      : { direction: "PE", leg: pe, vwap: vwapPE };
  }

  return ceQualifies
    ? { direction: "CE", leg: ce, vwap: vwapCE }
    : { direction: "PE", leg: pe, vwap: vwapPE };
}

// ─── Main scan — must fire exactly at 09:30 IST ──────────────────────────────
async function runVWAP930Scan(expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  if (h !== VWAP930_ENTRY_HOUR || m !== VWAP930_ENTRY_MIN) {
    return { signal: false, reason: `Entry window is exactly ${String(VWAP930_ENTRY_HOUR).padStart(2,"0")}:${String(VWAP930_ENTRY_MIN).padStart(2,"0")} IST (now ${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")})` };
  }

  const { ce, pe, spot } = await findCandidateLegs(expiry);
  if (!ce && !pe) {
    return { signal: false, reason: `No CE/PE in ₹${VWAP930_MIN_PREMIUM}–₹${VWAP930_MAX_PREMIUM} band`, spot };
  }

  const from = new Date(now); from.setHours(9, 15, 0, 0);
  const [vwapCE, vwapPE] = await Promise.all([
    ce ? getLegVWAP(ce.token, from, now) : Promise.resolve(null),
    pe ? getLegVWAP(pe.token, from, now) : Promise.resolve(null),
  ]);

  const decision = decideDirection(ce, pe, vwapCE, vwapPE);
  if (!decision) {
    return {
      signal: false,
      reason: "Neither CE nor PE touching/above its VWAP at 09:30",
      spot,
      debug: { ce: ce ? { strike: ce.strike, ltp: ce.ltp, vwap: vwapCE } : null,
               pe: pe ? { strike: pe.strike, ltp: pe.ltp, vwap: vwapPE } : null },
    };
  }

  const { direction: dir, leg, vwap } = decision;
  const rr = buildRR(leg.ltp);
  const entryTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;

  return {
    signal:     true,
    id:         `VWAP930_${dir}_${leg.strike}_${Date.now()}`,
    entryTime,
    direction:  dir,
    strike:     leg.strike,
    leg,
    rr,
    vwap,
    vwapCE, vwapPE,
    status:     "ACTIVE",
    currentPnL: 0,
    pnlPct:     0,
    spot,
    expiry,
    createdAt:  now.toISOString(),
  };
}

// ─── Update P&L for an existing alert (SL / TARGET / 15:20 square-off) ──────
function updateAlertPnL(alert, currentLtp) {
  const pnl = +(currentLtp - alert.rr.entry).toFixed(2);
  const pct = +(pnl / alert.rr.entry * 100).toFixed(2);
  let status = alert.status;

  if (alert.status === "ACTIVE") {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    if      (currentLtp <= alert.rr.sl)     status = "SL";
    else if (currentLtp >= alert.rr.target) status = "TARGET";
    else if (h === 15 && m >= 20)           status = "TIME_EXIT";
  }

  const exitTime = (status !== "ACTIVE" && alert.status === "ACTIVE")
    ? new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    : alert.exitTime;

  const peakMove = +(Math.max(alert.peakMove ?? 0, currentLtp - alert.rr.entry)).toFixed(2);
  return { ...alert, currentPnL: pnl, pnlPct: pct, status, exitTime, lastLtp: currentLtp, peakMove };
}

// ─── Historical / Backtest scan — single day, at most one trade ─────────────
async function runHistoricalVWAP930Scan(date, expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  const from = new Date(date); from.setHours(9, 15, 0, 0);
  const to   = new Date(date); to.setHours(15, 30, 0, 0);
  const entryMark = new Date(date); entryMark.setHours(VWAP930_ENTRY_HOUR, VWAP930_ENTRY_MIN, 0, 0);

  // 1. NIFTY spot candles to find ATM at 09:30
  const rawNifty = await getClient().getHistoricalData(NIFTY_TOKEN, "minute", from, to, false, false);
  if (!rawNifty || rawNifty.length < 6)
    throw new Error(`No NIFTY candle data for ${date}. Market may have been closed.`);

  const entryNiftyCandle = rawNifty.find(c => new Date(c.date).getTime() >= entryMark.getTime());
  if (!entryNiftyCandle) {
    return { results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null,
      message: "No NIFTY candle at 09:30 for this date" };
  }
  const spot = entryNiftyCandle.open;
  const atm  = getATM(spot);

  // 2. Resolve option instruments for the expiry, gather candidate strikes (ATM ± a few)
  const { getOptionChainInstruments } = require("./kiteService");
  let instruments = [];
  try { instruments = await getOptionChainInstruments(expiry); } catch {}
  const tokenMap = {};
  for (const inst of instruments) {
    tokenMap[`${Number(inst.strike)}_${inst.instrument_type}`] = inst.instrument_token;
  }

  const offsets = [0, -50, 50, -100, 100, -150, 150];
  async function fetchCandidate(type) {
    for (const off of offsets) {
      const strike = atm + off;
      const token  = tokenMap[`${strike}_${type}`];
      if (!token) continue;
      const raw = await getClient().getHistoricalData(token, "minute", from, to, false, true).catch(() => []);
      if (!raw || raw.length < 6) continue;
      const candles = raw.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date }));
      const entryIdx = candles.findIndex(c => new Date(c.date).getTime() >= entryMark.getTime());
      if (entryIdx < 5) continue; // need ≥5 completed candles before entry (09:15 onwards)
      const entryCandle = candles[entryIdx];
      const premium = entryCandle.open;
      if (premium < VWAP930_MIN_PREMIUM || premium > VWAP930_MAX_PREMIUM) continue;
      const completed = candles.slice(0, entryIdx);
      const vwap = latestVWAP(completed);
      return { strike, token, premium, vwap, entryCandle, entryIdx, candles };
    }
    return null;
  }

  const [ceCand, peCand] = await Promise.all([fetchCandidate("CE"), fetchCandidate("PE")]);

  const ceQualifies = ceCand && ceCand.premium >= ceCand.vwap;
  const peQualifies = peCand && peCand.premium >= peCand.vwap;

  if (!ceQualifies && !peQualifies) {
    return {
      results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null,
      message: "No CE/PE in premium band touching/above VWAP at 09:30",
      debug: { ce: ceCand ? { strike: ceCand.strike, premium: ceCand.premium, vwap: ceCand.vwap } : null,
               pe: peCand ? { strike: peCand.strike, premium: peCand.premium, vwap: peCand.vwap } : null },
    };
  }

  let chosen, dir;
  if (ceQualifies && peQualifies) {
    const ceDist = ceCand.premium - ceCand.vwap;
    const peDist = peCand.premium - peCand.vwap;
    if (ceDist >= peDist) { chosen = ceCand; dir = "CE"; } else { chosen = peCand; dir = "PE"; }
  } else if (ceQualifies) { chosen = ceCand; dir = "CE"; }
  else { chosen = peCand; dir = "PE"; }

  const entry = chosen.premium;
  const rr = buildRR(entry);

  // 3. Walk forward from the entry candle to resolve SL / Target / EOD square-off (15:20)
  const laterCandles = chosen.candles.slice(chosen.entryIdx + 1);
  let status = "ACTIVE", exitPrice = entry, exitTime = null, peakMove = 0;
  for (const c of laterCandles) {
    const { h: ch, m: cm } = toIST(c.date);
    const move = +(c.high - entry).toFixed(2);
    if (move > peakMove) peakMove = move;
    if (c.low  <= rr.sl)     { status = "SL";        exitPrice = rr.sl;     exitTime = c.date; break; }
    if (c.high >= rr.target) { status = "TARGET";    exitPrice = rr.target; exitTime = c.date; break; }
    if (ch === 15 && cm >= 20) { status = "TIME_EXIT"; exitPrice = c.close; exitTime = c.date; break; }
  }
  if (status === "ACTIVE" && laterCandles.length) {
    exitPrice = laterCandles[laterCandles.length - 1].close;
    status    = "EOD";
    exitTime  = laterCandles[laterCandles.length - 1].date;
  }

  const pnl = +(exitPrice - entry).toFixed(2);
  const pct = +(pnl / entry * 100).toFixed(2);
  const entryTimeStr = `${String(VWAP930_ENTRY_HOUR).padStart(2,"0")}:${String(VWAP930_ENTRY_MIN).padStart(2,"0")}`;
  const exitTimeStr = exitTime
    ? new Date(exitTime).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
    : null;

  const result = {
    id:         `hist_VWAP930_${dir}_${chosen.strike}_${date}`,
    entryTime:  entryTimeStr,
    exitTime:   exitTimeStr,
    direction:  dir,
    strike:     chosen.strike,
    leg:        { token: chosen.token, strike: chosen.strike, type: dir, ltp: exitPrice },
    rr,
    vwap:       chosen.vwap,
    vwapCE:     ceCand?.vwap ?? null,
    vwapPE:     peCand?.vwap ?? null,
    status,
    currentPnL: pnl,
    pnlPct:     pct,
    peakMove,
    spot,
    expiry,
    createdAt:  chosen.entryCandle.date,
    isHistorical: true,
    date,
  };

  const wins   = status === "TARGET" ? 1 : 0;
  const losses = status === "SL" ? 1 : 0;
  const closed = status !== "ACTIVE" ? 1 : 0;

  return {
    results: [result],
    date, expiry,
    totalSignals: 1,
    wins, losses,
    eod: status === "EOD" ? 1 : 0,
    winRate: closed > 0 ? +((wins / closed) * 100).toFixed(1) : null,
  };
}

module.exports = { runVWAP930Scan, runHistoricalVWAP930Scan, updateAlertPnL, buildRR };
