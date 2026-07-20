const mongoose = require("mongoose");

// Single shared document holding app-wide settings — no per-user auth exists
// in this app, so one "global" doc is the source of truth for every device.
const AccountDefaultsSchema = new mongoose.Schema({
  lockPoints:  { type: Number, default: null },
  stopLoss:    { type: Number, default: null },
  target:      { type: Number, default: null },
  quantity:    { type: Number, default: 10, enum: [5, 10, 15, 20] },
  productType: { type: String, default: "MIS", enum: ["MIS", "NRML"] },
  tradingMode: { type: String, default: "LIVE", enum: ["LIVE", "PAPER"] },
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  key:                     { type: String, required: true, unique: true, default: "global" },
  smcAutoTradeEnabled:     { type: Boolean, default: false },
  vwap930AutoTradeEnabled: { type: Boolean, default: false },
  accountDefaults:         { type: AccountDefaultsSchema, default: () => ({}) },
  updatedAt:               { type: Date, default: Date.now },
});

module.exports = mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
