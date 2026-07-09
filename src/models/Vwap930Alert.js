const mongoose = require("mongoose");

const Vwap930AlertSchema = new mongoose.Schema({
  alertId:       { type: String, required: true, unique: true }, // a.id
  date:          { type: String, required: true },               // IST date YYYY-MM-DD
  tradingsymbol: String,                                         // leg.tradingsymbol for exit
  direction:     String,
  strike:        Number,
  expiry:        String,
  entryTime:  String,
  exitTime:   String,
  spot:       Number,
  vwap:       Number,        // VWAP of the chosen leg at entry
  vwapCE:     Number,        // CE candidate's VWAP at scan time (diagnostics)
  vwapPE:     Number,        // PE candidate's VWAP at scan time (diagnostics)
  rr:         mongoose.Schema.Types.Mixed,
  status:     String,
  currentPnL: Number,
  pnlPct:     Number,
  peakMove:   Number,
  lastLtp:    Number,
  createdAt:  String,
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: false });

module.exports = mongoose.model("Vwap930Alert", Vwap930AlertSchema);
