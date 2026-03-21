/**
 * 9:26 AM Scanner  — selects best CE and PE
 *
 * Filters:   premium >= MIN_PREMIUM (default ₹200)
 * Scores on: Delta 0.25–0.50 | low OI/Vol ratio | high IV
 * RR:        SL = −30%, T1 = +30% (1:1), T2 = +75% (1:2.5)
 */

const MIN_PREMIUM = Number(process.env.MIN_PREMIUM) || 200;
const MAX_PREMIUM = 300; // strictly ₹200–₹300 range

function runScanner(rows, spot, minPremium = MIN_PREMIUM) {
  const candidates = [];
  rows.forEach(r => [r.ce, r.pe].forEach(leg => {
    if (leg.ltp >= minPremium && leg.ltp <= MAX_PREMIUM) candidates.push(leg);
  }));

  if (!candidates.length) {
    return { ce: null, pe: null, scanTime: now(), spot, active: false, minPremium };
  }

  const scored = candidates.map(leg => {
    const absDelta   = Math.abs(leg.delta);
    const deltaScore = (absDelta >= 0.25 && absDelta <= 0.50) ? 1 - Math.abs(absDelta - 0.35) * 3 : 0;
    const ivScore    = Math.min(leg.iv / 40, 1);
    const oiVolScore = leg.oiVolRatio > 0 ? Math.max(1 - Math.log(leg.oiVolRatio + 1) / 5, 0) : 0.8;
    const premScore  = Math.min((leg.ltp - minPremium) / (MAX_PREMIUM - minPremium), 1) * 0.1;
    return { ...leg, moveScore: +(deltaScore*0.35 + ivScore*0.30 + oiVolScore*0.25 + premScore).toFixed(4) };
  });

  const ces = scored.filter(l => l.type === "CE").sort((a, b) => b.moveScore - a.moveScore);
  const pes = scored.filter(l => l.type === "PE").sort((a, b) => b.moveScore - a.moveScore);

  const bestCE = ces[0] ?? null;

  // Pick best PE that is NOT the same strike as the selected CE
  const bestPE = bestCE
    ? (pes.find(p => p.strike !== bestCE.strike) ?? pes[0] ?? null)
    : (pes[0] ?? null);

  return {
    ce: bestCE,
    pe: bestPE,
    scanTime: now(),
    spot,
    active: !!(bestCE || bestPE),
    minPremium,
    maxPremium: MAX_PREMIUM,
    topCEs: ces.slice(0, 5),
    topPEs: pes.slice(0, 5),
  };
}

// Risk/Reward 1:2.5 — SL=30%, T1=1:1, T2=1:2.5
function calcRR(entry) {
  const risk   = +(entry * 0.30).toFixed(2);
  const reward = +(risk * 2.5).toFixed(2);
  return {
    entry,
    sl:        +(entry - risk).toFixed(2),
    target1:   +(entry + risk).toFixed(2),
    target2:   +(entry + reward).toFixed(2),
    risk,
    reward,
    riskPct:   30,
    rewardPct: 75,
  };
}

function calcPnL(current, rr) {
  const pnl = +(current - rr.entry).toFixed(2);
  const pct = +(pnl / rr.entry * 100).toFixed(2);
  let status = "ACTIVE";
  if (current <= rr.sl)      status = "SL";
  if (current >= rr.target2) status = "TARGET";
  return { pnl, pct, status };
}

function is926() {
  const n = new Date(), h = n.getHours(), m = n.getMinutes();
  return (h === 9 && m >= 26) || h > 9;
}

function now() {
  return new Date().toLocaleTimeString("en-IN", { hour12: false });
}

module.exports = { runScanner, calcRR, calcPnL, is926, now };
