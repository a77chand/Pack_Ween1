const express = require("express");
const path = require("path");
const cors = require("cors");

const app = express();
app.use(cors()); // open to all origins (hackathon demo)
app.use(express.json());
// Serve the game page (backend/public/index.html) at /
app.use(express.static(path.join(__dirname, "public")));

// ===== DEMO LOCATION: change these to move all seed houses =====
const CENTER = { lat: 43.4723, lng: -80.5449 };

// Player must be within this many meters of a house to collect it
const VISIT_RADIUS_METERS = 25;

const ZONES = ["street", "district", "city"];
const PORT = process.env.PORT || 4000;

// Fixed seed houses: offsets in meters from CENTER [north, east]
// (all within ~300 m, so they stay in the same place on every restart)
const SEED_OFFSETS = [
  [120, 40],
  [-80, 150],
  [200, -180],
  [-250, -60],
  [30, 260],
  [-150, -220],
  [260, 120],
  [-30, -110],
  [90, -270],
  [-210, 230],
];

function offsetToLatLng(north, east) {
  const lat = CENTER.lat + north / 111320;
  const lng = CENTER.lng + east / (111320 * Math.cos((CENTER.lat * Math.PI) / 180));
  return { lat: Number(lat.toFixed(6)), lng: Number(lng.toFixed(6)) };
}

let houses = SEED_OFFSETS.map(([north, east], i) => ({
  id: i + 1,
  name: `House ${i + 1}`,
  ...offsetToLatLng(north, east),
}));

let runs = [];
let nextRunId = 1;
let messages = [];
let nextMsgId = 1;

// Distance between two coordinates in meters (Haversine formula)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

const isNum = (v) => typeof v === "number" && Number.isFinite(v);

// Health check
app.get("/health", (req, res) => res.json({ status: "ok" }));

// Get houses (optionally only those within ?radius= meters of ?lat=&lng=)
app.get("/houses", (req, res) => {
  const { lat, lng, radius } = req.query;
  if (lat === undefined && lng === undefined && radius === undefined)
    return res.json(houses);
  const la = Number(lat);
  const ln = Number(lng);
  const r = Number(radius);
  if (lat === undefined || lng === undefined || radius === undefined ||
      !Number.isFinite(la) || !Number.isFinite(ln) || !Number.isFinite(r) || r < 0)
    return res.status(400).json({ error: "lat, lng and radius must all be numbers" });
  res.json(houses.filter((h) => distanceMeters(la, ln, h.lat, h.lng) <= r));
});

// Volunteer adds a house
app.post("/houses", (req, res) => {
  const { name, lat, lng } = req.body || {};
  if (typeof name !== "string" || name.trim() === "")
    return res.status(400).json({ error: "name is required" });
  if (!isNum(lat) || !isNum(lng))
    return res.status(400).json({ error: "lat and lng are required" });
  const id = houses.reduce((max, h) => Math.max(max, h.id), 0) + 1;
  const house = { id, name: name.trim(), lat, lng };
  houses.push(house);
  res.json(house);
});

// Start a run
app.post("/runs/start", (req, res) => {
  const body = req.body || {};
  const zone = body.zone || "street";
  if (!ZONES.includes(zone))
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  const run = {
    id: nextRunId++,
    player: body.player || "anon",
    zone,
    startTime: Date.now(),
    endTime: null,
    visited: [],
  };
  runs.push(run);
  res.json({ runId: run.id, startTime: run.startTime });
});

// Record a visited house (player must be within VISIT_RADIUS_METERS)
app.post("/runs/:id/visit", (req, res) => {
  const run = runs.find((r) => r.id === Number(req.params.id));
  if (!run) return res.status(404).json({ error: "run not found" });
  if (run.endTime) return res.status(400).json({ error: "run already finished" });
  const { houseId, lat, lng } = req.body || {};
  if (!isNum(lat) || !isNum(lng))
    return res.status(400).json({ error: "lat and lng are required" });
  const house = houses.find((h) => h.id === Number(houseId));
  if (!house) return res.status(404).json({ error: "house not found" });
  const dist = Math.round(distanceMeters(lat, lng, house.lat, house.lng));
  if (dist > VISIT_RADIUS_METERS)
    return res.status(400).json({ error: "too far from house", distanceMeters: dist });
  if (!run.visited.includes(house.id)) run.visited.push(house.id);
  res.json({
    visited: run.visited.length,
    remaining: houses.length - run.visited.length,
  });
});

// Finish a run
app.post("/runs/:id/finish", (req, res) => {
  const run = runs.find((r) => r.id === Number(req.params.id));
  if (!run) return res.status(404).json({ error: "run not found" });
  if (run.endTime) return res.status(400).json({ error: "run already finished" });
  run.endTime = Date.now();
  res.json({
    houses: run.visited.length,
    seconds: Math.round((run.endTime - run.startTime) / 1000),
  });
});

// Leaderboard: most houses first, then fastest time
app.get("/leaderboard", (req, res) => {
  const { zone } = req.query;
  const list = runs
    .filter((r) => r.endTime && (!zone || r.zone === zone))
    .map((r) => ({
      player: r.player,
      zone: r.zone,
      houses: r.visited.length,
      seconds: Math.round((r.endTime - r.startTime) / 1000),
    }))
    .sort((a, b) => b.houses - a.houses || a.seconds - b.seconds);
  res.json(list);
});

// Route: visit the closest unvisited house each time (nearest-neighbor)
// Example: /route?lat=43.47&lng=-80.54&runId=1
app.get("/route", (req, res) => {
  let lat = Number(req.query.lat);
  let lng = Number(req.query.lng);
  if (req.query.lat === undefined || req.query.lng === undefined ||
      Number.isNaN(lat) || Number.isNaN(lng))
    return res.status(400).json({ error: "lat and lng are required" });

  // If a runId is given, skip houses that run already visited
  const run = runs.find((r) => r.id === Number(req.query.runId));
  const visited = run ? run.visited : [];
  let remaining = houses.filter((h) => !visited.includes(h.id));

  const route = [];
  let totalMeters = 0;
  while (remaining.length > 0) {
    let best = remaining[0];
    let bestDist = distanceMeters(lat, lng, best.lat, best.lng);
    for (const h of remaining) {
      const d = distanceMeters(lat, lng, h.lat, h.lng);
      if (d < bestDist) {
        best = h;
        bestDist = d;
      }
    }
    totalMeters += bestDist;
    route.push({ ...best, legMeters: Math.round(bestDist) });
    lat = best.lat;
    lng = best.lng;
    remaining = remaining.filter((h) => h.id !== best.id);
  }
  res.json({ totalMeters: Math.round(totalMeters), stops: route });
});

// Community chat (last 50 messages, optional ?zone=)
app.get("/chat", (req, res) => {
  const { zone } = req.query;
  res.json(messages.filter((m) => !zone || m.zone === zone).slice(-50));
});

app.post("/chat", (req, res) => {
  const { player, zone, text } = req.body || {};
  if (typeof text !== "string" || text.trim() === "")
    return res.status(400).json({ error: "text is required" });
  const z = zone || "street";
  if (!ZONES.includes(z))
    return res.status(400).json({ error: `zone must be one of: ${ZONES.join(", ")}` });
  const msg = {
    id: nextMsgId++,
    player: typeof player === "string" && player.trim() ? player.trim().slice(0, 20) : "anon",
    zone: z,
    text: text.trim().slice(0, 300),
    time: Date.now(),
  };
  messages.push(msg);
  if (messages.length > 200) messages.shift();
  res.json(msg);
});

// Unknown routes
app.use((req, res) => res.status(404).json({ error: "not found" }));

// Bad JSON bodies etc.
app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || "server error" });
});

app.listen(PORT, () => console.log(`Backend running on http://localhost:${PORT}`));
