"use strict";

const Settings = require("../models/Settings");
const { isConnected } = require("../config/db");

const QUANTITY_ENUM     = [5, 10, 15, 20];
const PRODUCT_ENUM      = ["MIS", "NRML"];
const TRADING_MODE_ENUM = ["LIVE", "PAPER"];

// In-memory fallback — mirrors the Settings schema defaults, which in turn
// mirror today's hardcoded constants, so behavior is unchanged when Mongo is
// unreachable (same "DB optional, degrade gracefully" contract as watchlist.js).
const DEFAULTS = {
  key: "global",
  smcAutoTradeEnabled: false,
  vwap930AutoTradeEnabled: false,
  accountDefaults: {
    lockPoints:  null,
    stopLoss:    null,
    target:      null,
    quantity:    10,
    productType: "MIS",
    tradingMode: "LIVE",
  },
};

let cached = DEFAULTS;

function getCached() { return cached; }

async function loadOrCreate() {
  if (!isConnected()) return cached;
  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" },
      {},
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cached = doc;
    return doc;
  } catch (err) {
    console.error("[Settings] loadOrCreate error:", err.message);
    return cached;
  }
}

function validatePatch(patch) {
  if (patch.quantity != null && !QUANTITY_ENUM.includes(Number(patch.quantity))) {
    return `quantity must be one of ${QUANTITY_ENUM.join(", ")}`;
  }
  if (patch.productType != null && !PRODUCT_ENUM.includes(patch.productType)) {
    return `productType must be one of ${PRODUCT_ENUM.join(", ")}`;
  }
  if (patch.tradingMode != null && !TRADING_MODE_ENUM.includes(patch.tradingMode)) {
    return `tradingMode must be one of ${TRADING_MODE_ENUM.join(", ")}`;
  }
  for (const f of ["lockPoints", "stopLoss", "target"]) {
    if (patch[f] != null && (typeof patch[f] !== "number" || Number.isNaN(patch[f]))) {
      return `${f} must be a number or null`;
    }
  }
  return null;
}

async function patchAccountDefaults(patch) {
  const validationError = validatePatch(patch);
  if (validationError) throw Object.assign(new Error(validationError), { status: 400 });

  cached = { ...cached, accountDefaults: { ...cached.accountDefaults, ...patch } };
  if (!isConnected()) return cached;

  const set = { updatedAt: new Date() };
  for (const [k, v] of Object.entries(patch)) set[`accountDefaults.${k}`] = v;

  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" },
      { $set: set },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cached = doc;
    return doc;
  } catch (err) {
    console.error("[Settings] patchAccountDefaults error:", err.message);
    return cached;
  }
}

// engine: "smc" | "vwap930" — throws on DB failure so the route can surface a
// 500 instead of silently diverging from the DB (Auto Trade on/off must never
// look like it worked when it didn't persist).
async function setAutoTradeEnabled(engine, enabled) {
  const field = engine === "smc" ? "smcAutoTradeEnabled" : "vwap930AutoTradeEnabled";
  cached = { ...cached, [field]: enabled };
  if (!isConnected()) return cached;
  try {
    const doc = await Settings.findOneAndUpdate(
      { key: "global" },
      { $set: { [field]: enabled, updatedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    ).lean();
    cached = doc;
    return doc;
  } catch (err) {
    console.error(`[Settings] setAutoTradeEnabled(${engine}) error:`, err.message);
    throw err;
  }
}

module.exports = { loadOrCreate, patchAccountDefaults, setAutoTradeEnabled, getCached };
