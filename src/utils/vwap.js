"use strict";

// ─── VWAP (Volume Weighted Average Price) ────────────────────────────────────
// Cumulative typical-price × volume, reset at the start of the candle series
// (call with the current session's candles only — e.g. from 09:15 onwards).
// Returns an array the same length as `candles`, one VWAP value per candle.
function calcVWAP(candles) {
  let cumPV = 0, cumVol = 0;
  return candles.map((c) => {
    const typical = (c.high + c.low + c.close) / 3;
    const vol     = c.volume || 0;
    cumPV  += typical * vol;
    cumVol += vol;
    return +(cumVol > 0 ? cumPV / cumVol : typical).toFixed(2);
  });
}

// Convenience: VWAP of the last candle in the series
function latestVWAP(candles) {
  const series = calcVWAP(candles);
  return series.length ? series[series.length - 1] : null;
}

module.exports = { calcVWAP, latestVWAP };
