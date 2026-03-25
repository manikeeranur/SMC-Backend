const mongoose = require("mongoose");

const AlertSchema = new mongoose.Schema({
  alertId:    { type: String, required: true, unique: true }, // a.id
  date:       { type: String, required: true },               // IST date YYYY-MM-DD
  direction:  String,
  strike:     Number,
  expiry:     String,
  entryTime:  String,
  exitTime:   String,
  spot:       Number,
  concepts:   [String],
  score:      Number,
  effScore:   Number,
  strength:   String,
  trendOk:    Boolean,
  rr:         mongoose.Schema.Types.Mixed,
  status:     String,
  currentPnL: Number,
  pnlPct:     Number,
  peakMove:   Number,
  t1Hit:      Boolean,
  t1HitTime:  String,
  lastLtp:    Number,
  createdAt:  String,
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: false });

module.exports = mongoose.model("Alert", AlertSchema);
