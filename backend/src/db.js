// SQLite storage (Node's built-in node:sqlite, so there is nothing extra to install).
// The database file lives in DATA_DIR (default backend/data); tests use ":memory:".

const fs = require("fs");
const path = require("path");
const { DatabaseSync } = require("node:sqlite");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS players (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  name_key   TEXT NOT NULL UNIQUE,          -- lower-case name, so names are unique
  pin_hash   TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,              -- sha256 of the bearer token
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL
);

-- Volunteer houses handing out candy
CREATE TABLE IF NOT EXISTS houses (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  full_size  INTEGER NOT NULL DEFAULT 0,    -- full-size bars: a power-up house
  owner_id   INTEGER REFERENCES players(id) ON DELETE SET NULL,
  hidden     INTEGER NOT NULL DEFAULT 0,    -- hidden after enough "no candy here" reports
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS house_reports (
  house_id   INTEGER NOT NULL REFERENCES houses(id) ON DELETE CASCADE,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (house_id, player_id)
);

CREATE TABLE IF NOT EXISTS runs (
  id             INTEGER PRIMARY KEY,
  player_id      INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode           TEXT NOT NULL,             -- 'gps' (ranked) or 'arcade'
  start_lat      REAL NOT NULL,
  start_lng      REAL NOT NULL,
  start_time     INTEGER NOT NULL,
  end_time       INTEGER,
  last_lat       REAL,                      -- last trusted position (anti-cheat)
  last_lng       REAL,
  last_time      INTEGER,
  budget         REAL,                      -- meters the player may still move (see anticheat.js)
  distance       REAL NOT NULL DEFAULT 0,   -- meters travelled
  strikes        INTEGER NOT NULL DEFAULT 0,
  flagged        INTEGER NOT NULL DEFAULT 0,
  cooldown_until INTEGER NOT NULL DEFAULT 0,
  penalty        INTEGER NOT NULL DEFAULT 0, -- seconds added (caught by ghosts)
  bonus          INTEGER NOT NULL DEFAULT 0, -- seconds removed (ghosts eaten)
  spooks         INTEGER NOT NULL DEFAULT 0,
  ghosts         INTEGER NOT NULL DEFAULT 0,
  power_at       INTEGER NOT NULL DEFAULT 0,
  power_ghosts   INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_finished ON runs (mode, flagged, end_time);

-- The candy houses of a run, fixed when it starts so the run is never affected
-- by houses being added or removed mid-game. house_id is null for demo houses.
CREATE TABLE IF NOT EXISTS run_houses (
  run_id     INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  idx        INTEGER NOT NULL,
  house_id   INTEGER REFERENCES houses(id) ON DELETE SET NULL,
  name       TEXT NOT NULL,
  lat        REAL NOT NULL,
  lng        REAL NOT NULL,
  full_size  INTEGER NOT NULL DEFAULT 0,
  visited_at INTEGER,
  PRIMARY KEY (run_id, idx)
);
CREATE INDEX IF NOT EXISTS run_houses_house ON run_houses (house_id);

CREATE TABLE IF NOT EXISTS messages (
  id        INTEGER PRIMARY KEY,
  player_id INTEGER REFERENCES players(id) ON DELETE SET NULL,
  player    TEXT NOT NULL,
  text      TEXT NOT NULL,
  lat       REAL,
  lng       REAL,
  time      INTEGER NOT NULL
);

-- Street maps from OpenStreetMap, cached because Overpass can take 30+ seconds
CREATE TABLE IF NOT EXISTS osm_cache (
  cell       TEXT PRIMARY KEY,
  data       TEXT NOT NULL,
  fetched_at INTEGER NOT NULL
);
`;

function openDb(file) {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA foreign_keys = ON;");
  if (file !== ":memory:") db.exec("PRAGMA journal_mode = WAL;");
  db.exec(SCHEMA);
  return db;
}

// Run fn inside a transaction
function tx(db, fn) {
  db.exec("BEGIN");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}

module.exports = { openDb, tx };
