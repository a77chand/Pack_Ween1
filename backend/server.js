const path = require("path");
const { openDb } = require("./src/db");
const { createStreetService, loadBaked } = require("./src/osm");
const { createApp } = require("./src/app");

const PORT = process.env.PORT || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");

const db = openDb(path.join(DATA_DIR, "pack-ween.db"));
const streets = createStreetService(db, {
  baked: loadBaked(path.join(__dirname, "osm")),
  enabled: process.env.OSM_DISABLED !== "1",
});

// A shared account so visitors can try it without making one (the PIN is in the README)
const demoAccount = { name: "Demo", pin: "1234" };

createApp({ db, streets, demoAccount }).listen(PORT, () => console.log(`Pack_Ween running on http://localhost:${PORT}`));

// Render's free plan sleeps after 15 minutes without traffic, and GitHub's scheduled
// ping only manages every few hours. So on Render the server pings its own public URL
// every 10 minutes: the request comes back in through Render's proxy and counts as
// traffic. (Running 24/7 is ~730 h/month, inside the free plan's 750 h.)
if (process.env.RENDER_EXTERNAL_URL) {
  setInterval(() => {
    fetch(`${process.env.RENDER_EXTERNAL_URL}/health`).catch((err) => console.warn("self-ping failed:", err.message));
  }, 10 * 60 * 1000);
}
