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

// ─── Aggregate 1-min candles into N-min candles ──────────────────────────────
// Groups candles in sequence (index-based, not clock-based), so callers must
// pass candles starting from the session open (e.g. 09:15) for the buckets to
// land on real N-min boundaries. Only emits FULLY completed groups — a
// trailing partial group (fewer than `size` candles) is dropped, never
// padded, so the result never contains a still-forming candle.
function aggregateCandles(candles, size) {
  const out = [];
  for (let i = 0; i + size <= candles.length; i += size) {
    const chunk = candles.slice(i, i + size);
    out.push({
      open:   chunk[0].open,
      high:   Math.max(...chunk.map(c => c.high)),
      low:    Math.min(...chunk.map(c => c.low)),
      close:  chunk[chunk.length - 1].close,
      volume: chunk.reduce((s, c) => s + (c.volume || 0), 0),
      date:   chunk[chunk.length - 1].date,
    });
  }
  return out;
}

// ─── Candle strength check ────────────────────────────────────────────────
// GREEN (closed above where it opened) AND its body is bigger than its
// combined upper+lower wick — filters out dojis/indecision candles (long
// wicks, tiny body) even when the close happens to land above VWAP.
function isStrongGreenCandle(candle) {
  const body = candle.close - candle.open;
  if (body <= 0) return false;
  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;
  return body > upperWick + lowerWick;
}

module.exports = { calcVWAP, latestVWAP, aggregateCandles, isStrongGreenCandle };
