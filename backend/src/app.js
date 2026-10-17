// The Express app: JSON API plus the game page in backend/public.
// createApp() takes its database, street-map service and clock as arguments so
// tests can run it in memory with a fake clock.

const crypto = require("crypto");
const path = require("path");
const express = require("express");
const cors = require("cors");
const { distanceMeters, round, isNum, isLat, isLng, toRad } = require("./geo");
const { tx } = require("./db");
const { checkMove, LIMITS } = require("./anticheat");
const { neighbourhood, realHousesNear, publicHouse, VERIFY_CLAIMS } = require("./neighbourhood");
const { planRoute } = require("./route");

// The demo neighbourhood used when the player's location is unknown
const DEFAULT_CENTER = { lat: 43.4723, lng: -80.5449 };

const VISIT_RADIUS_METERS = 25;
const MODES = ["gps", "arcade"];
const SCOPES = { street: 300, district: 3000, city: 25000, world: Infinity };
const SPOOK_PENALTY = 10;      // seconds added when a ghost catches you
const GHOST_BONUS = 5;         // seconds removed for each ghost eaten
const GHOSTS_PER_POWER = 4;
const MAX_HOUSES_PER_PLAYER = 3;
const HOUSE_MIN_GAP = 15;      // meters between two volunteer houses
const REPORTS_TO_HIDE = 3;
const REPORT_RADIUS = 60;      // you must be this close to report a house
const STALE_RUN_MS = 3 * 60 * 60 * 1000;
const CHAT_RADIUS = 5000;

const NAME_RE = /^[\p{L}\p{N} _.'-]{2,20}$/u;
const PIN_RE = /^\d{4,8}$/;

function hashPin(pin, salt = crypto.randomBytes(16).toString("hex")) {
  return `${salt}:${crypto.scryptSync(pin, salt, 32).toString("hex")}`;
}
function pinMatches(pin, stored) {
  const [salt, hash] = stored.split(":");
  const test = crypto.scryptSync(pin, salt, 32);
  return crypto.timingSafeEqual(test, Buffer.from(hash, "hex"));
}
const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// Tiny in-memory rate limiter: at most `limit` hits per `windowMs` for a key
function limiter(limit, windowMs, now) {
  const hits = new Map();
  return (key) => {
    const t = now();
    const list = (hits.get(key) || []).filter((x) => t - x < windowMs);
    if (list.length >= limit) { hits.set(key, list); return false; }
    list.push(t);
    hits.set(key, list);
    if (hits.size > 5000) hits.delete(hits.keys().next().value);
    return true;
  };
}

function createApp({ db, streets, now = () => Date.now(), publicDir = path.join(__dirname, "..", "public") }) {
  const app = express();
  app.set("trust proxy", 1);
  app.use(cors()); // open to all origins so any front end can call the API
  app.use(express.json({ limit: "20kb" }));
  app.use(express.static(publicDir));

  const loginLimit = limiter(20, 60 * 1000, now);
  const failedPins = limiter(5, 10 * 60 * 1000, now);
  const chatLimit = limiter(1, 1500, now);
  const eventLimit = limiter(10, 10 * 1000, now);

  const q = {
    playerByKey: db.prepare("SELECT * FROM players WHERE name_key = ?"),
    playerByToken: db.prepare("SELECT p.id, p.name FROM sessions s JOIN players p ON p.id = s.player_id WHERE s.token_hash = ?"),
    insertPlayer: db.prepare("INSERT INTO players (name, name_key, pin_hash, created_at) VALUES (?, ?, ?, ?)"),
    insertSession: db.prepare("INSERT INTO sessions (token_hash, player_id, created_at) VALUES (?, ?, ?)"),
    run: db.prepare("SELECT * FROM runs WHERE id = ?"),
    runHouses: db.prepare("SELECT * FROM run_houses WHERE run_id = ? ORDER BY idx"),
    runHouse: db.prepare("SELECT * FROM run_houses WHERE run_id = ? AND idx = ?"),
    visitedCount: db.prepare("SELECT COUNT(*) AS n FROM run_houses WHERE run_id = ? AND visited_at IS NOT NULL"),
    totalCount: db.prepare("SELECT COUNT(*) AS n FROM run_houses WHERE run_id = ?"),
    markVisited: db.prepare("UPDATE run_houses SET visited_at = ? WHERE run_id = ? AND idx = ?"),
    insertRun: db.prepare("INSERT INTO runs (player_id, mode, start_lat, start_lng, start_time) VALUES (?, ?, ?, ?, ?)"),
    insertRunHouse: db.prepare("INSERT INTO run_houses (run_id, idx, house_id, name, lat, lng, full_size) VALUES (?, ?, ?, ?, ?, ?, ?)"),
    openRuns: db.prepare("SELECT * FROM runs WHERE player_id = ? AND end_time IS NULL ORDER BY id DESC"),
    finishRun: db.prepare("UPDATE runs SET end_time = ? WHERE id = ?"),
    house: db.prepare("SELECT * FROM houses WHERE id = ?"),
    insertHouse: db.prepare("INSERT INTO houses (name, lat, lng, full_size, owner_id, created_at) VALUES (?, ?, ?, ?, ?, ?)"),
    ownedHouses: db.prepare("SELECT COUNT(*) AS n FROM houses WHERE owner_id = ? AND hidden = 0"),
    deleteHouse: db.prepare("DELETE FROM houses WHERE id = ?"),
    report: db.prepare("INSERT OR IGNORE INTO house_reports (house_id, player_id, created_at) VALUES (?, ?, ?)"),
    reportCount: db.prepare("SELECT COUNT(*) AS n FROM house_reports WHERE house_id = ?"),
    hideHouse: db.prepare("UPDATE houses SET hidden = 1 WHERE id = ?"),
    claims: db.prepare(`SELECT COUNT(DISTINCT r.player_id) AS n FROM run_houses rh JOIN runs r ON r.id = rh.run_id
      WHERE rh.house_id = ? AND rh.visited_at IS NOT NULL AND r.flagged = 0`),
    insertMsg: db.prepare("INSERT INTO messages (player_id, player, text, lat, lng, time) VALUES (?, ?, ?, ?, ?, ?)"),
  };

  const updateRun = (id, fields) => {
    const keys = Object.keys(fields);
    if (!keys.length) return;
    db.prepare(`UPDATE runs SET ${keys.map((k) => `${k} = ?`).join(", ")} WHERE id = ?`)
      .run(...keys.map((k) => fields[k]), id);
  };

  // ---------- Accounts ----------
  function currentPlayer(req) {
    const h = req.get("authorization") || "";
    const m = /^Bearer ([a-f0-9]{64})$/i.exec(h);
    return m ? q.playerByToken.get(sha256(m[1])) || null : null;
  }
  function requireAuth(req, res, next) {
    req.player = currentPlayer(req);
    if (!req.player) return res.status(401).json({ error: "sign in first" });
    next();
  }

  app.get("/health", (req, res) => res.json({ status: "ok" }));

  // Sign up or sign in with a name and a PIN. A new name is claimed on first use.
  app.post("/players", (req, res) => {
    if (!loginLimit(req.ip)) return res.status(429).json({ error: "too many attempts, wait a minute" });
    const name = typeof req.body?.name === "string" ? req.body.name.trim().replace(/\s+/g, " ") : "";
    const pin = typeof req.body?.pin === "string" ? req.body.pin : String(req.body?.pin ?? "");
    if (!NAME_RE.test(name)) return res.status(400).json({ error: "name must be 2-20 letters, numbers or spaces" });
    if (!PIN_RE.test(pin)) return res.status(400).json({ error: "PIN must be 4-8 digits" });
    const key = name.toLowerCase();
    let player = q.playerByKey.get(key);
    let created = false;
    if (player) {
      if (!pinMatches(pin, player.pin_hash)) {
        if (!failedPins(key)) return res.status(429).json({ error: "too many wrong PINs, try again in 10 minutes" });
        return res.status(401).json({ error: "that name is taken and the PIN doesn't match" });
      }
    } else {
      const r = q.insertPlayer.run(name, key, hashPin(pin), now());
      player = { id: Number(r.lastInsertRowid), name };
      created = true;
    }
    const token = crypto.randomBytes(32).toString("hex");
    q.insertSession.run(sha256(token), player.id, now());
    res.json({ token, created, player: { id: player.id, name: player.name } });
  });

  // ---------- Runs: helpers ----------
  const runSeconds = (run) => Math.round(((run.end_time ?? now()) - run.start_time) / 1000);
  const rankedSeconds = (run) => Math.max(0, runSeconds(run) + run.penalty - run.bonus);

  // Close runs the player walked away from, ending them at their last activity
  function closeStaleRuns(playerId, exceptRecent) {
    for (const run of q.openRuns.all(playerId)) {
      const last = run.last_time ?? run.start_time;
      if (!exceptRecent || now() - last > STALE_RUN_MS) q.finishRun.run(Math.max(last, run.start_time), run.id);
    }
  }

  function runState(run) {
    const houses = q.runHouses.all(run.id).map((h) => {
      const real = h.house_id != null ? q.house.get(h.house_id) : null;
      const claims = real ? q.claims.get(real.id).n : 0;
      return {
        id: h.idx,
        name: h.name,
        lat: h.lat,
        lng: h.lng,
        fullSize: !!h.full_size,
        demo: h.house_id == null,
        ref: h.house_id,
        visited: h.visited_at != null,
        ...(real && { claims, verified: claims >= VERIFY_CLAIMS, mine: real.owner_id === run.player_id }),
      };
    });
    return {
      runId: run.id,
      mode: run.mode,
      startTime: run.start_time,
      ended: run.end_time != null,
      flagged: !!run.flagged,
      strikes: run.strikes,
      penalty: run.penalty,
      bonus: run.bonus,
      ghosts: run.ghosts,
      spooks: run.spooks,
      last: run.last_lat != null ? { lat: run.last_lat, lng: run.last_lng } : null,
      houses,
    };
  }

  function ownRun(req, res) {
    const run = q.run.get(Number(req.params.id));
    if (!run || run.player_id !== req.player.id) {
      res.status(404).json({ error: "run not found" });
      return null;
    }
    return run;
  }

  function trackMove(run, lat, lng) {
    const result = checkMove(run, lat, lng, now());
    updateRun(run.id, result.fields);
    Object.assign(run, result.fields);
    return result;
  }

  const moveStatus = (run, move) => ({
    ok: move.ok,
    strikes: run.strikes,
    flagged: !!run.flagged,
    cooldown: Math.max(0, Math.ceil((run.cooldown_until - now()) / 1000)),
  });

  function readPosition(req, res) {
    const { lat, lng } = req.body || {};
    if (!isLat(lat) || !isLng(lng)) {
      res.status(400).json({ error: "lat and lng are required" });
      return null;
    }
    return { lat, lng };
  }

  app.get("/players/me", requireAuth, (req, res) => {
    closeStaleRuns(req.player.id, true);
    const runs = db.prepare(`
      SELECT r.*, (SELECT COUNT(*) FROM run_houses WHERE run_id = r.id AND visited_at IS NOT NULL) AS houses
      FROM runs r WHERE r.player_id = ? AND r.end_time IS NOT NULL AND r.flagged = 0`).all(req.player.id);
    let best = null;
    for (const r of runs) {
      const s = rankedSeconds(r);
      if (!best || r.houses > best.houses || (r.houses === best.houses && s < best.seconds)) best = { houses: r.houses, seconds: s, mode: r.mode };
    }
    const open = q.openRuns.get(req.player.id);
    res.json({
      id: req.player.id,
      name: req.player.name,
      stats: {
        runs: runs.length,
        candy: runs.reduce((a, r) => a + r.houses, 0),
        ghosts: runs.reduce((a, r) => a + r.ghosts, 0),
        meters: Math.round(runs.reduce((a, r) => a + r.distance, 0)),
        best,
      },
      activeRun: open ? { runId: open.id, mode: open.mode, startTime: open.start_time } : null,
      houses: db.prepare("SELECT id, name, lat, lng, full_size AS fullSize FROM houses WHERE owner_id = ? AND hidden = 0").all(req.player.id)
        .map((h) => ({ ...h, fullSize: !!h.fullSize })),
    });
  });

  // ---------- Map data ----------
  function readLatLng(query) {
    if (query.lat === undefined && query.lng === undefined) return null;
    const lat = Number(query.lat), lng = Number(query.lng);
    return isLat(lat) && isLng(lng) && query.lat !== "" && query.lng !== "" ? { lat, lng } : false;
  }

  // Candy houses around a point (the demo neighbourhood if no point is given)
  app.get("/neighbourhood", (req, res) => {
    const pos = readLatLng(req.query);
    if (pos === false) return res.status(400).json({ error: "lat and lng must be numbers" });
    const center = pos || DEFAULT_CENTER;
    const st = streets.lookup(center.lat, center.lng);
    const viewer = currentPlayer(req);
    res.json({
      center,
      isDefault: !pos,
      streets: st.status,
      houses: neighbourhood(db, center.lat, center.lng, st.status === "ready" ? st.data : null, viewer?.id)
        .map(({ ref, ...h }) => ({ ...h, id: ref })),
    });
  });

  // Street graph for the Pac-Man maze: 200 ready, 202 still fetching, 503 unavailable
  app.get("/streets", (req, res) => {
    const pos = readLatLng(req.query);
    if (!pos) return res.status(400).json({ error: "lat and lng are required" });
    const st = streets.lookup(pos.lat, pos.lng);
    if (st.status === "ready") {
      res.set("Cache-Control", "public, max-age=3600").type("json").send(st.json);
    } else if (st.status === "pending") {
      res.status(202).json({ status: "pending" });
    } else {
      res.status(503).json({ status: "failed", error: "street map unavailable right now" });
    }
  });

  // ---------- Volunteer houses ----------
  app.get("/houses", (req, res) => {
    const viewer = currentPlayer(req);
    const pos = readLatLng(req.query);
    if (pos === false) return res.status(400).json({ error: "lat, lng and radius must all be numbers" });
    if (!pos) {
      const list = db.prepare("SELECT * FROM houses WHERE hidden = 0 ORDER BY id DESC LIMIT 200").all();
      return res.json(list.map((h) => publicHouse({ ...h, claims: q.claims.get(h.id).n }, viewer?.id)));
    }
    const radius = req.query.radius === undefined ? 500 : Number(req.query.radius);
    if (!Number.isFinite(radius) || radius < 0 || radius > 10000)
      return res.status(400).json({ error: "radius must be between 0 and 10000 meters" });
    res.json(realHousesNear(db, pos.lat, pos.lng, radius).map((h) => ({ ...publicHouse(h, viewer?.id), distance: Math.round(h.distance) })));
  });

  app.post("/houses", requireAuth, (req, res) => {
    const { name, lat, lng, fullSize } = req.body || {};
    const clean = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
    if (clean.length < 2 || clean.length > 40) return res.status(400).json({ error: "name must be 2-40 characters" });
    if (!isLat(lat) || !isLng(lng)) return res.status(400).json({ error: "lat and lng are required" });
    if (q.ownedHouses.get(req.player.id).n >= MAX_HOUSES_PER_PLAYER)
      return res.status(400).json({ error: `you can host up to ${MAX_HOUSES_PER_PLAYER} houses` });
    if (realHousesNear(db, lat, lng, HOUSE_MIN_GAP).length)
      return res.status(409).json({ error: "there's already a candy house right here" });
    const r = q.insertHouse.run(clean, round(lat), round(lng), fullSize ? 1 : 0, req.player.id, now());
    const house = q.house.get(Number(r.lastInsertRowid));
    res.status(201).json(publicHouse({ ...house, claims: 0 }, req.player.id));
  });

  app.delete("/houses/:id", requireAuth, (req, res) => {
    const house = q.house.get(Number(req.params.id));
    if (!house || house.hidden) return res.status(404).json({ error: "house not found" });
    if (house.owner_id !== req.player.id) return res.status(403).json({ error: "only the host can remove this house" });
    q.deleteHouse.run(house.id);
    res.json({ deleted: house.id });
  });

  // "No candy here": hidden once enough different players say so (and they outnumber the claims)
  app.post("/houses/:id/report", requireAuth, (req, res) => {
    const house = q.house.get(Number(req.params.id));
    if (!house || house.hidden) return res.status(404).json({ error: "house not found" });
    if (house.owner_id === req.player.id) return res.status(400).json({ error: "you can't report your own house" });
    const pos = readPosition(req, res);
    if (!pos) return;
    if (distanceMeters(pos.lat, pos.lng, house.lat, house.lng) > REPORT_RADIUS)
      return res.status(400).json({ error: "walk up to the house before reporting it" });
    q.report.run(house.id, req.player.id, now());
    const reports = q.reportCount.get(house.id).n;
    const claims = q.claims.get(house.id).n;
    const hidden = reports >= REPORTS_TO_HIDE && reports > claims;
    if (hidden) q.hideHouse.run(house.id);
    res.json({ reports, hidden });
  });

  // ---------- Runs ----------
  app.post("/runs/start", requireAuth, async (req, res) => {
    const mode = req.body?.mode ?? "arcade";
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
    const pos = readPosition(req, res);
    if (!pos) return;
    const st = await streets.wait(pos.lat, pos.lng, 4000);
    const houses = neighbourhood(db, pos.lat, pos.lng, st.status === "ready" ? st.data : null, req.player.id);
    const runId = tx(db, () => {
      closeStaleRuns(req.player.id, false); // one run at a time
      const r = q.insertRun.run(req.player.id, mode, pos.lat, pos.lng, now());
      const id = Number(r.lastInsertRowid);
      houses.forEach((h, i) => q.insertRunHouse.run(id, i + 1, h.ref, h.name, h.lat, h.lng, h.fullSize ? 1 : 0));
      return id;
    });
    const run = q.run.get(runId);
    trackMove(run, pos.lat, pos.lng);
    res.json({ ...runState(run), streets: st.status });
  });

  app.get("/runs/:id", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (run) res.json({ ...runState(run), seconds: runSeconds(run) });
  });

  // Position updates while playing, so the server can check speed between claims
  app.post("/runs/:id/ping", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.end_time) return res.status(400).json({ error: "run already finished" });
    const pos = readPosition(req, res);
    if (!pos) return;
    const move = trackMove(run, pos.lat, pos.lng);
    res.json(moveStatus(run, move));
  });

  // Claim a house's candy (player must be within VISIT_RADIUS_METERS)
  app.post("/runs/:id/visit", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.end_time) return res.status(400).json({ error: "run already finished" });
    const pos = readPosition(req, res);
    if (!pos) return;
    const house = q.runHouse.get(run.id, Number(req.body.houseId));
    if (!house) return res.status(404).json({ error: "house not found" });
    const move = trackMove(run, pos.lat, pos.lng);
    const status = moveStatus(run, move);
    if (status.cooldown > 0)
      return res.status(429).json({ error: `whoa, too fast! Candy claims pause for ${status.cooldown}s`, ...status });
    const dist = Math.round(distanceMeters(pos.lat, pos.lng, house.lat, house.lng));
    if (dist > VISIT_RADIUS_METERS)
      return res.status(400).json({ error: "too far from house", distanceMeters: dist });
    let power = false;
    if (house.visited_at == null) {
      q.markVisited.run(now(), run.id, house.idx);
      if (house.full_size) {
        updateRun(run.id, { power_at: now(), power_ghosts: 0 });
        power = true;
      }
    }
    const visited = q.visitedCount.get(run.id).n;
    const total = q.totalCount.get(run.id).n;
    res.json({ visited, remaining: total - visited, total, power, ...status });
  });

  // Ghost encounters: caught = time penalty, eaten during a power-up = time bonus
  app.post("/runs/:id/event", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.end_time) return res.status(400).json({ error: "run already finished" });
    if (!eventLimit(run.id)) return res.status(429).json({ error: "slow down" });
    const type = req.body?.type;
    if (type === "spooked") {
      updateRun(run.id, { penalty: run.penalty + SPOOK_PENALTY, spooks: run.spooks + 1 });
      return res.json({ penalty: run.penalty + SPOOK_PENALTY, bonus: run.bonus });
    }
    if (type === "ghost") {
      const window = LIMITS[run.mode].powerWindow * 1000;
      if (!run.power_at || now() - run.power_at > window || run.power_ghosts >= GHOSTS_PER_POWER)
        return res.status(400).json({ error: "no power-up active" });
      updateRun(run.id, { bonus: run.bonus + GHOST_BONUS, ghosts: run.ghosts + 1, power_ghosts: run.power_ghosts + 1 });
      return res.json({ penalty: run.penalty, bonus: run.bonus + GHOST_BONUS });
    }
    res.status(400).json({ error: "type must be spooked or ghost" });
  });

  app.post("/runs/:id/finish", requireAuth, (req, res) => {
    const run = ownRun(req, res);
    if (!run) return;
    if (run.end_time) return res.status(400).json({ error: "run already finished" });
    run.end_time = now();
    q.finishRun.run(run.end_time, run.id);
    const houses = q.visitedCount.get(run.id).n;
    res.json({
      houses,
      total: q.totalCount.get(run.id).n,
      seconds: rankedSeconds(run),
      rawSeconds: runSeconds(run),
      penalty: run.penalty,
      bonus: run.bonus,
      ghosts: run.ghosts,
      spooks: run.spooks,
      meters: Math.round(run.distance),
      mode: run.mode,
      flagged: !!run.flagged,
      strikes: run.strikes,
    });
  });

  // ---------- Leaderboard ----------
  // Each player's best finished run near you: most candy, then fastest time
  app.get("/leaderboard", (req, res) => {
    const scope = req.query.scope || "world";
    const mode = req.query.mode || "gps";
    if (!(scope in SCOPES)) return res.status(400).json({ error: `scope must be one of: ${Object.keys(SCOPES).join(", ")}` });
    if (!MODES.includes(mode)) return res.status(400).json({ error: `mode must be one of: ${MODES.join(", ")}` });
    const pos = readLatLng(req.query);
    if (pos === false || (!pos && scope !== "world"))
      return res.status(400).json({ error: "lat and lng are required for a local leaderboard" });
    const radius = SCOPES[scope];
    let where = "r.end_time IS NOT NULL AND r.flagged = 0 AND r.mode = ?";
    const args = [mode];
    if (pos && Number.isFinite(radius)) {
      const dLat = radius / 111320, dLng = radius / (111320 * Math.cos(toRad(pos.lat)));
      where += " AND r.start_lat BETWEEN ? AND ? AND r.start_lng BETWEEN ? AND ?";
      args.push(pos.lat - dLat, pos.lat + dLat, pos.lng - dLng, pos.lng + dLng);
    }
    const rows = db.prepare(`
      SELECT r.*, p.name,
        (SELECT COUNT(*) FROM run_houses WHERE run_id = r.id AND visited_at IS NOT NULL) AS houses,
        (SELECT COUNT(*) FROM run_houses WHERE run_id = r.id) AS total
      FROM runs r JOIN players p ON p.id = r.player_id WHERE ${where}`).all(...args)
      .filter((r) => r.houses > 0 && (!pos || !Number.isFinite(radius) || distanceMeters(pos.lat, pos.lng, r.start_lat, r.start_lng) <= radius));

    const best = new Map();
    for (const r of rows) {
      const entry = { player: r.name, playerId: r.player_id, houses: r.houses, total: r.total, seconds: rankedSeconds(r), ghosts: r.ghosts, runId: r.id, endTime: r.end_time };
      const cur = best.get(r.player_id);
      if (!cur || entry.houses > cur.houses || (entry.houses === cur.houses && entry.seconds < cur.seconds)) best.set(r.player_id, entry);
    }
    const ranked = [...best.values()]
      .sort((a, b) => b.houses - a.houses || a.seconds - b.seconds || a.endTime - b.endTime)
      .map((e, i) => ({ rank: i + 1, ...e }));
    const viewer = currentPlayer(req);
    const strip = ({ playerId, endTime, ...e }) => ({ ...e, me: viewer ? playerId === viewer.id : false });
    const mine = viewer ? ranked.find((e) => e.playerId === viewer.id) : null;
    res.json({ scope, mode, count: ranked.length, rows: ranked.slice(0, 20).map(strip), me: mine ? strip(mine) : null });
  });

  // ---------- Route ----------
  app.get("/route", (req, res) => {
    const pos = readLatLng(req.query);
    if (!pos) return res.status(400).json({ error: "lat and lng are required" });
    let stops;
    const run = req.query.runId ? q.run.get(Number(req.query.runId)) : null;
    if (req.query.runId && !run) return res.status(404).json({ error: "run not found" });
    if (run) {
      stops = q.runHouses.all(run.id).filter((h) => h.visited_at == null)
        .map((h) => ({ id: h.idx, name: h.name, lat: h.lat, lng: h.lng }));
    } else {
      const st = streets.lookup(pos.lat, pos.lng);
      stops = neighbourhood(db, pos.lat, pos.lng, st.status === "ready" ? st.data : null)
        .map((h, i) => ({ id: i + 1, name: h.name, lat: h.lat, lng: h.lng }));
    }
    res.json(planRoute(pos, stops));
  });

  // ---------- Chat ----------
  app.get("/chat", (req, res) => {
    const pos = readLatLng(req.query);
    if (pos === false) return res.status(400).json({ error: "lat and lng must be numbers" });
    let rows;
    if (pos) {
      const dLat = CHAT_RADIUS / 111320, dLng = CHAT_RADIUS / (111320 * Math.cos(toRad(pos.lat)));
      rows = db.prepare(`SELECT * FROM messages WHERE lat BETWEEN ? AND ? AND lng BETWEEN ? AND ? ORDER BY id DESC LIMIT 50`)
        .all(pos.lat - dLat, pos.lat + dLat, pos.lng - dLng, pos.lng + dLng);
    } else {
      rows = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 50").all();
    }
    res.json(rows.reverse().map((m) => ({ id: m.id, player: m.player, text: m.text, time: m.time })));
  });

  app.post("/chat", requireAuth, (req, res) => {
    const { text, lat, lng } = req.body || {};
    if (typeof text !== "string" || text.trim() === "") return res.status(400).json({ error: "text is required" });
    if (!chatLimit(req.player.id)) return res.status(429).json({ error: "you're typing faster than a ghost, slow down" });
    const hasPos = isLat(lat) && isLng(lng);
    const msg = { player: req.player.name, text: text.trim().slice(0, 300), time: now() };
    const r = q.insertMsg.run(req.player.id, msg.player, msg.text, hasPos ? lat : null, hasPos ? lng : null, msg.time);
    res.json({ id: Number(r.lastInsertRowid), ...msg });
  });

  // Unknown routes
  app.use((req, res) => res.status(404).json({ error: "not found" }));

  // Bad JSON bodies etc.
  app.use((err, req, res, next) => {
    const status = err.status || err.statusCode || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? "server error" : err.message });
  });

  return app;
}

module.exports = { createApp, DEFAULT_CENTER, VISIT_RADIUS_METERS, SPOOK_PENALTY, GHOST_BONUS };
