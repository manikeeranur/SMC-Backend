const mongoose = require("mongoose");

let connected = false;

async function connectDB() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.warn("[MongoDB] MONGODB_URI not set — skipping DB connection");
    return false;
  }
  if (connected) return true;
  try {
    await mongoose.connect(uri);
    connected = true;
    console.log("[MongoDB] Connected");
    return true;
  } catch (err) {
    console.error("[MongoDB] Connection failed:", err.message);
    return false;
  }
}

function isConnected() { return connected; }

module.exports = { connectDB, isConnected };
