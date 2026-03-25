const mongoose = require("mongoose");

const BacktestResultSchema = new mongoose.Schema({
  date:         { type: String, required: true },  // trading date YYYY-MM-DD
  expiry:       { type: String, required: true },
  runAt:        { type: Date, default: Date.now },
  totalSignals: Number,
  wins:         Number,
  losses:       Number,
  eod:          Number,
  winRate:      Number,
  results:      [mongoose.Schema.Types.Mixed],
}, { timestamps: false });

// One record per date+expiry — latest run overwrites previous
BacktestResultSchema.index({ date: 1, expiry: 1 }, { unique: true });

module.exports = mongoose.model("BacktestResult", BacktestResultSchema);
