// API tests: an in-memory database, no network, and a clock the tests control.
// Run with: npm test

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const { openDb } = require("../src/db");
const { createStreetService, loadBaked, compact } = require("../src/osm");
const { createApp, DEFAULT_CENTER } = require("../src/app");
const { offset, distanceMeters } = require("../src/geo");
const { planRoute } = require("../src/route");

let server, base, botServer, botBase, clock = 1_800_000_000_000;
const now = () => clock;
const tick = (seconds) => { clock += seconds * 1000; };

before(async () => {
  const db = openDb(":memory:");
  const streets = createStreetService(db, { baked: loadBaked(path.join(__dirname, "..", "osm")), enabled: false });
  // the core tests run without the display-only demo players
  server = createApp({ db, streets, now, bots: false }).listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://localhost:${server.address().port}`;

  const botDb = openDb(":memory:");
  const botStreets = createStreetService(botDb, { baked: loadBaked(path.join(__dirname, "..", "osm")), enabled: false });
  botServer = createApp({ db: botDb, streets: botStreets, now, botReplyDelay: [20, 30], demoAccount: { name: "Demo", pin: "1234" } }).listen(0);
  await new Promise((r) => botServer.once("listening", r));
  botBase = `http://localhost:${botServer.address().port}`;
});
after(() => { server.close(); botServer.close(); });

async function call(method, url, { body, token, on = base } = {}) {
  const headers = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(on + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}
const get = (url, opts) => call("GET", url, opts);
const post = (url, body, token) => call("POST", url, { body, token });

let n = 0;
async function signUp(name = `player${++n}`) {
  const r = await post("/players", { name, pin: "1234" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token;
}

// Walk from the current spot to a house in small, legal steps
async function walkTo(runId, token, from, to, speed) {
  const total = distanceMeters(from.lat, from.lng, to.lat, to.lng);
  const steps = Math.max(1, Math.ceil(total / (speed * 2)));
  for (let i = 1; i <= steps; i++) {
    tick(2);
    const p = { lat: from.lat + ((to.lat - from.lat) * i) / steps, lng: from.lng + ((to.lng - from.lng) * i) / steps };
    const r = await post(`/runs/${runId}/ping`, p, token);
    assert.equal(r.body.ok, true, `step ${i} rejected`);
  }
  return to;
}

test("accounts: a name is claimed with a PIN and protected afterwards", async () => {
  const first = await post("/players", { name: "Milo Moon", pin: "4321" });
  assert.equal(first.status, 200);
  assert.equal(first.body.created, true);
  assert.match(first.body.token, /^[a-f0-9]{64}$/);

  const again = await post("/players", { name: "milo moon", pin: "4321" });
  assert.equal(again.body.created, false);
  assert.equal(again.body.player.name, "Milo Moon");

  const wrong = await post("/players", { name: "Milo Moon", pin: "0000" });
  assert.equal(wrong.status, 401);

  // five wrong PINs lock the name, even for the right PIN
  for (let i = 0; i < 4; i++) await post("/players", { name: "Milo Moon", pin: "0000" });
  assert.equal((await post("/players", { name: "Milo Moon", pin: "4321" })).status, 429);
  tick(11 * 60);
  assert.equal((await post("/players", { name: "Milo Moon", pin: "4321" })).status, 200);

  assert.equal((await post("/players", { name: "x", pin: "1234" })).status, 400);
  assert.equal((await post("/players", { name: "Okay Name", pin: "12" })).status, 400);

  const me = await get("/players/me", { token: first.body.token });
  assert.equal(me.body.name, "Milo Moon");
  assert.equal((await get("/players/me")).status, 401);
});

test("neighbourhood: demo houses sit on the default map and include power-ups", async () => {
  const r = await get("/neighbourhood");
  assert.equal(r.status, 200);
  assert.equal(r.body.isDefault, true);
  assert.equal(r.body.streets, "ready");
  assert.equal(r.body.houses.length, 12);
  assert.ok(r.body.houses.some((h) => h.fullSize));
  // the same spot always gives the same houses
  const again = await get(`/neighbourhood?lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`);
  assert.deepEqual(again.body.houses.map((h) => h.name), r.body.houses.map((h) => h.name));
});

test("a full arcade run: claims, power-up ghost bonus, spook penalty, leaderboard", async () => {
  const token = await signUp("Arcade Ace");
  const start = await post("/runs/start", { mode: "arcade", ...DEFAULT_CENTER }, token);
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const { runId, houses } = start.body;
  assert.equal(houses.length, 12);

  // too far away
  const far = await post(`/runs/${runId}/visit`, { houseId: houses[0].id, ...DEFAULT_CENTER }, token);
  if (distanceMeters(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, houses[0].lat, houses[0].lng) > 25) {
    assert.equal(far.status, 400);
    assert.equal(far.body.error, "too far from house");
  }

  // no ghost bonus without a power-up
  assert.equal((await post(`/runs/${runId}/event`, { type: "ghost" }, token)).status, 400);

  let pos = { ...DEFAULT_CENTER };
  const power = houses.find((h) => h.fullSize);
  for (const h of [power, houses.find((x) => !x.fullSize)]) {
    pos = await walkTo(runId, token, pos, h, 20);
    const v = await post(`/runs/${runId}/visit`, { houseId: h.id, ...pos }, token);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    if (h === power) {
      assert.equal(v.body.power, true);
      // eat a ghost while powered up
      const e = await post(`/runs/${runId}/event`, { type: "ghost" }, token);
      assert.equal(e.status, 200);
      assert.equal(e.body.bonus, 5);
    }
  }
  const spook = await post(`/runs/${runId}/event`, { type: "spooked" }, token);
  assert.equal(spook.body.penalty, 10);

  // re-claiming doesn't count twice
  const twice = await post(`/runs/${runId}/visit`, { houseId: houses.find((x) => !x.fullSize).id, ...pos }, token);
  assert.equal(twice.body.visited, 2);

  const fin = await post(`/runs/${runId}/finish`, {}, token);
  assert.equal(fin.status, 200);
  assert.equal(fin.body.houses, 2);
  assert.equal(fin.body.seconds, fin.body.rawSeconds + 10 - 5);
  assert.equal(fin.body.flagged, false);
  assert.ok(fin.body.meters > 0);
  assert.equal((await post(`/runs/${runId}/finish`, {}, token)).status, 400);

  const board = await get(`/leaderboard?scope=street&mode=arcade&lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`, { token });
  assert.equal(board.status, 200);
  assert.equal(board.body.rows[0].player, "Arcade Ace");
  assert.equal(board.body.rows[0].me, true);
  assert.equal(board.body.me.rank, 1);
  // ranked GPS board is separate
  const gps = await get(`/leaderboard?scope=street&mode=gps&lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`);
  assert.equal(gps.body.rows.length, 0);
  // a street leaderboard on the other side of town doesn't include it
  const elsewhere = offset(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 5000, 0);
  const away = await get(`/leaderboard?scope=street&mode=arcade&lat=${elsewhere.lat}&lng=${elsewhere.lng}`);
  assert.equal(away.body.rows.length, 0);
});

test("anti-cheat: teleporting strikes, pauses claims and finally flags the run", async () => {
  const token = await signUp("Teleporter");
  const start = await post("/runs/start", { mode: "gps", ...DEFAULT_CENTER }, token);
  const { runId, houses } = start.body;
  const target = houses[0];

  // jump straight onto a house 1 second later
  tick(1);
  const v = await post(`/runs/${runId}/visit`, { houseId: target.id, lat: target.lat, lng: target.lng }, token);
  if (distanceMeters(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, target.lat, target.lng) > 50) {
    assert.equal(v.status, 429);
    assert.equal(v.body.strikes, 1);
    assert.ok(v.body.cooldown > 0);
  }

  // a car-speed trip: 500 m every 5 seconds
  let p = { ...DEFAULT_CENTER };
  let last;
  for (let i = 0; i < 6; i++) {
    tick(5);
    p = offset(p.lat, p.lng, 500, 0);
    last = await post(`/runs/${runId}/ping`, p, token);
  }
  assert.equal(last.body.flagged, true);

  const fin = await post(`/runs/${runId}/finish`, {}, token);
  assert.equal(fin.body.flagged, true);
  const board = await get("/leaderboard?scope=world&mode=gps");
  assert.ok(!board.body.rows.some((r) => r.player === "Teleporter"));
});

test("anti-cheat: an honest walk with GPS wobble is never flagged", async () => {
  const token = await signUp("Honest Walker");
  const { body } = await post("/runs/start", { mode: "gps", ...DEFAULT_CENTER }, token);
  let p = { ...DEFAULT_CENTER };
  for (let i = 0; i < 120; i++) {
    tick(2);
    p = offset(p.lat, p.lng, 2.8, 0); // 1.4 m/s
    const wobble = offset(p.lat, p.lng, ((i * 7) % 11) - 5, ((i * 5) % 9) - 4);
    const r = await post(`/runs/${body.runId}/ping`, wobble, token);
    assert.equal(r.body.ok, true, `ping ${i}`);
  }
  const fin = await post(`/runs/${body.runId}/finish`, {}, token);
  assert.equal(fin.body.strikes, 0);
});

test("runs belong to their player and can be resumed", async () => {
  const a = await signUp();
  const b = await signUp();
  const { body } = await post("/runs/start", { mode: "arcade", ...DEFAULT_CENTER }, a);
  assert.equal((await get(`/runs/${body.runId}`, { token: b })).status, 404);
  const resume = await get(`/runs/${body.runId}`, { token: a });
  assert.equal(resume.status, 200);
  assert.equal(resume.body.houses.length, 12);
  const me = await get("/players/me", { token: a });
  assert.equal(me.body.activeRun.runId, body.runId);

  // starting a new run closes the old one
  const second = await post("/runs/start", { mode: "arcade", ...DEFAULT_CENTER }, a);
  assert.equal((await get(`/runs/${body.runId}`, { token: a })).body.ended, true);
  assert.equal((await get("/players/me", { token: a })).body.activeRun.runId, second.body.runId);
});

test("volunteer houses: hosting, verification by claims, and reports", async () => {
  const host = await signUp("Host");
  const spot = offset(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 2000, 2000);
  const add = await post("/houses", { name: "Maple Street Porch", ...spot, fullSize: true }, host);
  assert.equal(add.status, 201, JSON.stringify(add.body));
  assert.equal(add.body.verified, false);
  assert.equal(add.body.mine, true);
  assert.equal((await post("/houses", { name: "Too Close", ...offset(spot.lat, spot.lng, 5, 0) }, host)).status, 409);
  assert.equal((await post("/houses", { name: "Anonymous", ...spot })).status, 401);

  // three different players collect its candy, so it becomes verified
  for (let i = 0; i < 3; i++) {
    const t = await signUp();
    const startAt = offset(spot.lat, spot.lng, 0, 10);
    const run = await post("/runs/start", { mode: "gps", ...startAt }, t);
    const real = run.body.houses.find((h) => h.ref === add.body.id);
    assert.ok(real, "volunteer house is part of the run");
    tick(5);
    const v = await post(`/runs/${run.body.runId}/visit`, { houseId: real.id, ...offset(spot.lat, spot.lng, 0, 5) }, t);
    assert.equal(v.status, 200, JSON.stringify(v.body));
    await post(`/runs/${run.body.runId}/finish`, {}, t);
  }
  const list = await get(`/houses?lat=${spot.lat}&lng=${spot.lng}&radius=100`);
  assert.equal(list.body[0].verified, true);
  assert.equal(list.body[0].claims, 3);

  // reports need you to be there, and can't outvote three real claims with three reports
  const r1 = await signUp();
  assert.equal((await post(`/houses/${add.body.id}/report`, DEFAULT_CENTER, r1)).status, 400);
  for (let i = 0; i < 3; i++) {
    const t = i === 0 ? r1 : await signUp();
    const r = await post(`/houses/${add.body.id}/report`, spot, t);
    assert.equal(r.status, 200);
    assert.equal(r.body.hidden, false);
  }
  const t4 = await signUp();
  assert.equal((await post(`/houses/${add.body.id}/report`, spot, t4)).body.hidden, true);
  assert.equal((await get(`/houses?lat=${spot.lat}&lng=${spot.lng}&radius=100`)).body.length, 0);
});

test("route: 2-opt never does worse than nearest-neighbour and visits every stop", () => {
  const start = { lat: 43.47, lng: -80.54 };
  const stops = [];
  for (let i = 0; i < 12; i++) stops.push({ id: i, ...offset(start.lat, start.lng, Math.sin(i * 2.3) * 300, Math.cos(i * 1.7) * 300) });
  const r = planRoute(start, stops);
  assert.equal(r.stops.length, 12);
  assert.deepEqual(new Set(r.stops.map((s) => s.id)).size, 12);
  // nearest-neighbour baseline
  let at = start, left = [...stops], nn = 0;
  while (left.length) {
    left.sort((a, b) => distanceMeters(at.lat, at.lng, a.lat, a.lng) - distanceMeters(at.lat, at.lng, b.lat, b.lng));
    nn += distanceMeters(at.lat, at.lng, left[0].lat, left[0].lng);
    at = left.shift();
  }
  assert.ok(r.totalMeters <= Math.round(nn) + 1, `${r.totalMeters} > ${nn}`);
});

test("street maps compact to one connected graph", () => {
  // two roads joined at a corner plus an unconnected island road
  const way = (id, nodes, highway = "residential") => ({
    type: "way", id, tags: { highway }, nodes: nodes.map((n) => n[0]), geometry: nodes.map((n) => ({ lat: n[1], lon: n[2] })),
  });
  const json = { elements: [
    way(1, [[1, 43.0, -80.0], [2, 43.0005, -80.0], [3, 43.001, -80.0]]),
    way(2, [[3, 43.001, -80.0], [4, 43.001, -79.999]]),
    way(3, [[8, 43.01, -80.01], [9, 43.011, -80.01]]),
    way(4, [[10, 43.0, -80.0], [11, 43.0, -79.99]], "motorway"),
    { type: "way", id: 5, tags: { building: "house" }, center: { lat: 43.0004, lon: -80.0001 } },
  ] };
  const g = compact(json, 43.0, -80.0);
  assert.equal(g.nodes.length, 3, "straight middle point dropped, island and motorway removed");
  assert.equal(g.edges.length, 2);
  assert.equal(g.buildings.length, 1);
});

test("chat is local and needs an account to post", async () => {
  const token = await signUp("Chatty");
  assert.equal((await post("/chat", { text: "hi" })).status, 401);
  const m = await post("/chat", { text: "  Vampire Villa has full-size bars!  ", ...DEFAULT_CENTER }, token);
  assert.equal(m.body.text, "Vampire Villa has full-size bars!");
  assert.equal(m.body.player, "Chatty");
  const near = await get(`/chat?lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`);
  assert.ok(near.body.some((x) => x.id === m.body.id));
  const far = offset(DEFAULT_CENTER.lat, DEFAULT_CENTER.lng, 50000, 0);
  assert.ok(!(await get(`/chat?lat=${far.lat}&lng=${far.lng}`)).body.some((x) => x.id === m.body.id));
});

// ---------- Display-only demo players ----------
const onBots = (method, url, opts = {}) => call(method, url, { ...opts, on: botBase });

test("demo account: the README PIN works and shared sign-ins don't end each other's runs", async () => {
  const a = await onBots("POST", "/players", { body: { name: "Demo", pin: "1234" } });
  assert.equal(a.status, 200);
  assert.equal(a.body.created, false, "created at startup");
  const b = await onBots("POST", "/players", { body: { name: "demo", pin: "1234" } });
  const runA = await onBots("POST", "/runs/start", { body: { mode: "arcade", ...DEFAULT_CENTER }, token: a.body.token });
  const runB = await onBots("POST", "/runs/start", { body: { mode: "arcade", ...DEFAULT_CENTER }, token: b.body.token });
  assert.equal((await onBots("GET", `/runs/${runA.body.runId}`, { token: a.body.token })).body.ended, false);
  assert.equal((await onBots("GET", "/players/me", { token: a.body.token })).body.activeRun.runId, runA.body.runId);
  assert.equal((await onBots("GET", "/players/me", { token: b.body.token })).body.activeRun.runId, runB.body.runId);
  // wrong guesses never lock the public demo account
  for (let i = 0; i < 6; i++) await onBots("POST", "/players", { body: { name: "Demo", pin: "9999" } });
  assert.equal((await onBots("POST", "/players", { body: { name: "Demo", pin: "1234" } })).status, 200);
});

test("walk mode: ghosts are harmless, so ghost events are refused", async () => {
  const t = (await onBots("POST", "/players", { body: { name: "Walky", pin: "1234" } })).body.token;
  const run = await onBots("POST", "/runs/start", { body: { mode: "gps", ...DEFAULT_CENTER }, token: t });
  const r = await onBots("POST", `/runs/${run.body.runId}/event`, { body: { type: "spooked" }, token: t });
  assert.equal(r.status, 400);
  const fin = await onBots("POST", `/runs/${run.body.runId}/finish`, { body: {}, token: t });
  assert.equal(fin.body.penalty, 0);
});

test("demo players fill the leaderboard, ranked alongside real players", async () => {
  const q = `scope=street&mode=arcade&lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`;
  const board = (await onBots("GET", `/leaderboard?${q}`)).body;
  assert.equal(board.bots, 4);
  assert.ok(board.rows.every((r, i) => r.rank === i + 1));
  assert.ok(board.rows.every((r) => r.bot && r.houses >= 1 && r.houses <= 12 && r.seconds > 0));
  // stable for the day
  assert.deepEqual((await onBots("GET", `/leaderboard?${q}`)).body.rows, board.rows);
  // a real full clear in 1:00 beats every demo player
  const t = (await onBots("POST", "/players", { body: { name: "Speedy", pin: "1234" } })).body.token;
  const run = await onBots("POST", "/runs/start", { body: { mode: "arcade", ...DEFAULT_CENTER }, token: t });
  let pos = { ...DEFAULT_CENTER };
  for (const h of run.body.houses) {
    const d = distanceMeters(pos.lat, pos.lng, h.lat, h.lng);
    tick(Math.max(1, d / 20));
    pos = { lat: h.lat, lng: h.lng };
    const v = await onBots("POST", `/runs/${run.body.runId}/visit`, { body: { houseId: h.id, ...pos }, token: t });
    assert.equal(v.status, 200, JSON.stringify(v.body));
  }
  await onBots("POST", `/runs/${run.body.runId}/finish`, { body: {}, token: t });
  const after = (await onBots("GET", `/leaderboard?${q}`, { token: t })).body;
  assert.equal(after.rows[0].player, "Speedy");
  assert.equal(after.rows[0].bot, false);
  assert.equal(after.me.rank, 1);
});

test("chat: demo players chat in the background and reply to you", async () => {
  const at = `lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`;
  const before = (await onBots("GET", `/chat?${at}`)).body;
  assert.ok(before.length > 0 && before.every((m) => m.bot));
  const t = (await onBots("POST", "/players", { body: { name: "Chatter", pin: "1234" } })).body.token;
  await onBots("POST", "/chat", { body: { text: "hi! which house has the best candy?", ...DEFAULT_CENTER }, token: t });
  await new Promise((r) => setTimeout(r, 120));
  const list = (await onBots("GET", `/chat?${at}`)).body;
  const mine = list.findIndex((m) => m.player === "Chatter");
  assert.ok(mine >= 0);
  assert.ok(list.slice(mine + 1).some((m) => m.bot), "a demo player answered");
});

test("activity: who's playing and a feed of what just happened", async () => {
  const a = (await onBots("GET", `/activity?lat=${DEFAULT_CENTER.lat}&lng=${DEFAULT_CENTER.lng}`)).body;
  assert.ok(a.players.length >= 3 && a.players.every((p) => p.name && p.color));
  assert.ok(a.playing >= a.players.length);
  assert.ok(a.feed.some((f) => f.text.startsWith("Speedy finished with 12")), "real finishes show up too");
  assert.ok(a.feed.every((f, i) => i === 0 || a.feed[i - 1].time >= f.time));
});
