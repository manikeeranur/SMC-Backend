"use strict";

const express   = require("express");
const router    = express.Router();
const { getClient, isAuthenticated } = require("../config/kite");
const autoTrade = require("./autoTrade");
const vwap930AutoTrade = require("./vwap930AutoTrade");
const DailyPnL  = require("../models/DailyPnL");
const { isConnected } = require("../config/db");
const { EXCHANGE, PRODUCT } = require("../config/constants");

// NFO (NIFTY/BANKNIFTY) + BFO (SENSEX) — both F&O segments we trade
const FNO_EXCHANGES = ["NFO", "BFO"];

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

  // Only include completed F&O orders (NFO = NIFTY/BNIFTY, BFO = SENSEX)
  const completed = orders.filter(o => o.status === "COMPLETE" && FNO_EXCHANGES.includes(o.exchange));
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

// ─── FIFO position builder — uses getQuote() for real-time LTP ───────────────
// getPositions().last_price is stale (REST snapshot); getQuote() gives live LTP
async function buildPositionsFromData(client, dayPositions, trades) {
  const atPositions = [...autoTrade.getPositions(), ...vwap930AutoTrade.getPositions()];

  // Build per-order fill summary, storing exchange per order
  const orderMap = {};
  for (const t of trades) {
    if (!FNO_EXCHANGES.includes(t.exchange)) continue;
    const id = t.order_id;
    if (!orderMap[id]) {
      orderMap[id] = {
        order_id: id, tradingsymbol: t.tradingsymbol,
        exchange: t.exchange,
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
    if (!symbolOrders[sym]) symbolOrders[sym] = { buys: [], sells: [], exchange: o.exchange };
    const rec = {
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

  // ── Fetch real-time quotes for all open positions via getQuote() ─────────────
  // getPositions().last_price is a stale REST snapshot; getQuote() = live LTP
  const openKeys = Object.entries(symbolOrders)
    .filter(([, { buys, sells }]) => buys.length > sells.length)
    .map(([sym, { exchange }]) => `${exchange}:${sym}`);

  let quoteMap = {};
  if (openKeys.length > 0) {
    try {
      quoteMap = await client.getQuote(openKeys);
    } catch (e) {
      console.warn("[Account] getQuote failed — falling back to last_price:", e.message);
    }
  }

  // ── FIFO match ────────────────────────────────────────────────────────────────
  const positions = [];
  for (const [sym, { buys, sells, exchange }] of Object.entries(symbolOrders)) {
    const kitePos  = dayPositions.find(p => p.tradingsymbol === sym);
    const quoteKey = `${exchange}:${sym}`;

    // Live LTP: getQuote() first, fall back to positions last_price
    const liveLTP      = quoteMap[quoteKey]?.last_price;
    const currentPrice = +(liveLTP || kitePos?.last_price || 0).toFixed(2);

    const at        = atPositions.find(a => a.tradingsymbol === sym);
    const direction = at?.direction ?? (sym.endsWith("CE") ? "CE" : "PE");
    const strike    = at?.strike ?? null;

    // Total open qty for this symbol (used to distribute kitePos.unrealised fairly)
    const openTotalQty = buys
      .filter((_, i) => !sells[i])
      .reduce((s, b) => s + b.quantity, 0) || 1;

    buys.forEach((buy, i) => {
      const sell         = sells[i] ?? null;
      const isOpen       = !sell;
      const sellPrice    = sell ? +sell.price.toFixed(2) : 0;

      let pnlVal;
      if (isOpen) {
        if (currentPrice > 0) {
          // Real-time P&L from live quote
          pnlVal = +((currentPrice - buy.price) * buy.quantity).toFixed(2);
        } else if (kitePos?.unrealised != null) {
          // Fallback: distribute Kite's unrealised proportionally across open trades
          pnlVal = +(kitePos.unrealised * buy.quantity / openTotalQty).toFixed(2);
        } else {
          pnlVal = 0;
        }
      } else {
        pnlVal = +((sell.price - buy.price) * buy.quantity).toFixed(2);
      }

      const exitTs       = sell?.ts ?? Date.now();
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

  positions.sort((a, b) => a._ts - b._ts);
  for (const p of positions) delete p._ts;
  return positions;
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

  const positions = await buildPositionsFromData(client, dayPositions, trades);

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
    .filter(o => FNO_EXCHANGES.includes(o.exchange))
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

// ─── GET /api/account/positions — lightweight 1-second live refresh ──────────
router.get("/positions", async (_req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  try {
    const client = getClient();
    const [positionsData, trades] = await Promise.all([
      client.getPositions().catch(() => ({ day: [], net: [] })),
      client.getTrades().catch(() => []),
    ]);
    const positions = await buildPositionsFromData(client, positionsData.day || [], trades);
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/account/order — place a new BUY/SELL market order ─────────────
router.post("/order", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  const { tradingsymbol, transaction_type, quantity, exchange } = req.body;
  if (!tradingsymbol || !transaction_type || !quantity) {
    return res.status(400).json({ error: "tradingsymbol, transaction_type and quantity are required" });
  }
  if (!["BUY", "SELL"].includes(transaction_type)) {
    return res.status(400).json({ error: "transaction_type must be BUY or SELL" });
  }
  const client = getClient();
  try {
    const exch = FNO_EXCHANGES.includes(exchange) ? exchange : EXCHANGE;
    const resp = await client.placeOrder("regular", {
      exchange:          exch,
      tradingsymbol,
      transaction_type,
      quantity:          Number(quantity),
      product:           PRODUCT,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "CHAIN_ORDER",
    });
    console.log(`[Account/Order] ${transaction_type} ${tradingsymbol} × ${quantity}  [order_id: ${resp.order_id}]`);
    res.json({ order_id: resp.order_id, tradingsymbol, transaction_type, quantity });
  } catch (err) {
    console.error("[Account/Order] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/account/exit — manually exit a single open position ────────────
router.post("/exit", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  const { tradingsymbol, quantity } = req.body;
  if (!tradingsymbol || !quantity) {
    return res.status(400).json({ error: "tradingsymbol and quantity are required" });
  }
  const client = getClient();
  try {
    // Cancel any open SL orders for this symbol
    const allOrders = await client.getOrders().catch(() => []);
    const openSLs = allOrders.filter(o =>
      o.tradingsymbol    === tradingsymbol &&
      (o.order_type === "SL-M" || o.order_type === "SL") &&
      o.transaction_type === "SELL" &&
      (o.status === "TRIGGER PENDING" || o.status === "OPEN")
    );
    for (const o of openSLs) {
      await client.cancelOrder(o.variety || "regular", o.order_id)
        .catch(e => console.warn(`[Account/Exit] SL cancel [${o.order_id}] — ${e.message}`));
    }
    // Detect the correct exchange from order history (BFO for SENSEX, NFO otherwise)
    const refOrder = allOrders.find(o => o.tradingsymbol === tradingsymbol);
    const exch     = FNO_EXCHANGES.includes(refOrder?.exchange) ? refOrder.exchange : EXCHANGE;
    // Place MARKET SELL
    const exitResp = await client.placeOrder("regular", {
      exchange:          exch,
      tradingsymbol,
      transaction_type:  "SELL",
      quantity,
      product:           PRODUCT,
      order_type:        "MARKET",
      validity:          "DAY",
      market_protection: 1,
      tag:               "MANUAL_EXIT",
    });
    console.log(`[Account/Exit] Manual exit — ${tradingsymbol} × ${quantity}  [order_id: ${exitResp.order_id}]`);
    res.json({ order_id: exitResp.order_id, tradingsymbol, quantity });
  } catch (err) {
    console.error("[Account/Exit] Error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── POST /api/account/exit-all — exit ALL open positions ────────────────────
router.post("/exit-all", async (req, res) => {
  if (!isAuthenticated()) return res.status(401).json({ error: "Not authenticated" });
  const client = getClient();
  try {
    const [positionsData, trades, allOrders] = await Promise.all([
      client.getPositions().catch(() => ({ day: [], net: [] })),
      client.getTrades().catch(() => []),
      client.getOrders().catch(() => []),
    ]);
    const positions    = await buildPositionsFromData(client, positionsData.day || [], trades);
    const openPositions = positions.filter(p => p.status === "OPEN");
    if (!openPositions.length) return res.json({ exited: [], message: "No open positions" });

    const results = [];
    for (const pos of openPositions) {
      try {
        // Detect exchange from order history
        const refOrder = allOrders.find(o => o.tradingsymbol === pos.tradingsymbol);
        const exch     = FNO_EXCHANGES.includes(refOrder?.exchange) ? refOrder.exchange : EXCHANGE;
        // Cancel open SL orders
        const openSLs = allOrders.filter(o =>
          o.tradingsymbol    === pos.tradingsymbol &&
          (o.order_type === "SL-M" || o.order_type === "SL") &&
          o.transaction_type === "SELL" &&
          (o.status === "TRIGGER PENDING" || o.status === "OPEN")
        );
        for (const o of openSLs) {
          await client.cancelOrder(o.variety || "regular", o.order_id)
            .catch(e => console.warn(`[Account/ExitAll] SL cancel [${o.order_id}] — ${e.message}`));
        }
        const exitResp = await client.placeOrder("regular", {
          exchange:          exch,
          tradingsymbol:     pos.tradingsymbol,
          transaction_type:  "SELL",
          quantity:          pos.quantity,
          product:           PRODUCT,
          order_type:        "MARKET",
          validity:          "DAY",
          market_protection: 1,
          tag:               "MANUAL_EXIT_ALL",
        });
        console.log(`[Account/ExitAll] Exited ${pos.tradingsymbol} × ${pos.quantity}  [order_id: ${exitResp.order_id}]`);
        results.push({ tradingsymbol: pos.tradingsymbol, order_id: exitResp.order_id, ok: true });
      } catch (err) {
        console.error(`[Account/ExitAll] Failed ${pos.tradingsymbol}:`, err.message);
        results.push({ tradingsymbol: pos.tradingsymbol, error: err.message, ok: false });
      }
    }
    res.json({ exited: results });
  } catch (err) {
    console.error("[Account/ExitAll] Error:", err.message);
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
