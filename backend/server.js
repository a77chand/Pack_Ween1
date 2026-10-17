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

createApp({ db, streets }).listen(PORT, () => console.log(`Pack_Ween running on http://localhost:${PORT}`));
