const { getNiftySpot, getOptionChainInstruments, getOptionQuotes, getATM, getNiftyExpiries } = require("./kiteService");
const { isAuthenticated } = require("../config/kite");

// ─── Black-Scholes ────────────────────────────────────────────────────────────
function normCDF(x) {
  const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429, p=0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - ((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return 0.5 * (1 + sign * y);
}
function normPDF(x) { return Math.exp(-0.5*x*x) / Math.sqrt(2*Math.PI); }

function calcGreeks(S, K, T, r, sigma, type) {
  if (T <= 0) T = 0.0001;
  const sq = Math.sqrt(T);
  const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*sq);
  const d2 = d1 - sigma*sq;
  const delta = type === "CE" ? normCDF(d1) : normCDF(d1) - 1;
  const gamma = normPDF(d1) / (S*sigma*sq);
  const theta = type === "CE"
    ? (-S*normPDF(d1)*sigma/(2*sq) - r*K*Math.exp(-r*T)*normCDF(d2)) / 365
    : (-S*normPDF(d1)*sigma/(2*sq) + r*K*Math.exp(-r*T)*normCDF(-d2)) / 365;
  const vega = S*normPDF(d1)*sq/100;
  return { delta:+delta.toFixed(4), gamma:+gamma.toFixed(6), theta:+theta.toFixed(2), vega:+vega.toFixed(2) };
}

// Newton-Raphson IV solver
function calcIV(S, K, T, r, mktPrice, type) {
  if (T <= 0 || mktPrice <= 0.05) return 0.20;
  let sigma = 0.20;
  for (let i = 0; i < 100; i++) {
    const sq = Math.sqrt(T);
    const d1 = (Math.log(S/K) + (r + 0.5*sigma*sigma)*T) / (sigma*sq);
    const d2 = d1 - sigma*sq;
    const price = type === "CE"
      ? S*normCDF(d1) - K*Math.exp(-r*T)*normCDF(d2)
      : K*Math.exp(-r*T)*normCDF(-d2) - S*normCDF(-d1);
    const vega = S*normPDF(d1)*sq;
    if (Math.abs(vega) < 1e-10) break;
    const diff = price - mktPrice;
    if (Math.abs(diff) < 0.001) break;
    sigma -= diff / vega;
    if (sigma <= 0) { sigma = 0.001; break; }
  }
  return Math.max(sigma, 0.01);
}

function daysToExpiry(expiry) {
  const d = new Date(expiry);
  d.setHours(15, 30, 0, 0);
  return Math.max((d.getTime() - Date.now()) / 86400000, 0.001);
}

// ─── Build chain from fetched instruments + quotes ────────────────────────────
function assembleChain(instruments, quotes, spot, atm, dte, expiry) {
  const T = dte / 365;
  const R = 0.065;

  // Group by strike (ensure numeric key)
  const strikeMap = {};
  for (const inst of instruments) {
    const sym = `NFO:${inst.tradingsymbol}`;
    const q   = quotes[sym];
    if (!q) continue;

    const K   = Number(inst.strike);
    const typ = inst.instrument_type; // "CE" or "PE"
    if (!strikeMap[K]) strikeMap[K] = {};

    const ltp    = q.last_price || 0.05;
    const oi     = q.oi || 0;
    const volume = q.volume_traded || q.volume || 0; // Kite REST uses volume_traded
    const iv     = calcIV(spot, K, T, R, ltp, typ);
    const greeks = calcGreeks(spot, K, T, R, iv, typ);

    strikeMap[K][typ] = {
      token:      inst.instrument_token,
      strike:     K,
      type:       typ,
      ltp,
      prevLtp:    q.ohlc?.close || ltp,
      ltpChange:  +(ltp - (q.ohlc?.close || ltp)).toFixed(2),
      oi,
      oiChange:   oi - (q.oi_day_low || oi), // net build from day's opening OI
      volume,
      iv:         +(iv * 100).toFixed(2),
      delta:      greeks.delta,
      gamma:      greeks.gamma,
      theta:      greeks.theta,
      vega:       greeks.vega,
      bid:        q.depth?.buy?.[0]?.price  || +(ltp * 0.996).toFixed(2),
      ask:        q.depth?.sell?.[0]?.price || +(ltp * 1.004).toFixed(2),
      oiVolRatio: volume > 0 ? +(oi / volume).toFixed(1) : 999,
      moveScore:  0,
    };
  }

  // Build rows (only strikes that have both CE and PE)
  const rows = Object.keys(strikeMap)
    .map(Number)
    .sort((a, b) => a - b)   // ascending (lowest strike at top)
    .filter(s => strikeMap[s].CE && strikeMap[s].PE)
    .map(s => ({
      strike:  s,
      isATM:   s === atm,
      ce:      strikeMap[s].CE,
      pe:      strikeMap[s].PE,
      ceOIBar: 0,
      peOIBar: 0,
    }));

  if (!rows.length) throw new Error(`No complete CE+PE pairs found for expiry ${expiry}`);

  // OI bars
  const maxCE = Math.max(...rows.map(r => r.ce.oi), 1);
  const maxPE = Math.max(...rows.map(r => r.pe.oi), 1);
  rows.forEach(r => {
    r.ceOIBar = (r.ce.oi / maxCE) * 100;
    r.peOIBar = (r.pe.oi / maxPE) * 100;
  });

  // PCR
  const totalCEOI  = rows.reduce((s, r) => s + r.ce.oi, 0);
  const totalPEOI  = rows.reduce((s, r) => s + r.pe.oi, 0);
  const totalCEVol = rows.reduce((s, r) => s + r.ce.volume, 0);
  const totalPEVol = rows.reduce((s, r) => s + r.pe.volume, 0);
  const pcrVol = totalCEVol > 0 ? +(totalPEVol / totalCEVol).toFixed(3) : 0;
  const pcrOI  = totalCEOI  > 0 ? +(totalPEOI  / totalCEOI).toFixed(3)  : 0;

  // Max Pain
  let minLoss = Infinity, maxPain = rows[0]?.strike ?? atm;
  for (const { strike: exp } of rows) {
    let loss = 0;
    for (const { strike: s, ce, pe } of rows) {
      if (exp > s) loss += (exp - s) * ce.oi;
      if (exp < s) loss += (s - exp) * pe.oi;
    }
    if (loss < minLoss) { minLoss = loss; maxPain = exp; }
  }

  return {
    spot:         +spot.toFixed(2),
    expiry,
    daysToExpiry: +dte.toFixed(2),
    rows,
    pcr:          pcrVol,
    pcrOI,
    maxPain,
    totalCEOI,
    totalPEOI,
    atmIV:        rows.find(r => r.isATM)?.ce.iv ?? 0,
    updatedAt:    new Date().toISOString(),
  };
}

// ─── Main export ──────────────────────────────────────────────────────────────
async function buildOptionChain(expiry, nEach = 15) {
  if (!isAuthenticated()) throw new Error("Not authenticated with Kite");

  const spot = await getNiftySpot();
  const atm  = getATM(spot);
  const dte  = daysToExpiry(expiry);

  // Fetch all instruments for this expiry (date fix is inside getOptionChainInstruments)
  const allInst = await getOptionChainInstruments(expiry);
  if (!allInst.length) {
    throw new Error(`No NIFTY option instruments found for expiry ${expiry}. Check backend console for available dates.`);
  }

  // Filter to ±nEach strikes around ATM (numeric comparison)
  const wantStrikes = new Set();
  for (let i = -nEach; i <= nEach; i++) wantStrikes.add(atm + i * 50);

  let instruments = allInst.filter(i => wantStrikes.has(Number(i.strike)));

  // Fallback: if ATM filter removes everything, use all available strikes
  if (!instruments.length) {
    console.warn(`[Chain] ATM filter empty — using all ${allInst.length} instruments for ${expiry}`);
    instruments = allInst;
  }

  console.log(`[Chain] Fetching quotes for ${instruments.length} instruments (expiry ${expiry}, ATM ${atm})`);

  const quotes = await getOptionQuotes(instruments);
  return assembleChain(instruments, quotes, spot, atm, dte, expiry);
}

module.exports = { buildOptionChain, getNiftyExpiries };
