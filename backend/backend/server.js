const express = require("express");
const cors = require("cors");

const app = express();
app.use(cors());
app.use(express.json());

// CHANGE THIS to your own area (placeholder coordinates)
const CENTER = { lat: 43.4723, lng: -80.5449 };

let houses = Array.from({ length: 10 }, (_, i) => ({
  id: i + 1,
  name: `House ${i + 1}`,
  lat: CENTER.lat + (Math.random() - 0.5) * 0.004,
  lng: CENTER.lng + (Math.random() - 0.5) * 0.004,
}));

let runs = [];
let nextRunId = 1;

// Get all houses
app.get("/houses", (req, res) => res.json(houses));

// Volunteer adds a house
app.post("/houses", (req, res) => {
  const { name, lat, lng } = req.body;
  const house = { id: houses.length + 1, name, lat, lng };
  houses.push(house);
  res.json(house);
});

// Start a run
app.post("/runs/start", (req, res) => {
  const run = {
    id: nextRunId++,
    player: req.body.player || "anon",
    zone: req.body.zone || "street",
    startTime: Date.now(),
    endTime: null,
    visited: [],
  };
  runs.push(run);
  res.json({ runId: run.id, startTime: run.startTime });
});

// Record a visited house
app.post("/runs/:id/visit", (req, res) => {
  const run = runs.find((r) => r.id === Number(req.params.id));
  if (!run) return res.status(404).json({ error: "run not found" });
  const { houseId } = req.body;
  if (!houses.some((h) => h.id === houseId))
    return res.status(404).json({ error: "house not found" });
  if (!run.visited.includes(houseId)) run.visited.push(houseId);
  res.json({
    visited: run.visited.length,
    remaining: houses.length - run.visited.length,
  });
});

// Finish a run
app.post("/runs/:id/finish", (req, res) => {
  const run = runs.find((r) => r.id === Number(req.params.id));
  if (!run) return res.status(404).json({ error: "run not found" });
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

app.listen(4000, () => console.log("Backend running on http://localhost:4000"));