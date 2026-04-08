"use strict";

const express   = require("express");
const router    = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const autoTrade = require("./autoTrade");
const DailyPnL  = require("../models/DailyPnL");
const { isConnected } = require("../config/db");

// ─── IST date YYYY-MM-DD ─────────────────────────────────────────────────────
function todayIST() {
  return new Date().toLocaleDateString("en-CA", { timeZone: "Asia/Kolkata" });
}

// ─── Save daily snapshot (upsert by date, fire-and-forget) ───────────────────
async function saveSnapshot(date, positions, charges, pnl) {
  if (!isConnected()) return;
  try {
    await DailyPnL.findOneAndUpdate(
      { date },
      { date, positions, charges, pnl, savedAt: new Date() },
      { upsert: true, new: true },
    );
  } catch (err) {
    console.warn("[Account] Snapshot save failed:", err.message);
  }
}

// ─── IST HH:MM:SS (AM/PM) from any timestamp ─────────────────────────────────
function toISTTime(ts) {
  if (!ts) return null;
  try {
    return new Date(ts).toLocaleTimeString("en-IN", {
      hour: "2-digit", minute: "2-digit", second: "2-digit",
      hour12: true, timeZone: "Asia/Kolkata",
    });
  } catch { return null; }
}

// ─── Fetch exact charges from Kite's own charge engine ───────────────────────
// Uses getvirtualContractNote (POST /charges/orders) — same engine Kite Console uses
// Falls back to zero-charge object if the call fails
async function fetchKiteCharges(client, orders) {
  const empty = { brokerage: 0, stt: 0, exchange: 0, sebi: 0, gst: 0, stampDuty: 0, total: 0 };

  // Only include completed NFO orders
  const completed = orders.filter(o => o.status === "COMPLETE" && o.exchange === "NFO");
  if (!completed.length) return empty;

  // Build input for getvirtualContractNote
  const params = completed.map(o => ({
    order_id:         o.order_id,
    exchange:         o.exchange,
    tradingsymbol:    o.tradingsymbol,
    transaction_type: o.transaction_type,
    variety:          o.variety || "regular",
    product:          o.product,
    order_type:       o.order_type,
    quantity:         o.filled_quantity || o.quantity,
    average_price:    o.average_price || 0,
  }));

  try {
    const resp = await client.getvirtualContractNote(params);
    // Response is an array — one charge object per order
    const rows = Array.isArray(resp) ? resp : (resp?.data ?? []);

    // Aggregate across all orders
    let brokerage = 0, stt = 0, exchange = 0, sebi = 0, gst = 0, stampDuty = 0;

    for (const r of rows) {
      const c = r.charges ?? r;
      brokerage += c.brokerage             ?? 0;
      stt       += c.transaction_tax       ?? 0;
      exchange  += c.exchange_turnover_charge ?? 0;
      sebi      += c.sebi_turnover_charge  ?? 0;
      gst       += c.gst?.total            ?? 0;
      stampDuty += c.stamp_duty            ?? 0;
    }

    const total = brokerage + stt + exchange + sebi + gst + stampDuty;
    return {
      brokerage:  +brokerage.toFixed(2),
      stt:        +stt.toFixed(2),
      exchange:   +exchange.toFixed(2),
      sebi:       +sebi.toFixed(2),
      gst:        +gst.toFixed(2),
      stampDuty:  +stampDuty.toFixed(2),
      total:      +total.toFixed(2),
    };
  } catch (err) {
    console.warn("[Account] getvirtualContractNote failed:", err.message);
    return empty;
  }
}

// ─── Build today's account data from Kite ────────────────────────────────────
async function buildAccountData() {
  const client = getClient();

  const [margins, positionsData, trades, orders] = await Promise.all([
    client.getMargins().catch(() => null),
    client.getPositions().catch(() => ({ day: [], net: [] })),
    client.getTrades().catch(() => []),
    client.getOrders().catch(() => []),
  ]);

  // ── Wallet ──────────────────────────────────────────────────────────────────
  const eq = margins?.equity || {};
  const wallet = {
    available:  +(eq.available?.live_balance ?? eq.net ?? 0).toFixed(2),
    used:       +(eq.utilised?.debits ?? 0).toFixed(2),
    net:        +(eq.net ?? 0).toFixed(2),
    deposit:    +(eq.available?.intraday_payin ?? 0).toFixed(2),
    withdrawal: +(eq.available?.intraday_payout ?? 0).toFixed(2),
  };

  // ── Charges ─────────────────────────────────────────────────────────────────
  const charges = await fetchKiteCharges(client, orders);

  // ── P&L from day positions ───────────────────────────────────────────────────
  const dayPositions  = positionsData.day || [];
  const realisedPnL   = dayPositions.reduce((s, p) => s + (p.realised   || 0), 0);
  const unrealisedPnL = dayPositions.reduce((s, p) => s + (p.unrealised || 0), 0);
  const pnl = {
    realised:   +realisedPnL.toFixed(2),
    unrealised: +unrealisedPnL.toFixed(2),
    total:      +(realisedPnL + unrealisedPnL).toFixed(2),
  };

  // ── Per-order records from fills ─────────────────────────────────────────────
  const orderMap = {};
  for (const t of trades) {
    if (t.exchange !== "NFO") continue;
    const id = t.order_id;
    if (!orderMap[id]) {
      orderMap[id] = {
        order_id: id, tradingsymbol: t.tradingsymbol,
        transaction_type: t.transaction_type,
        totalQty: 0, totalValue: 0, timestamp: null,
      };
    }
    const fillPrice = t.average_price || t.price || 0;
    orderMap[id].totalQty   += t.quantity;
    orderMap[id].totalValue += t.quantity * fillPrice;
    const ts = t.fill_timestamp || t.exchange_timestamp || t.order_timestamp;
    if (ts && !orderMap[id].timestamp) orderMap[id].timestamp = ts;
  }

  const symbolOrders = {};
  for (const o of Object.values(orderMap)) {
    const sym = o.tradingsymbol;
    if (!symbolOrders[sym]) symbolOrders[sym] = { buys: [], sells: [] };
    const rec = {
      order_id: o.order_id,
      quantity: o.totalQty,
      price:    o.totalValue / o.totalQty,
      time:     toISTTime(o.timestamp),
      ts:       o.timestamp ? new Date(o.timestamp).getTime() : 0,
    };
    if (o.transaction_type === "BUY") symbolOrders[sym].buys.push(rec);
    else                               symbolOrders[sym].sells.push(rec);
  }
  for (const s of Object.values(symbolOrders)) {
    s.buys.sort((a, b) => a.ts - b.ts);
    s.sells.sort((a, b) => a.ts - b.ts);
  }

  // ── FIFO match ───────────────────────────────────────────────────────────────
  const atPositions = autoTrade.getPositions();
  const positions   = [];
  for (const [sym, { buys, sells }] of Object.entries(symbolOrders)) {
    const kitePos      = dayPositions.find(p => p.tradingsymbol === sym);
    const currentPrice = +(kitePos?.last_price || 0).toFixed(2);
    const at           = atPositions.find(a => a.tradingsymbol === sym);
    const direction    = at?.direction ?? (sym.endsWith("CE") ? "CE" : "PE");
    const strike       = at?.strike ?? null;

    buys.forEach((buy, i) => {
      const sell      = sells[i] ?? null;
      const isOpen    = !sell;
      const sellPrice = sell ? +sell.price.toFixed(2) : 0;
      const pnlVal    = isOpen
        ? +((currentPrice - buy.price) * buy.quantity).toFixed(2)
        : +((sell.price   - buy.price) * buy.quantity).toFixed(2);

      const exitTs      = sell?.ts ?? Date.now();
      const durationSecs = buy.ts > 0 ? Math.floor((exitTs - buy.ts) / 1000) : null;

      positions.push({
        tradingsymbol: sym, direction, strike,
        quantity:  buy.quantity,
        buyPrice:  +buy.price.toFixed(2),
        sellPrice, currentPrice,
        pnl:       pnlVal,
        status:    isOpen ? "OPEN" : "CLOSED",
        atStatus:  at?.status ?? null,
        entryTime: buy.time,
        exitTime:  sell?.time ?? null,
        durationSecs,
        _ts:       buy.ts,
      });
    });
  }

  // ── Sort positions by entry time (oldest first) ───────────────────────────────
  positions.sort((a, b) => a._ts - b._ts);
  for (const p of positions) delete p._ts;

  // ── Stats ────────────────────────────────────────────────────────────────────
  const closedPos = positions.filter(p => p.status === "CLOSED");
  const winners   = closedPos.filter(p => p.pnl > 0).length;
  const losers    = closedPos.filter(p => p.pnl < 0).length;
  const stats = {
    totalTrades: closedPos.length,
    openTrades:  positions.filter(p => p.status === "OPEN").length,
    winners, losers,
    winRate: closedPos.length ? +(winners / closedPos.length * 100).toFixed(1) : 0,
    avgPnl:  closedPos.length
      ? +(closedPos.reduce((s, p) => s + p.pnl, 0) / closedPos.length).toFixed(2) : 0,
  };

  // ── Order book — sorted by time ascending (chronological) ───────────────────
  const orderBook = orders
    .filter(o => o.exchange === "NFO")
    .map(o => {
      const rawTs = o.exchange_update_timestamp || o.order_timestamp || o.exchange_timestamp;
      return {
        order_id:         o.order_id,
        tradingsymbol:    o.tradingsymbol,
        transaction_type: o.transaction_type,
        quantity:         o.filled_quantity || o.quantity,
        price:            +(o.average_price || o.price || 0).toFixed(2),
        trigger_price:    +(o.trigger_price || 0).toFixed(2),
        order_type:       o.order_type,
        status:           o.status,
        time:             toISTTime(rawTs),
        _ts:              rawTs ? new Date(rawTs).getTime() : 0,
      };
    })
    .sort((a, b) => a._ts - b._ts)
    .map(({ _ts, ...o }) => o);

  return { wallet, charges, pnl, positions, stats, orderBook };
}

// ─── GET /api/account ─────────────────────────────────────────────────────────
router.get("/", async (_req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  try {
    const data = await buildAccountData();
    saveSnapshot(todayIST(), data.positions, data.charges, data.pnl);
    res.json(data);
  } catch (err) {
    console.error("[Account] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── Auto-save at end of day (called by index.js cron at 15:31) ──────────────
async function eodSnapshot() {
  if (!isAuthenticated()) return;
  try {
    const data = await buildAccountData();
    await saveSnapshot(todayIST(), data.positions, data.charges, data.pnl);
    console.log("[Account] EOD snapshot saved for", todayIST());
  } catch (err) {
    console.warn("[Account] EOD snapshot failed:", err.message);
  }
}

// ─── All weekdays (Mon–Fri) between two YYYY-MM-DD strings ───────────────────
function weekdaysBetween(fromStr, toStr) {
  const days = [];
  const [fy, fm, fd] = fromStr.split("-").map(Number);
  const [ty, tm, td] = toStr.split("-").map(Number);
  const cur = new Date(fy, fm - 1, fd); // local date — no UTC shift
  const end = new Date(ty, tm - 1, td);
  while (cur <= end) {
    const d = cur.getDay();
    if (d !== 0 && d !== 6) {
      const y  = cur.getFullYear();
      const m  = String(cur.getMonth() + 1).padStart(2, "0");
      const dd = String(cur.getDate()).padStart(2, "0");
      days.push(`${y}-${m}-${dd}`);
    }
    cur.setDate(cur.getDate() + 1);
  }
  return days;
}

// ─── GET /api/account/report?from=YYYY-MM-DD&to=YYYY-MM-DD&type=trades|summary
router.get("/report", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  if (!isConnected())     return res.status(503).json({ error: "Database not connected" });

  const { from, to, type = "trades" } = req.query;
  if (!from || !to) return res.status(400).json({ error: "from and to are required" });

  try {
    // Fetch all saved snapshots in range
    const snapshots = await DailyPnL.find({ date: { $gte: from, $lte: to } }).sort({ date: 1 });
    const snapMap   = Object.fromEntries(snapshots.map(r => [r.date, r]));

    // All trading days in range (Mon–Fri)
    const allDays   = weekdaysBetween(from, to);
    const multiDay  = from !== to;

    const cell = v => `"${String(v ?? "").replace(/"/g, '""')}"`;
    const row  = cols => cols.map(cell).join(",");

    let csv = "";

    // Only process days that have snapshots
    const activeDays = allDays.filter(d => snapMap[d]);
    if (!activeDays.length) {
      return res.status(404).json({ error: "No trading data found for this period. Data is saved daily from 3:31 PM IST." });
    }

    // ── SUMMARY: one row per day that has data + overall total ───────────────
    if (type === "summary") {
      csv += row(["Date","Trades","Winners","Losers","Win Rate (%)","Gross P&L (₹)","Charges (₹)","Net P&L (₹)"]) + "\n";

      let tTrades = 0, tWinners = 0, tLosers = 0, tGross = 0, tCharges = 0;

      for (const date of activeDays) {
        const r       = snapMap[date];
        const closed  = (r.positions || []).filter(p => p.status === "CLOSED");
        const winners = closed.filter(p => p.pnl > 0).length;
        const losers  = closed.filter(p => p.pnl < 0).length;
        const winRate = closed.length ? (winners / closed.length * 100).toFixed(1) : "0.0";
        const gross   = +(r.pnl?.total    ?? 0);
        const chrgs   = +(r.charges?.total ?? 0);
        csv += row([date, closed.length, winners, losers, winRate,
                    gross.toFixed(2), chrgs.toFixed(2), (gross - chrgs).toFixed(2)]) + "\n";
        tTrades  += closed.length;
        tWinners += winners;
        tLosers  += losers;
        tGross   += gross;
        tCharges += chrgs;
      }

      const tWinRate = tTrades ? (tWinners / tTrades * 100).toFixed(1) : "0.0";
      csv += "\n";
      csv += row(["OVERALL TOTAL", tTrades, tWinners, tLosers, tWinRate,
                  tGross.toFixed(2), tCharges.toFixed(2), (tGross - tCharges).toFixed(2)]) + "\n";

      res.setHeader("Content-Type", "text/csv");
      res.setHeader("Content-Disposition", `attachment; filename="pnl_summary_${from}_${to}.csv"`);
      return res.send(csv);
    }

    // ── TRADES: every trade per day, daily subtotals, overall total ──────────
    csv += row(["Date","Symbol","Direction","Strike","Qty",
                "Entry Time","Exit Time","Entry Price (₹)","Exit Price (₹)","Gross P&L (₹)","Status"]) + "\n";

    let overallPnl = 0, overallCharges = 0;

    for (const date of activeDays) {
      const r      = snapMap[date];
      const dayPos = (r.positions || []);

      for (const p of dayPos) {
        csv += row([date, p.tradingsymbol, p.direction, p.strike ?? "",
                    p.quantity, p.entryTime ?? "", p.exitTime ?? "",
                    p.buyPrice, p.sellPrice || "", p.pnl, p.status]) + "\n";
      }

      const dailyPnl     = dayPos.reduce((s, p) => s + (p.pnl || 0), 0);
      const dailyCharges = +(r.charges?.total ?? 0);
      overallPnl     += dailyPnl;
      overallCharges += dailyCharges;

      if (multiDay) {
        csv += row([`${date} — Daily Gross`, "", "", "", "", "", "", "", "", dailyPnl.toFixed(2),              ""]) + "\n";
        csv += row([`${date} — Charges`,     "", "", "", "", "", "", "", "", `-${dailyCharges.toFixed(2)}`,    ""]) + "\n";
        csv += row([`${date} — Net P&L`,     "", "", "", "", "", "", "", "", (dailyPnl - dailyCharges).toFixed(2), ""]) + "\n";
        csv += "\n";
      }
    }

    csv += row(["OVERALL GROSS P&L", "", "", "", "", "", "", "", "", overallPnl.toFixed(2),                ""]) + "\n";
    csv += row(["OVERALL CHARGES",   "", "", "", "", "", "", "", "", `-${overallCharges.toFixed(2)}`,       ""]) + "\n";
    csv += row(["NET P&L (FINAL)",   "", "", "", "", "", "", "", "", (overallPnl - overallCharges).toFixed(2), ""]) + "\n";

    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="pnl_trades_${from}_${to}.csv"`);
    return res.send(csv);

  } catch (err) {
    console.error("[Account] Report error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
module.exports.eodSnapshot = eodSnapshot;
