"use strict";

const { getClient, isAuthenticated } = require("../config/kite");
const { getATM }                      = require("./kiteService");
const { buildOptionChain }            = require("./optionChainService");
const { calcVWAP, aggregateCandles, isStrongGreenCandle } = require("../utils/vwap");
const {
  VWAP930_MIN_PREMIUM, VWAP930_MAX_PREMIUM,
  VWAP930_SL_PCT, VWAP930_TARGET_PCT, VWAP930_CANDLE_MINUTES,
  VWAP930_ENTRY_START_HOUR, VWAP930_ENTRY_START_MINUTE, VWAP930_MAX_TRADES_PER_DAY,
  VWAP930_STAGNANT_HOURS, VWAP930_STAGNANT_MAX_POINTS, VWAP930_REENTRY_STATUSES,
} = require("../config/constants");
const { checkPriceTouch } = require("./priceTouchUtil");

// "no entries before 09:30 IST" — built from VWAP930_ENTRY_START_HOUR/MINUTE
// so this text can never drift from the actual gate.
function entryStartStr() {
  return `${String(VWAP930_ENTRY_START_HOUR).padStart(2, "0")}:${String(VWAP930_ENTRY_START_MINUTE).padStart(2, "0")}`;
}

// Is IST time h:m at or after the VWAP930_ENTRY_START_HOUR:VWAP930_ENTRY_START_MINUTE gate?
function isAfterEntryStart(h, m) {
  return h > VWAP930_ENTRY_START_HOUR || (h === VWAP930_ENTRY_START_HOUR && m >= VWAP930_ENTRY_START_MINUTE);
}

const NIFTY_TOKEN = 256265; // NSE:NIFTY 50 index

// ─── Build R:R (SL/Target driven by VWAP930_SL_PCT / VWAP930_TARGET_PCT) ─────
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

// ─── Find the CE / PE candidate legs whose premium is in the
// VWAP930_MIN_PREMIUM–VWAP930_MAX_PREMIUM band ────────────────────────────
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

// ─── Fetch a leg's own 1-min candles from 09:15 up to `now`, aggregate into
// VWAP930_CANDLE_MINUTES-minute candles, and return the latest COMPLETED
// such candle plus the VWAP as of that candle. Returns null if there isn't
// yet a full completed candle (e.g. too early in the session). ─────────────
async function getLeg3MinState(token, from, now) {
  const raw = await getClient().getHistoricalData(token, "minute", from, now, false, true);
  if (!raw || raw.length < 2) return null;
  // Exclude the currently-forming 1-min candle
  const completed = raw.slice(0, -1).map(c => ({
    open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date,
  }));
  const candles3m = aggregateCandles(completed, VWAP930_CANDLE_MINUTES);
  if (!candles3m.length) return null;
  const vwapSeries = calcVWAP(candles3m);
  const candle = candles3m[candles3m.length - 1];
  return { vwap: vwapSeries[vwapSeries.length - 1], close: candle.close, candle };
}

// ─── Decide CE vs PE from {ce, pe} candidates given each leg's latest
// completed VWAP930_CANDLE_MINUTES-minute candle state ────────────────────
// Qualifies only when that candle: (1) CLOSED strictly above its own VWAP —
// a mid-candle touch doesn't count, it must be a closed candle; (2) is GREEN
// (closed above where it opened); and (3) has a body bigger than its
// combined wicks — filters out dojis/indecision candles that happen to
// close above VWAP but show no real conviction.
// Returns { direction, leg, vwap, ceQualifies, peQualifies, vwapCE, vwapPE } or null
function decideDirection(ce, pe, stateCE, statePE) {
  const ceQualifies = ce != null && stateCE != null && stateCE.close > stateCE.vwap && isStrongGreenCandle(stateCE.candle);
  const peQualifies = pe != null && statePE != null && statePE.close > statePE.vwap && isStrongGreenCandle(statePE.candle);

  if (!ceQualifies && !peQualifies) return null;

  if (ceQualifies && peQualifies) {
    // Tie-break: greater distance above its own VWAP wins
    const ceDist = stateCE.close - stateCE.vwap;
    const peDist = statePE.close - statePE.vwap;
    return ceDist >= peDist
      ? { direction: "CE", leg: ce, vwap: stateCE.vwap }
      : { direction: "PE", leg: pe, vwap: statePE.vwap };
  }

  return ceQualifies
    ? { direction: "CE", leg: ce, vwap: stateCE.vwap }
    : { direction: "PE", leg: pe, vwap: statePE.vwap };
}

// ─── Live monitor: has an ACTIVE alert's own VWAP930_CANDLE_MINUTES-minute
// candle just CLOSED below its VWAP? If so, exit immediately — do not wait
// for SL/Target. Returns boolean; false (never throws) on any data gap so a
// transient API hiccup never blocks the normal SL/Target monitor.
//
// Cached per token for VWAP_CLOSE_CHECK_TTL_MS: the frontend polls
// /alerts roughly once a second, and each poll calls this via
// refreshActivePnL — without a cache that's a fresh historical-data API
// call to the broker every second per open leg, which will trip Kite's
// rate limits. A candle only closes every VWAP930_CANDLE_MINUTES minutes
// anyway, so re-checking this often only ever wastes calls. ───────────────
const vwapCloseCache = new Map(); // token -> { ts, result }
const VWAP_CLOSE_CHECK_TTL_MS = 20_000;

async function checkVwapCloseExit(alert) {
  if (!alert?.leg?.token) return false;
  const token = alert.leg.token;
  const nowMs = Date.now();

  const cached = vwapCloseCache.get(token);
  if (cached && nowMs - cached.ts < VWAP_CLOSE_CHECK_TTL_MS) return cached.result;

  const now  = new Date(nowMs);
  const from = new Date(now); from.setHours(9, 15, 0, 0);
  let result = false;
  try {
    const state = await getLeg3MinState(token, from, now);
    result = !!state && state.close < state.vwap;
  } catch {
    // leave result false — don't cache a failure as a false negative for long
    return false;
  }
  vwapCloseCache.set(token, { ts: nowMs, result });
  return result;
}

// ─── Main scan — continuous, no fixed checkpoints ────────────────────────────
// Called every minute by the live cron (index.js); never enters before
// VWAP930_ENTRY_START_HOUR:VWAP930_ENTRY_START_MINUTE IST. A signal fires the
// first time a CE/PE's own VWAP930_CANDLE_MINUTES-minute candle CLOSES
// strictly above its VWAP — the caller (doScan in routes/vwap930.js) is what
// stops further entries once a position is open, so re-checking every minute
// never double-enters.
async function runVWAP930Scan(expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  const now = new Date();
  const ist = new Date(now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
  const h = ist.getHours(), m = ist.getMinutes();
  const entryTime = `${String(h).padStart(2,"0")}:${String(m).padStart(2,"0")}`;
  if (!isAfterEntryStart(h, m)) {
    return { signal: false, reason: `No entries before ${entryStartStr()} IST (now ${entryTime})` };
  }

  const { ce, pe, spot } = await findCandidateLegs(expiry);
  if (!ce && !pe) {
    return { signal: false, reason: `No CE/PE in ₹${VWAP930_MIN_PREMIUM}–₹${VWAP930_MAX_PREMIUM} band`, spot };
  }

  const from = new Date(now); from.setHours(9, 15, 0, 0);
  const [stateCE, statePE] = await Promise.all([
    ce ? getLeg3MinState(ce.token, from, now) : Promise.resolve(null),
    pe ? getLeg3MinState(pe.token, from, now) : Promise.resolve(null),
  ]);

  const decision = decideDirection(ce, pe, stateCE, statePE);
  if (!decision) {
    return {
      signal: false,
      reason: `Neither CE nor PE has a green, strong-bodied ${VWAP930_CANDLE_MINUTES}-min candle closed above its VWAP at ${entryTime}`,
      spot,
      debug: { ce: ce ? { strike: ce.strike, close: stateCE?.close, vwap: stateCE?.vwap } : null,
               pe: pe ? { strike: pe.strike, close: statePE?.close, vwap: statePE?.vwap } : null },
    };
  }

  const { direction: dir, leg, vwap } = decision;
  const rr = buildRR(leg.ltp);

  return {
    signal:     true,
    id:         `VWAP930_${dir}_${leg.strike}_${Date.now()}`,
    entryTime,
    direction:  dir,
    strike:     leg.strike,
    leg,
    rr,
    vwap,
    vwapCE: stateCE?.vwap ?? null, vwapPE: statePE?.vwap ?? null,
    status:     "ACTIVE",
    currentPnL: 0,
    pnlPct:     0,
    spot,
    expiry,
    createdAt:  now.toISOString(),
  };
}

// ─── Update P&L for an existing alert (VWAP-close exit / SL / TARGET /
// 15:20 square-off / stagnant timeout) ────────────────────────────────────
// `vwapBroken` is the result of checkVwapCloseExit() for this alert — when
// true it wins over everything else, since "candle closed below VWAP" must
// exit immediately without waiting for SL/Target to actually be touched.
function updateAlertPnL(alert, currentLtp, vwapBroken = false) {
  const pnl = +(currentLtp - alert.rr.entry).toFixed(2);
  const pct = +(pnl / alert.rr.entry * 100).toFixed(2);
  const peakMove = +(Math.max(alert.peakMove ?? 0, currentLtp - alert.rr.entry)).toFixed(2);
  let status = alert.status;

  if (alert.status === "ACTIVE") {
    const now = new Date();
    const h = now.getHours(), m = now.getMinutes();
    const touch = checkPriceTouch(alert.rr, currentLtp, "target");
    const hoursOpen = alert.createdAt ? (now.getTime() - new Date(alert.createdAt).getTime()) / 3_600_000 : 0;
    if      (vwapBroken)                    status = "VWAP_EXIT";
    else if (touch === "SL")                status = "SL";
    else if (touch === "TARGET")            status = "TARGET";
    else if (h === 15 && m >= 20)           status = "TIME_EXIT";
    else if (hoursOpen >= VWAP930_STAGNANT_HOURS && peakMove < VWAP930_STAGNANT_MAX_POINTS)
                                             status = "STAGNANT_EXIT";
  }

  const exitTime = (status !== "ACTIVE" && alert.status === "ACTIVE")
    ? new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit", hour12: false, timeZone: "Asia/Kolkata" })
    : alert.exitTime;

  return { ...alert, currentPnL: pnl, pnlPct: pct, status, exitTime, lastLtp: currentLtp, peakMove };
}

// ─── Historical / Backtest scan — up to VWAP930_MAX_TRADES_PER_DAY trades ───
// No fixed checkpoint grid — walks every VWAP930_CANDLE_MINUTES-minute
// boundary from the entry-start gate onward (mirroring the live continuous
// scan), each recomputing its own ATM fresh (spot can drift between
// checkpoints), same as findCandidateLegs does live. Takes the first
// checkpoint where a CE or PE's own candle closes above its VWAP; if that
// trade exits with a status in VWAP930_REENTRY_STATUSES and the cap isn't
// reached, tries the next checkpoint after that exit for one more entry —
// same re-entry rule as doScan() in vwap930.js.
async function runHistoricalVWAP930Scan(date, expiry) {
  if (!isAuthenticated()) throw new Error("Not authenticated");

  const from = new Date(date); from.setHours(9, 15, 0, 0);
  const to   = new Date(date); to.setHours(15, 30, 0, 0);

  const rawNifty = await getClient().getHistoricalData(NIFTY_TOKEN, "minute", from, to, false, false);
  if (!rawNifty || rawNifty.length < 6)
    throw new Error(`No NIFTY candle data for ${date}. Market may have been closed.`);

  const { getOptionChainInstruments } = require("./kiteService");
  let instruments = [];
  try { instruments = await getOptionChainInstruments(expiry); } catch {}
  const tokenMap = {};
  for (const inst of instruments) {
    tokenMap[`${Number(inst.strike)}_${inst.instrument_type}`] = inst.instrument_token;
  }

  const offsets = [0, -50, 50, -100, 100, -150, 150];

  // 3-min-aligned checkpoints: every VWAP930_CANDLE_MINUTES minutes starting
  // at the entry-start gate (09:30, which — since the session opens 09:15 —
  // already lands exactly on a candle boundary), through market close.
  const checkpoints = [];
  {
    const start = new Date(date); start.setHours(VWAP930_ENTRY_START_HOUR, VWAP930_ENTRY_START_MINUTE, 0, 0);
    const end   = new Date(date); end.setHours(15, 30, 0, 0);
    for (let t = start.getTime(); t <= end.getTime(); t += VWAP930_CANDLE_MINUTES * 60_000) {
      checkpoints.push(new Date(t));
    }
  }

  // Cache each strike's full-day 1-min candles + aggregated
  // VWAP930_CANDLE_MINUTES-minute candles/VWAP series — computed once,
  // reused across every checkpoint attempt.
  const seriesCache = new Map(); // `${strike}_${type}` -> series | null
  async function getSeries(strike, type) {
    const key = `${strike}_${type}`;
    if (seriesCache.has(key)) return seriesCache.get(key);
    const token = tokenMap[key];
    let series = null;
    if (token) {
      const raw = await getClient().getHistoricalData(token, "minute", from, to, false, true).catch(() => []);
      if (raw && raw.length >= VWAP930_CANDLE_MINUTES * 2) {
        const candles   = raw.map(c => ({ open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume, date: c.date }));
        const candles3m = aggregateCandles(candles, VWAP930_CANDLE_MINUTES);
        const vwap3m    = calcVWAP(candles3m);
        series = { token, candles, candles3m, vwap3m };
      }
    }
    seriesCache.set(key, series);
    return series;
  }

  // Evaluate a single checkpoint — mirrors live's runVWAP930Scan for that
  // instant. Returns the chosen leg/direction, or null if neither CE nor PE
  // has a completed VWAP930_CANDLE_MINUTES-minute candle closing above its VWAP.
  async function tryCheckpoint(entryMark) {
    const entryNiftyCandle = rawNifty.find(c => new Date(c.date).getTime() >= entryMark.getTime());
    if (!entryNiftyCandle) return null;
    const spot = entryNiftyCandle.open;
    const atm  = getATM(spot);

    async function fetchCandidate(type) {
      for (const off of offsets) {
        const strike = atm + off;
        const series = await getSeries(strike, type);
        if (!series) continue;
        const { token, candles, candles3m, vwap3m } = series;
        // Latest VWAP930_CANDLE_MINUTES-minute candle fully closed at/before this checkpoint
        let idx3 = -1;
        for (let i = 0; i < candles3m.length; i++) {
          if (new Date(candles3m[i].date).getTime() <= entryMark.getTime()) idx3 = i; else break;
        }
        if (idx3 < 0) continue;
        const candle3 = candles3m[idx3];
        const premium = candle3.close;
        if (premium < VWAP930_MIN_PREMIUM || premium > VWAP930_MAX_PREMIUM) continue;
        // Approximate the live entry price: the 1-min candle right after
        // this confirming candle closed (the price the moment it's detected)
        const entryIdx = candles.findIndex(c => new Date(c.date).getTime() > new Date(candle3.date).getTime());
        if (entryIdx === -1) continue;
        const entryCandle = candles[entryIdx];
        return {
          strike, token, premium, vwap: vwap3m[idx3], confirmIdx3: idx3, candle3,
          entryCandle, entryIdx, candles, candles3m, vwap3m,
        };
      }
      return null;
    }

    const [ceCand, peCand] = await Promise.all([fetchCandidate("CE"), fetchCandidate("PE")]);
    const ceQualifies = ceCand && ceCand.premium > ceCand.vwap && isStrongGreenCandle(ceCand.candle3);
    const peQualifies = peCand && peCand.premium > peCand.vwap && isStrongGreenCandle(peCand.candle3);
    if (!ceQualifies && !peQualifies) return null;

    let chosen, dir;
    if (ceQualifies && peQualifies) {
      const ceDist = ceCand.premium - ceCand.vwap;
      const peDist = peCand.premium - peCand.vwap;
      if (ceDist >= peDist) { chosen = ceCand; dir = "CE"; } else { chosen = peCand; dir = "PE"; }
    } else if (ceQualifies) { chosen = ceCand; dir = "CE"; }
    else { chosen = peCand; dir = "PE"; }

    return { chosen, dir, spot, ceCand, peCand, entryMark };
  }

  // Find the first checkpoint (strictly after `afterMs`, if given) where a
  // CE or PE actually qualifies.
  async function attemptEntry(afterMs) {
    for (const entryMark of checkpoints) {
      if (afterMs != null && entryMark.getTime() <= afterMs) continue;
      const picked = await tryCheckpoint(entryMark);
      if (picked) return picked;
    }
    return null;
  }

  // Resolve one picked checkpoint's full trade outcome (VWAP-close exit /
  // SL / Target / EOD / time-exit) by walking its candles forward — mirrors
  // the live per-trade monitor. A VWAP-close exit (the trade's own
  // VWAP930_CANDLE_MINUTES-minute candle closing below its VWAP) wins over
  // SL/Target at the same step, same priority as updateAlertPnL live.
  function resolveOutcome(picked) {
    const { chosen, dir, spot, ceCand, peCand, entryMark } = picked;
    const entry = chosen.premium;
    const rr = buildRR(entry);
    const stagnantCutoffMs = entryMark.getTime() + VWAP930_STAGNANT_HOURS * 3_600_000;

    const laterCandles = chosen.candles.slice(chosen.entryIdx + 1);
    let status = "ACTIVE", exitPrice = entry, exitTime = null, peakMove = 0;
    let idx3Cursor = chosen.confirmIdx3 + 1;
    outer:
    for (const c of laterCandles) {
      const { h: ch, m: cm } = toIST(c.date);
      const move = +(c.high - entry).toFixed(2);
      if (move > peakMove) peakMove = move;

      while (idx3Cursor < chosen.candles3m.length &&
             new Date(chosen.candles3m[idx3Cursor].date).getTime() <= new Date(c.date).getTime()) {
        const c3 = chosen.candles3m[idx3Cursor];
        if (c3.close < chosen.vwap3m[idx3Cursor]) {
          status = "VWAP_EXIT"; exitPrice = c3.close; exitTime = c3.date;
          break outer;
        }
        idx3Cursor++;
      }

      if (c.low  <= rr.sl)     { status = "SL";        exitPrice = rr.sl;     exitTime = c.date; break; }
      if (c.high >= rr.target) { status = "TARGET";    exitPrice = rr.target; exitTime = c.date; break; }
      if (ch === 15 && cm >= 20) { status = "TIME_EXIT"; exitPrice = c.close; exitTime = c.date; break; }
      if (new Date(c.date).getTime() >= stagnantCutoffMs && peakMove < VWAP930_STAGNANT_MAX_POINTS) {
        status = "STAGNANT_EXIT"; exitPrice = c.close; exitTime = c.date; break;
      }
    }
    if (status === "ACTIVE" && laterCandles.length) {
      exitPrice = laterCandles[laterCandles.length - 1].close;
      status    = "EOD";
      exitTime  = laterCandles[laterCandles.length - 1].date;
    }

    const pnl = +(exitPrice - entry).toFixed(2);
    const pct = +(pnl / entry * 100).toFixed(2);
    const entryTimeStr = `${String(entryMark.getHours()).padStart(2,"0")}:${String(entryMark.getMinutes()).padStart(2,"0")}`;
    const exitTimeStr = exitTime
      ? new Date(exitTime).toLocaleTimeString("en-IN", { hour12: false, timeZone: "Asia/Kolkata", hour: "2-digit", minute: "2-digit" })
      : null;

    return {
      result: {
        id:         `hist_VWAP930_${dir}_${chosen.strike}_${date}_${entryTimeStr.replace(":", "")}`,
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
      },
      exitTimeMs: exitTime ? new Date(exitTime).getTime() : entryMark.getTime(),
    };
  }

  // At most VWAP930_MAX_TRADES_PER_DAY entries: keep going only while the
  // most recent one exited with a status in VWAP930_REENTRY_STATUSES — any
  // other outcome (EOD/TIME_EXIT), or hitting the cap, ends the day. Mirrors
  // the live daily-limit gate in vwap930.js.
  const results = [];
  let picked = await attemptEntry(null);
  while (picked && results.length < VWAP930_MAX_TRADES_PER_DAY) {
    const { result, exitTimeMs } = resolveOutcome(picked);
    results.push(result);
    if (!VWAP930_REENTRY_STATUSES.includes(result.status) || results.length >= VWAP930_MAX_TRADES_PER_DAY) break;
    picked = await attemptEntry(exitTimeMs);
  }

  if (!results.length) {
    return {
      results: [], date, expiry, totalSignals: 0, wins: 0, losses: 0, winRate: null,
      message: `No CE/PE in premium band with a ${VWAP930_CANDLE_MINUTES}-min candle closing above VWAP after ${entryStartStr()}`,
    };
  }

  const wins   = results.filter(r => r.status === "TARGET").length;
  const losses = results.filter(r => r.status === "SL").length;
  const eod    = results.filter(r => r.status === "EOD").length;
  const closed = results.filter(r => r.status !== "ACTIVE").length;

  return {
    results,
    date, expiry,
    totalSignals: results.length,
    wins, losses,
    eod,
    winRate: closed > 0 ? +((wins / closed) * 100).toFixed(1) : null,
  };
}

module.exports = {
  runVWAP930Scan, runHistoricalVWAP930Scan, updateAlertPnL, buildRR,
  checkVwapCloseExit, isAfterEntryStart, entryStartStr,
};
