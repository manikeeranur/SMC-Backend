const mongoose = require("mongoose");

// One document per named watchlist group
const WatchlistSchema = new mongoose.Schema({
  groupId:   { type: String, required: true, unique: true }, // e.g. "wl_default"
  name:      { type: String, required: true },
  items:     { type: mongoose.Schema.Types.Mixed, default: [] }, // array of WatchedOption
  updatedAt: { type: Date, default: Date.now },
});

module.exports = mongoose.models.Watchlist || mongoose.model("Watchlist", WatchlistSchema);
