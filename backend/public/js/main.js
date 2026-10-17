// Pack_Ween: the game page.
//
// Flow: locate the player -> load the neighbourhood (candy houses) and its street
// map -> sign in -> start a run on the server -> game loop (move, ghosts, claims,
// pings) -> finish -> results and leaderboard.

import { api, hasToken, setToken, store } from "./api.js";
import { projector, distance, bearingXY } from "./geo.js";
import { StreetGraph, Walker } from "./streets.js";
import { Ghosts } from "./ghosts.js";
import { Rivals } from "./rivals.js";
import { planRoute, sampleDots } from "./route.js";
import { sfx, isMuted, setMuted } from "./sound.js";
import { $, el, toast, fmtTime, fmtDist, openModal, confirmModal, floatText, vibrate, reducedMotion } from "./ui.js";

// ---------- Settings ----------
const RADIUS = 25;            // claim distance, must match VISIT_RADIUS_METERS on the server
const CLAIM_AT = 23;          // claim slightly inside it so rounding never gets a claim rejected
const ARCADE_SPEED = 22;      // m/s, must match ARCADE_SPEED in anticheat.js
const PING_EVERY = 2000;
const COS_TURN = Math.cos((55 * Math.PI) / 180);
const COS_STRAIGHT = Math.cos((50 * Math.PI) / 180);
const MODE_KEY = "packween.mode";
const DIRS = { up: [0, 1], down: [0, -1], left: [-1, 0], right: [1, 0] };
const KEYS = { ArrowUp: "up", w: "up", W: "up", ArrowDown: "down", s: "down", S: "down", ArrowLeft: "left", a: "left", A: "left", ArrowRight: "right", d: "right", D: "right" };

const GAME = {
  arcade: { ghosts: 4, catchRadius: 9, speeds: { chase: 16.5, fright: 10, eaten: 45 }, fright: 8, invuln: 3, ghostHome: 150 },
  // Walking: nothing can really catch you outside, so the ghosts just drift around for atmosphere
  gps: { ghosts: 3, catchRadius: 12, speeds: { chase: 1.3, fright: 1.8, eaten: 6 }, fright: 30, invuln: 8, ghostHome: 120, harmless: true },
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- State ----------
const S = {
  profile: null,
  mode: store.get(MODE_KEY) === "gps" ? "gps" : "arcade",
  located: null,        // the browser's location, if allowed
  center: null,         // centre of the loaded neighbourhood
  isDefault: false,
  proj: null,
  streets: null,        // street map data from the server
  streetsStatus: "loading",
  streetsKey: null,
  graph: null,
  houses: [],
  run: null,
  playing: false,
  finishing: false,
  pac: null,
  pacMarker: null,
  ghosts: null,
  clock: 0,
  invulnUntil: 0,
  userPannedAt: 0,
  routeOn: false,
  dots: [],
  gpsWatch: null,
  gpsRaw: null,
  accuracyCircle: null,
  wakeLock: null,
  timers: [],
  lastPing: null,
  chatSeen: 0,
  chatOpen: false,
  previewGraph: null,   // street graph for the map behind the start screen
  activity: null,
  feedSeen: 0,
};

const toXY = (lat, lng) => S.proj.toXY(lat, lng);
const toLatLng = (x, y) => S.proj.toLatLng(x, y);

// ---------- Map ----------
const map = L.map("map", { zoomControl: false, zoomSnap: 0.5 }).setView([43.4723, -80.5449], 16);
// Street tiles from Esri (no API key); if they keep failing, switch to the OSM France backup
const streetTiles = L.tileLayer("https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}", {
  maxZoom: 19, maxNativeZoom: 18, attribution: "Tiles &copy; Esri &middot; Map data &copy; OpenStreetMap contributors",
}).addTo(map);
let tileErrors = 0;
streetTiles.on("tileerror", () => {
  if (++tileErrors !== 4) return;
  map.removeLayer(streetTiles);
  L.tileLayer("https://{s}.tile.openstreetmap.fr/hot/{z}/{x}/{y}.png", {
    maxZoom: 19, attribution: "&copy; OpenStreetMap contributors, tiles OSM France",
  }).addTo(map).bringToBack();
});
const decorLayer = L.layerGroup().addTo(map);
const routeLayer = L.layerGroup().addTo(map);
const houseLayer = L.layerGroup().addTo(map);
const ghostLayer = L.layerGroup().addTo(map);
const rivalLayer = L.layerGroup().addTo(map);
const dotRenderer = L.canvas({ padding: 0.3 });
const rivals = new Rivals({
  layer: rivalLayer,
  toLatLng,
  onArrive: (r, latlng) => { if (map.getBounds().contains(latlng)) floatText(map, latlng, "+1 🍬", "rival"); },
});
map.on("dragstart", () => { if (S.playing) S.userPannedAt = Date.now(); });

const decorIcon = L.divIcon({ className: "", html: '<div class="decor">🏠</div>', iconSize: [18, 18], iconAnchor: [9, 9] });
const pacIcon = L.divIcon({
  className: "pac-icon",
  html: '<div class="pac idle"><div class="pac-glow"></div><div class="body"></div><div class="eye"></div><div class="stem"></div></div>',
  iconSize: [32, 32],
  iconAnchor: [16, 16],
});

function houseIcon(h) {
  const cls = ["house", h.visited && "done", h.fullSize && "power", h.justClaimed && "claim"].filter(Boolean).join(" ");
  const badge = h.verified ? '<span class="v" title="Verified">✓</span>' : "";
  return L.divIcon({
    className: "",
    html: `<div class="${cls}">${badge}<span>🏠</span><span class="c">${h.fullSize ? "🍫" : "🍬"}</span></div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15],
  });
}

// ---------- Houses ----------
function setHouses(list) {
  houseLayer.clearLayers();
  S.houses = list.map((h) => {
    const [x, y] = toXY(h.lat, h.lng);
    const house = { ...h, x, y, node: -1, visited: !!h.visited };
    L.circle([h.lat, h.lng], { radius: RADIUS, color: "#ff7518", fillColor: "#8b3dff", weight: 2, fillOpacity: 0.15, interactive: false }).addTo(houseLayer);
    house.marker = L.marker([h.lat, h.lng], { icon: houseIcon(house), riseOnHover: true, keyboard: false })
      .addTo(houseLayer)
      .bindTooltip(el("span", {}, house.name), { direction: "top", offset: [0, -14] })
      .on("click", () => openHousePopup(house));
    return house;
  });
  $("total").textContent = S.houses.length;
  $("score").textContent = S.houses.filter((h) => h.visited).length;
  drawDecor();
}

// Real buildings from the street map, drawn as plain houses (no candy)
function drawDecor() {
  decorLayer.clearLayers();
  if (!S.streets || !S.center) return;
  let n = 0;
  for (const [lat, lng] of S.streets.buildings) {
    if (n >= 450) break;
    if (distance(S.center, { lat, lng }) > 550) continue;
    if (S.houses.some((h) => distance(h, { lat, lng }) < 22)) continue;
    L.marker([lat, lng], { icon: decorIcon, interactive: false, keyboard: false }).addTo(decorLayer);
    n++;
  }
}

function openHousePopup(h) {
  const tag = h.demo
    ? el("span", { class: "tag" }, "Demo house")
    : h.verified
      ? el("span", { class: "tag ok" }, `✓ Verified · ${h.claims} visits`)
      : el("span", { class: "tag new" }, `New · ${h.claims || 0}/3 visits to verify`);
  const here = S.pac ? Math.round(Math.hypot(h.x - S.pac.x, h.y - S.pac.y)) : null;
  const content = el("div", { class: "pop" },
    el("h4", {}, h.name),
    tag,
    h.fullSize && el("span", { class: "tag pw" }, "🍫 Full-size bars"),
    h.visited && el("div", { class: "small" }, "✅ You got this candy"),
    here != null && !h.visited && el("div", { class: "muted small" }, `${fmtDist(here)} away`),
    h.demo && el("div", { class: "muted small" }, "Nobody is handing out candy here yet, so these are demo houses. Hand out candy to put a real one on the map!"),
    !h.demo && h.mine && el("button", { onclick: () => removeHouse(h.ref) }, "🗑️ Remove my house"),
    !h.demo && !h.mine && S.profile && el("button", { onclick: () => reportHouse(h) }, "🚩 No candy here"));
  L.popup({ offset: [0, -8], maxWidth: 240 }).setLatLng([h.lat, h.lng]).setContent(content).openOn(map);
}

async function reportHouse(h) {
  const pos = S.playing ? claimLatLng() : S.located;
  if (!pos) return toast("Walk up to the house first (we need your location)", "warn");
  try {
    const r = await api(`/houses/${h.ref}/report`, { body: pos });
    map.closePopup();
    toast(r.hidden ? "Thanks! That house is now hidden." : "Thanks for the report 👻", "good");
  } catch (e) { toast(e.message, "bad"); }
}

async function removeHouse(id) {
  const ok = await confirmModal({ title: "Remove your house?", text: "Trick-or-treaters won't see it on the map any more.", ok: "Remove", danger: true });
  if (!ok) return;
  try {
    await api(`/houses/${id}`, { method: "DELETE" });
    map.closePopup();
    toast("House removed", "good");
    await loadProfile();
    if (!S.playing) await loadNeighbourhood(S.center);
  } catch (e) { toast(e.message, "bad"); }
}

// ---------- Location, neighbourhood and streets ----------
function locate(timeout = 8000) {
  if (!navigator.geolocation) return Promise.resolve(null);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout); // never hang on an ignored permission prompt
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }); },
      () => { clearTimeout(timer); resolve(null); },
      { enableHighAccuracy: true, timeout: timeout - 500, maximumAge: 30000 });
  });
}

async function loadNeighbourhood(pos) {
  const q = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : "";
  const hood = await api(`/neighbourhood${q}`);
  if (S.playing) return hood; // arrived after a run started: never move the map under the game
  const moved = !S.center || distance(S.center, hood.center) > 1;
  S.center = hood.center;
  S.isDefault = hood.isDefault;
  if (moved || !S.proj) {
    S.proj = projector(hood.center.lat, hood.center.lng);
    S.streets = null;
    S.previewGraph = null;
    S.streetsStatus = "loading";
  }
  setHouses(hood.houses.map(({ id, ...h }) => ({ ...h, ref: id })));
  const pts = S.houses.map((h) => [h.lat, h.lng]);
  if (pts.length) map.fitBounds(pts, { padding: [60, 60], maxZoom: 17 });
  refreshRivals();
  if (moved) loadActivity();
  updateStatus();
  if (moved || !S.streets) loadStreets(hood.center);
  return hood;
}

async function loadStreets(center) {
  const key = `${center.lat},${center.lng}`;
  if (S.streetsKey === key && S.streetsStatus !== "failed") return;
  S.streetsKey = key;
  S.streetsStatus = "loading";
  updateStatus();
  const started = Date.now();
  for (;;) {
    if (S.streetsKey !== key) return;
    let r;
    try { r = await api(`/streets?lat=${center.lat}&lng=${center.lng}`, { retries: 1 }); }
    catch (e) { r = { _status: e.status || 0 }; }
    if (S.streetsKey !== key) return;
    if (r._status === 200 && Array.isArray(r.nodes)) {
      S.streets = r;
      S.streetsStatus = r.nodes.length > 1 ? "ready" : "none";
      S.previewGraph = null;
      drawDecor();
      updateStatus();
      if (S.playing && !S.graph && S.streetsStatus === "ready") enterStreets();
      else if (!S.playing) refreshRivals();
      return;
    }
    if (r._status === 202 && Date.now() - started < 120000) {
      S.streetsStatus = "pending";
      updateStatus();
      await sleep(4000);
      continue;
    }
    S.streetsStatus = "failed";
    updateStatus();
    return;
  }
}

async function waitForStreets(ms) {
  const until = Date.now() + ms;
  while ((S.streetsStatus === "loading" || S.streetsStatus === "pending") && Date.now() < until) await sleep(250);
}

function updateStatus() {
  const box = $("hoodStatus");
  if (!S.center) { box.textContent = "📍 Finding your neighbourhood…"; return; }
  const where = S.isDefault ? "Location off: demo neighbourhood in Waterloo" : `${S.houses.length} candy houses near you`;
  const streets = {
    loading: "loading street maze…",
    pending: "fetching your streets from OpenStreetMap…",
    ready: "street maze ready",
    none: "no streets here, free-roam mode",
    failed: "street map unavailable, free-roam mode",
  }[S.streetsStatus];
  box.replaceChildren(`📍 ${where} · `, el("span", { class: S.streetsStatus === "ready" ? "ok" : "" }, `🗺️ ${streets}`));
  if (S.playing) {
    if (S.streetsStatus === "pending" || S.streetsStatus === "loading") banner("🗺️ Loading your street maze… roam freely meanwhile");
    else banner(null);
  }
}

// One-line status under the HUD. A sticky banner (run flagged) stays put.
function banner(text, { bad = false, sticky = false } = {}) {
  const b = $("banner");
  if (b.classList.contains("sticky") && !sticky) return;
  if (!text) { b.hidden = true; return; }
  b.textContent = text;
  b.className = [bad && "bad", sticky && "sticky"].filter(Boolean).join(" ");
  b.hidden = false;
}

// Build the maze and make every candy house reachable from the streets
function buildGraph() {
  const g = new StreetGraph(S.streets, S.proj);
  for (const h of S.houses) h.node = g.attach(h.x, h.y);
  return g;
}

// The street map arrived mid-run: switch Pac-Man and the ghosts onto it
function enterStreets() {
  S.graph = buildGraph();
  if (S.run.mode === "arcade") S.pac.useGraph(S.graph);
  makeGhosts();
  refreshRivals();
  if (S.routeOn) showRoute(true);
  toast("🗺️ Street maze loaded! Now you're running the real streets", "good");
}

// ---------- Accounts ----------
async function loadProfile() {
  if (!hasToken()) { S.profile = null; renderWho(); return; }
  try {
    S.profile = await api("/players/me");
  } catch (e) {
    if (e.status === 401) setToken(null);
    S.profile = null;
  }
  renderWho();
}

function renderWho() {
  const p = S.profile;
  $("signedIn").hidden = !p;
  $("signIn").hidden = !!p;
  if (!p) { $("resumeBox").hidden = true; return; }
  $("meName").textContent = p.name;
  const st = p.stats;
  $("meStats").textContent = st.runs
    ? `${st.runs} run${st.runs === 1 ? "" : "s"} · ${st.candy} 🍬 lifetime · best ${st.best.houses} 🍬 in ${fmtTime(st.best.seconds)}`
    : "No runs yet. Go get some candy!";
  const active = p.activeRun;
  $("resumeBox").hidden = !active || S.playing;
  if (active) {
    const mins = Math.max(1, Math.round((Date.now() - active.startTime) / 60000));
    $("resumeText").textContent = `You have an unfinished ${active.mode === "gps" ? "Walk" : "Arcade"} run from ${mins} min ago.`;
  }
}

async function ensureSignedIn() {
  if (S.profile) return true;
  const name = $("name").value.trim();
  const pin = $("pin").value.trim();
  if (!name) { $("name").focus(); toast("Enter your name and a PIN first", "warn"); return false; }
  if (!/^\d{4,8}$/.test(pin)) { $("pin").focus(); toast("Your PIN is 4 to 8 digits", "warn"); return false; }
  try {
    const r = await api("/players", { body: { name, pin } });
    setToken(r.token);
    await loadProfile();
    toast(r.created ? `🎃 Welcome, ${r.player.name}! Your name is claimed.` : `👋 Welcome back, ${r.player.name}!`, "good");
    return true;
  } catch (e) {
    toast(e.message, "bad");
    return false;
  }
}

// ---------- Pac-Man ----------
class Pac {
  constructor(x, y) {
    this.x = x;
    this.y = y;
    this.hx = 1;
    this.hy = 0;
    this.want = null;
    this.walker = null;
    this.target = null;     // GPS mode: where the latest fix says we are
    this.moving = false;
    this.frozenUntil = 0;
  }

  useGraph(g) {
    this.walker = new Walker(g, g.attach(this.x, this.y)); // a short path onto the street, never a jump
    this.walker.hx = this.hx;
    this.walker.hy = this.hy;
  }

  setWant(dir) {
    this.want = DIRS[dir];
    const w = this.walker;
    if (w && w.moving && this.want[0] * w.hx + this.want[1] * w.hy < -0.7) w.reverse(); // instant U-turn
  }

  // At a node: take the wanted direction if a street goes that way, otherwise
  // keep going straight-ish, follow the road round a bend, or stop at a wall.
  choose(node, came) {
    const g = this.walker.g;
    const adj = g.adj[node];
    if (this.want) {
      let best = null, bestDot = COS_TURN;
      for (const n of adj) {
        const [dx, dy] = g.dir(node, n);
        const d = dx * this.want[0] + dy * this.want[1];
        if (d > bestDot) { bestDot = d; best = n; }
      }
      if (best != null) return best;
    }
    if (came == null) return null;
    const others = adj.filter((n) => n !== came);
    if (others.length === 1 && adj.length === 2) return others[0];
    const [hx, hy] = g.dir(came, node);
    let best = null, bestDot = COS_STRAIGHT;
    for (const n of others) {
      const [dx, dy] = g.dir(node, n);
      const d = dx * hx + dy * hy;
      if (d > bestDot) { bestDot = d; best = n; }
    }
    return best;
  }

  update(dt, clock) {
    if (clock < this.frozenUntil) { this.moving = false; return; }
    if (this.target) {
      // GPS: glide towards the latest fix instead of jumping
      const k = 1 - Math.exp(-dt * 2.5);
      const dx = (this.target[0] - this.x) * k, dy = (this.target[1] - this.y) * k;
      this.x += dx;
      this.y += dy;
      const l = Math.hypot(dx, dy);
      this.moving = l / dt > 0.3;
      if (l > 0.02) { this.hx = dx / l; this.hy = dy / l; }
      return;
    }
    const step = ARCADE_SPEED * dt;
    if (this.walker) {
      this.walker.advance(step, (n, c) => this.choose(n, c));
      this.x = this.walker.x;
      this.y = this.walker.y;
      this.hx = this.walker.hx;
      this.hy = this.walker.hy;
      this.moving = this.walker.moving;
    } else if (this.want) {
      this.x += this.want[0] * step;
      this.y += this.want[1] * step;
      [this.hx, this.hy] = this.want;
      this.moving = true;
    }
  }
}

let pacEl = null, lastTf = "", lastMoving = null;
function drawPac() {
  const p = S.pac;
  S.pacMarker.setLatLng(toLatLng(p.x, p.y));
  pacEl = pacEl || S.pacMarker.getElement()?.firstElementChild;
  if (!pacEl) return;
  if (p.moving !== lastMoving) { pacEl.classList.toggle("idle", !p.moving); lastMoving = p.moving; }
  const theta = (-Math.atan2(p.hy, p.hx) * 180) / Math.PI;
  const tf = p.hx < -0.01 ? `scaleX(-1) rotate(${(180 - theta).toFixed(1)}deg)` : `rotate(${theta.toFixed(1)}deg)`;
  if (tf !== lastTf) { pacEl.style.transform = tf; lastTf = tf; }
}

// Where the server thinks we are: the raw GPS fix when walking, Pac-Man in arcade
function claimXY() {
  if (S.run?.mode === "gps" && S.gpsRaw) return toXY(S.gpsRaw.lat, S.gpsRaw.lng);
  return [S.pac.x, S.pac.y];
}
function claimLatLng() {
  const [lat, lng] = toLatLng(...claimXY());
  return { lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) };
}

// ---------- Ghosts ----------
function centroid() {
  const n = S.houses.length || 1;
  return [S.houses.reduce((a, h) => a + h.x, 0) / n, S.houses.reduce((a, h) => a + h.y, 0) / n];
}

// A ghost house a fair distance from Pac-Man, towards the middle of the candy
function pickGhostHome() {
  const D = GAME[S.run.mode].ghostHome;
  const [cx, cy] = centroid();
  const { x, y } = S.pac;
  if (S.graph) {
    let best = 0, bestScore = Infinity;
    for (let i = 0; i < S.graph.size; i++) {
      if (!S.graph.adj[i].length) continue;
      const gx = S.graph.x[i], gy = S.graph.y[i];
      const score = Math.abs(Math.hypot(gx - x, gy - y) - D) + 0.25 * Math.hypot(gx - cx, gy - cy);
      if (score < bestScore) { bestScore = score; best = i; }
    }
    return [S.graph.x[best], S.graph.y[best]];
  }
  let dx = cx - x, dy = cy - y;
  const l = Math.hypot(dx, dy);
  if (l < 20) { dx = 0; dy = 1; } else { dx /= l; dy /= l; }
  return [x + dx * D, y + dy * D];
}

function corners() {
  const xs = S.houses.map((h) => h.x).concat(S.pac.x), ys = S.houses.map((h) => h.y).concat(S.pac.y);
  const [x0, x1, y0, y1] = [Math.min(...xs) - 40, Math.max(...xs) + 40, Math.min(...ys) - 40, Math.max(...ys) + 40];
  return [[x1, y1], [x0, y1], [x1, y0], [x0, y0]];
}

function makeGhosts() {
  S.ghosts?.destroy();
  const cfg = GAME[S.run.mode];
  S.ghosts = new Ghosts({
    graph: S.graph,
    toLatLng,
    layer: ghostLayer,
    home: pickGhostHome(),
    corners: corners(),
    mode: S.run.mode,
    count: cfg.ghosts,
    speeds: cfg.speeds,
    catchRadius: cfg.catchRadius,
    harmless: !!cfg.harmless,
    onCatch: caught,
    onEat: ateGhost,
  });
}

function caught(ghost) {
  const cfg = GAME[S.run.mode];
  S.invulnUntil = S.clock + cfg.invuln + 1;
  sfx.spooked();
  vibrate([90, 60, 90]);
  flashBody("hurt", 700);
  if (!reducedMotion()) flashBody("shake", 450);
  if (S.run.mode === "arcade") S.pac.frozenUntil = S.clock + 0.9;
  pacEl?.classList.add("dying");
  setTimeout(() => {
    pacEl?.classList.remove("dying");
    pacEl?.classList.add("blink");
    setTimeout(() => pacEl?.classList.remove("blink"), cfg.invuln * 1000);
  }, 900);
  floatText(map, toLatLng(S.pac.x, S.pac.y), "+10s", "bad");
  toast(`👻 ${ghost.kind.name} got you! +10 s`, "bad");
  api(`/runs/${S.run.runId}/event`, { body: { type: "spooked" } })
    .then((r) => { S.run.penalty = r.penalty; S.run.bonus = r.bonus; S.run.spooks++; updateClock(); })
    .catch(() => {});
}

function ateGhost(ghost) {
  sfx.eat();
  vibrate(30);
  floatText(map, toLatLng(ghost.x, ghost.y), "−5s", "good");
  api(`/runs/${S.run.runId}/event`, { body: { type: "ghost" } })
    .then((r) => {
      S.run.penalty = r.penalty;
      S.run.bonus = r.bonus;
      S.run.ghosts++;
      updateClock();
      toast(`😋 Ate ${ghost.kind.name}! −5 s`, "good");
    })
    .catch(() => {}); // the power-up ran out on the server: no bonus, no fuss
}

function flashBody(cls, ms) {
  document.body.classList.remove(cls);
  void document.body.offsetWidth;
  document.body.classList.add(cls);
  setTimeout(() => document.body.classList.remove(cls), ms);
}

function powerUp() {
  const secs = GAME[S.run.mode].fright;
  S.ghosts?.frighten(secs);
  sfx.power();
  toast(S.run.mode === "gps" ? "🍫 Full-size bars! Even the ghosts are scared of you 👻" : "🍫 Full-size bar! The ghosts are scared. Eat them!", "good", 3500);
}

// ---------- Claiming candy ----------
function checkClaims() {
  if (!S.run || S.finishing) return;
  const [x, y] = claimXY();
  for (const h of S.houses) {
    if (h.visited || h.pending || Date.now() < (h.retryAt || 0)) continue;
    if (Math.hypot(h.x - x, h.y - y) > CLAIM_AT) continue;
    claim(h);
  }
}

async function claim(h) {
  h.pending = true;
  try {
    const r = await api(`/runs/${S.run.runId}/visit`, { body: { houseId: h.id, ...claimLatLng() } });
    h.visited = true;
    h.justClaimed = true;
    h.marker.setIcon(houseIcon(h));
    h.justClaimed = false;
    const score = $("score");
    score.textContent = r.visited;
    score.classList.remove("bump");
    void score.offsetWidth;
    score.classList.add("bump");
    sfx.candy();
    vibrate(40);
    floatText(map, [h.lat, h.lng], h.fullSize ? "+1 🍫" : "+1 🍬");
    if (r.power) powerUp();
    if (r.remaining === 0) {
      sfx.win();
      toast("🎉 WAKA WAKA! You got all the candy!", "good", 3000);
      setTimeout(() => finishRun(), 1100);
    } else if (!r.power) {
      toast(`🍬 ${h.name}! ${r.remaining} to go`, "good");
    }
    if (S.routeOn) showRoute(true);
  } catch (e) {
    if (e.status === 429) {
      h.retryAt = Date.now() + (e.body?.cooldown || 5) * 1000;
      toast(`⚠️ ${e.message}`, "warn", 3500);
    } else if (e.body?.error === "too far from house") {
      h.retryAt = Date.now() + 1500;
    } else {
      h.retryAt = Date.now() + 4000;
      toast(e.message, "bad");
    }
  } finally {
    h.pending = false;
  }
}

// Position updates so the server can check our speed
async function ping() {
  if (!S.run || S.finishing) return;
  const pos = claimLatLng();
  const last = S.lastPing;
  if (last && distance(last, pos) < 1 && Date.now() - last.at < 10000) return;
  S.lastPing = { ...pos, at: Date.now() };
  try {
    const r = await api(`/runs/${S.run.runId}/ping`, { body: pos });
    if (r.flagged) banner("🚩 Run flagged for impossible speed. It won't count on the leaderboard.", { bad: true, sticky: true });
    else if (!r.ok) { sfx.warn(); toast(`⚠️ Whoa, that was too fast! Candy claims paused ${r.cooldown}s`, "warn", 3500); }
  } catch { /* offline for a moment: the next ping catches up */ }
}

// ---------- Find candy & route ----------
function nearestCandy() {
  const open = S.houses.filter((h) => !h.visited);
  if (!open.length) return null;
  const p = S.pac;
  if (S.graph) {
    const src = S.pac.walker ? (S.pac.walker.t < 0.5 ? S.pac.walker.from : S.pac.walker.to) : S.graph.nearestNode(p.x, p.y);
    const { dist, prev } = S.graph.dijkstra(src);
    let best = open[0];
    for (const h of open) if (dist[h.node] < dist[best.node]) best = h;
    if (Number.isFinite(dist[best.node])) {
      const path = [[p.x, p.y], ...StreetGraph.path(prev, best.node).map((v) => [S.graph.x[v], S.graph.y[v]])];
      return { house: best, meters: dist[best.node], path };
    }
  }
  let best = open[0];
  for (const h of open) if (Math.hypot(h.x - p.x, h.y - p.y) < Math.hypot(best.x - p.x, best.y - p.y)) best = h;
  return { house: best, meters: Math.hypot(best.x - p.x, best.y - p.y), path: [[p.x, p.y], [best.x, best.y]] };
}

let findLine = null, findTimer = null;
function findCandy() {
  const n = nearestCandy();
  if (!n) return toast("🎉 You already have all the candy!", "good");
  findLine?.remove();
  clearTimeout(findTimer);
  const latlngs = n.path.map(([x, y]) => toLatLng(x, y));
  findLine = L.polyline(latlngs, { color: "#7cff4f", weight: 5, dashArray: "8 10", lineCap: "round", interactive: false }).addTo(map);
  S.userPannedAt = Date.now();
  map.flyToBounds(latlngs, { padding: [90, 90], maxZoom: 18, duration: 0.7 });
  n.house.marker.openTooltip();
  toast(`🍬 ${n.house.name} is ${fmtDist(n.meters)} away. Follow the green line!`, "good", 3500);
  findTimer = setTimeout(() => { findLine?.remove(); findLine = null; }, 8000);
}

function showRoute(quiet) {
  routeLayer.clearLayers();
  S.dots = [];
  const open = S.houses.filter((h) => !h.visited);
  if (!open.length) { setRoute(false); return; }
  const start = S.graph ? (S.pac.walker ? S.pac.walker.to : S.graph.nearestNode(S.pac.x, S.pac.y)) : -1;
  const r = planRoute(S.graph, [S.pac.x, S.pac.y], start, open);
  for (const [x, y] of sampleDots(r.path, 11)) {
    const m = L.circleMarker(toLatLng(x, y), { renderer: dotRenderer, radius: 3.2, weight: 0, fillColor: "#ffb070", fillOpacity: 1, interactive: false }).addTo(routeLayer);
    S.dots.push({ x, y, m });
  }
  if (!quiet) toast(`🧭 Best route: ${fmtDist(r.meters)} through ${open.length} house${open.length === 1 ? "" : "s"}`);
}

function setRoute(on) {
  S.routeOn = on;
  $("routeBtn").setAttribute("aria-pressed", String(on));
  if (on) showRoute(false);
  else { routeLayer.clearLayers(); S.dots = []; }
}

let lastWaka = 0;
function eatDots() {
  if (!S.dots.length) return;
  const { x, y } = S.pac;
  let ate = false;
  S.dots = S.dots.filter((d) => {
    if (Math.hypot(d.x - x, d.y - y) > 7) return true;
    d.m.remove();
    ate = true;
    return false;
  });
  if (ate && S.clock - lastWaka > 0.13) { sfx.waka(); lastWaka = S.clock; }
}

// ---------- HUD ----------
function updateClock() {
  if (!S.run) return;
  $("time").textContent = fmtTime((Date.now() - S.run.localStart) / 1000);
  const net = S.run.penalty - S.run.bonus;
  const adj = $("adj");
  adj.textContent = net ? (net > 0 ? `+${net}s` : `−${-net}s`) : "";
  adj.className = net > 0 ? "pen" : net < 0 ? "bon" : "";
}

function updateNext() {
  const open = S.houses.filter((h) => !h.visited);
  if (!open.length) { $("next").textContent = "All candy collected!"; return; }
  const p = S.pac;
  let best = open[0], bestD = Infinity;
  for (const h of open) {
    const d = Math.hypot(h.x - p.x, h.y - p.y);
    if (d < bestD) { best = h; bestD = d; }
  }
  $("next").textContent = `${best.name} · ${fmtDist(bestD)}`;
  $("compass").style.transform = `rotate(${(bearingXY(best.x - p.x, best.y - p.y) - 90).toFixed(0)}deg)`;
}

function updatePower() {
  const g = S.ghosts;
  const on = !!g && g.frightened;
  $("powerBar").hidden = !on;
  document.body.classList.toggle("powered", on);
  if (on) $("powerBar").firstElementChild.style.transform = `scaleX(${(g.frightLeft / g.frightLength).toFixed(3)})`;
}

// Keep Pac-Man inside the middle of the screen without jerking the map around
function follow() {
  if (Date.now() - S.userPannedAt < 6000) { $("recenterBtn").hidden = false; return; }
  $("recenterBtn").hidden = true;
  const p = map.latLngToContainerPoint(toLatLng(S.pac.x, S.pac.y));
  const size = map.getSize();
  const left = size.x * 0.3, right = size.x * 0.7, top = Math.max(110, size.y * 0.3), bottom = Math.min(size.y - 150, size.y * 0.68);
  let dx = 0, dy = 0;
  if (p.x < left) dx = p.x - left; else if (p.x > right) dx = p.x - right;
  if (p.y < top) dy = p.y - top; else if (p.y > bottom) dy = p.y - bottom;
  if (Math.abs(dx) > 400 || Math.abs(dy) > 400) map.panTo(toLatLng(S.pac.x, S.pac.y), { animate: false });
  else if (dx || dy) map.panBy([dx, dy], { animate: false });
}

// ---------- Game loop ----------
// Always running: the other players roam behind the start screen too
let lastFrame = 0, lastCheck = 0;
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, (t - (lastFrame || t)) / 1000);
  lastFrame = t;
  rivals.update(dt);
  if (!S.playing) return;
  S.clock += dt;
  S.pac.update(dt, S.clock);
  drawPac();
  S.ghosts?.update(dt, S.pac, S.clock >= S.invulnUntil && !S.finishing);
  follow();
  if (S.clock - lastCheck > 0.15) {
    lastCheck = S.clock;
    checkClaims();
    eatDots();
    updateNext();
    updatePower();
  }
}
requestAnimationFrame(frame);

// ---------- GPS ----------
function startGps() {
  if (!navigator.geolocation) return;
  S.gpsWatch = navigator.geolocation.watchPosition(onFix, (err) => banner(`📡 GPS problem: ${err.message}`, { bad: true }), {
    enableHighAccuracy: true, maximumAge: 1000, timeout: 20000,
  });
}

function onFix(p) {
  const { latitude: lat, longitude: lng, accuracy } = p.coords;
  if (accuracy > 80) {
    banner(`📡 Weak GPS (±${Math.round(accuracy)} m). Step outside for a better signal.`);
    if (S.gpsRaw) return;
  } else {
    banner(null);
  }
  S.gpsRaw = { lat, lng, accuracy };
  S.pac.target = toXY(lat, lng);
  if (!S.accuracyCircle) {
    S.accuracyCircle = L.circle([lat, lng], { radius: accuracy, color: "#8b3dff", weight: 1, fillOpacity: 0.08, interactive: false }).addTo(map);
  } else {
    S.accuracyCircle.setLatLng([lat, lng]).setRadius(accuracy);
  }
}

async function keepAwake() {
  try { S.wakeLock = await navigator.wakeLock?.request("screen"); } catch { /* not allowed */ }
}
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && S.playing && S.run?.mode === "gps") keepAwake();
});

// ---------- Starting, resuming and finishing ----------
async function startGame() {
  sfx.unlock();
  const btn = $("go");
  if (!(await ensureSignedIn())) return;
  btn.disabled = true;
  const reset = () => { btn.disabled = false; btn.textContent = "Start trick-or-treating"; };
  try {
    btn.textContent = "Finding you…";
    let pos = S.located;
    if (S.mode === "gps") {
      pos = (await locate(12000)) || pos;
      if (!pos) {
        toast("Walk mode needs your location. Allow it, or play Arcade.", "bad", 4000);
        return reset();
      }
      S.located = pos;
    }
    const startAt = pos || S.center || null;
    if (!S.center || (startAt && distance(S.center, startAt) > 300)) await loadNeighbourhood(startAt);
    btn.textContent = "Loading your street maze…";
    await waitForStreets(5000);

    // Arcade: start on the nearest street so the first step is never a jump
    let [x, y] = toXY((startAt || S.center).lat, (startAt || S.center).lng);
    if (S.mode === "arcade" && S.streetsStatus === "ready") {
      const e = new StreetGraph(S.streets, S.proj).nearestEdge(x, y);
      if (e) { x = e.px; y = e.py; }
    }
    const [lat, lng] = toLatLng(x, y);
    btn.textContent = "Waking up the haunted server…";
    const run = await api("/runs/start", { body: { mode: S.mode, lat: Number(lat.toFixed(7)), lng: Number(lng.toFixed(7)) } });
    beginRun(run, x, y);
  } catch (e) {
    toast(`Couldn't start: ${e.message}`, "bad", 4000);
  } finally {
    reset();
  }
}

async function resumeRun() {
  const id = S.profile?.activeRun?.runId;
  if (!id) return;
  try {
    const run = await api(`/runs/${id}`);
    if (run.ended) { await loadProfile(); return toast("That run already ended", "warn"); }
    setMode(run.mode);
    const at = run.last || run.houses[0] || S.center;
    if (!S.center || distance(S.center, at) > 300) await loadNeighbourhood(at);
    await waitForStreets(4000);
    const [x, y] = toXY(at.lat, at.lng);
    beginRun(run, x, y);
  } catch (e) { toast(e.message, "bad"); }
}

function beginRun(run, x, y) {
  S.run = {
    runId: run.runId,
    mode: run.mode,
    penalty: run.penalty || 0,
    bonus: run.bonus || 0,
    ghosts: run.ghosts || 0,
    spooks: run.spooks || 0,
    localStart: Date.now() - (run.seconds || 0) * 1000,
  };
  S.finishing = false;
  S.clock = 0;
  S.invulnUntil = 2;
  S.userPannedAt = 0;
  S.lastPing = null;
  S.gpsRaw = null;
  const [startLat, startLng] = toLatLng(x, y);
  S.run.startLatLng = { lat: startLat, lng: startLng };
  setHouses(run.houses);
  S.graph = S.streetsStatus === "ready" ? buildGraph() : null;
  S.pac = new Pac(x, y);
  if (run.mode === "arcade" && S.graph) S.pac.useGraph(S.graph);
  S.pacMarker?.remove();
  S.pacMarker = L.marker(toLatLng(x, y), { icon: pacIcon, zIndexOffset: 1000, interactive: false, keyboard: false }).addTo(map);
  pacEl = null; lastTf = ""; lastMoving = null;
  makeGhosts();
  S.feedSeen = Math.max(0, ...(S.activity?.feed || []).map((f) => f.time));

  $("start").hidden = true;
  $("results").hidden = true;
  for (const id of ["hud", "tools", "bar"]) $(id).hidden = false;
  $("pad").hidden = run.mode !== "arcade";
  document.body.classList.add("playing");
  map.setView(toLatLng(x, y), 17, { animate: false });

  S.timers.push(setInterval(updateClock, 250), setInterval(ping, PING_EVERY), setInterval(pollChatBadge, 15000));
  updateClock();
  if (run.mode === "gps") {
    startGps();
    keepAwake();
    toast("🚶 Walk to the glowing houses! Watch the road, not your phone.", "info", 4000);
  } else {
    toast(S.graph ? "🕹️ Arrow keys / WASD or the D-pad. Run the streets!" : "🕹️ Arrow keys / WASD or the D-pad to move", "info", 3500);
  }
  S.playing = true;
  refreshRivals();
  updateStatus();
}

function stopPlaying() {
  S.playing = false;
  S.timers.forEach(clearInterval);
  S.timers = [];
  if (S.gpsWatch != null) navigator.geolocation.clearWatch(S.gpsWatch);
  S.gpsWatch = null;
  S.wakeLock?.release?.().catch(() => {});
  S.wakeLock = null;
  S.accuracyCircle?.remove();
  S.accuracyCircle = null;
  S.ghosts?.destroy();
  S.ghosts = null;
  findLine?.remove();
  setRoute(false);
  for (const id of ["hud", "tools", "bar", "pad", "legend", "banner"]) $(id).hidden = true;
  $("banner").className = "";
  document.body.classList.remove("playing", "powered");
}

async function finishRun() {
  if (S.finishing || !S.run) return;
  S.finishing = true;
  try {
    const r = await api(`/runs/${S.run.runId}/finish`, { body: {} });
    stopPlaying();
    showResults(r);
  } catch (e) {
    if (e.message === "run already finished") {
      // ended on another device: just leave the game
      stopPlaying();
      $("start").hidden = false;
      loadProfile();
      toast("This run was already finished", "warn");
      return;
    }
    S.finishing = false;
    toast(e.message, "bad");
  }
}

async function endButton() {
  const got = S.houses.filter((h) => h.visited).length;
  const ok = await confirmModal({
    title: "🏁 End your run?",
    text: `You've got ${got} of ${S.houses.length} candy. Your time stops now.`,
    ok: "End run",
    cancel: "Keep going",
  });
  if (ok) finishRun();
}

// ---------- Results & leaderboards ----------
function showResults(r) {
  const all = r.houses === r.total;
  $("resTitle").textContent = all ? "🎉 All candy collected!" : "🏁 Run complete!";
  const flag = $("resFlag");
  flag.hidden = !r.flagged;
  flag.textContent = "🚩 This run was flagged for moving faster than anyone can walk, so it won't appear on the leaderboard.";
  const adj = [r.penalty && `+${r.penalty}s ghosts`, r.bonus && `−${r.bonus}s eaten`].filter(Boolean).join(" · ");
  $("resStats").replaceChildren(
    stat("Candy", `${r.houses}/${r.total}`, all ? "full haul!" : `${r.total - r.houses} left behind`),
    stat("Time", fmtTime(r.seconds), adj || "no ghost trouble"),
    stat("Distance", fmtDist(r.meters), r.mode === "gps" ? "walked" : "run"),
    r.mode === "gps" ? stat("Ghosts", "👻", "just along for the vibes") : stat("Ghosts eaten", String(r.ghosts), r.spooks ? `caught ${r.spooks}×` : "never caught"));
  renderBoard($("resBoard"), { mode: r.mode, scope: "street", at: S.run.startLatLng });
  $("results").hidden = false;
  S.lastResult = r;
  S.run.done = true;
  loadProfile();
}

const stat = (label, value, note) => el("div", { class: "stat" }, el("span", {}, label), el("b", {}, value), el("small", {}, note));

const SCOPE_LABELS = { street: "Street", district: "District", city: "City", world: "World" };
const MEDALS = ["🥇", "🥈", "🥉"];

function renderBoard(container, opts) {
  const state = { mode: opts.mode, scope: opts.scope };
  const modeTabs = el("div", { class: "tabs", role: "tablist" });
  const scopeTabs = el("div", { class: "tabs", role: "tablist" });
  const list = el("ol", { class: "board" });
  const draw = async () => {
    modeTabs.replaceChildren(...[["gps", "🚶 Ranked walk"], ["arcade", "🕹️ At home"]].map(([m, label]) =>
      el("button", { role: "tab", "aria-selected": String(state.mode === m), onclick: () => { state.mode = m; draw(); } }, label)));
    scopeTabs.replaceChildren(...Object.entries(SCOPE_LABELS).map(([s, label]) =>
      el("button", { role: "tab", "aria-selected": String(state.scope === s), onclick: () => { state.scope = s; draw(); } }, label)));
    list.replaceChildren(el("li", { class: "sep" }, "Loading…"));
    const at = opts.at;
    const q = state.scope === "world" || !at ? `scope=world&mode=${state.mode}` : `scope=${state.scope}&mode=${state.mode}&lat=${at.lat}&lng=${at.lng}`;
    try {
      const b = await api(`/leaderboard?${q}`);
      if (!b.rows.length) {
        list.replaceChildren(el("li", { class: "board-empty" }, state.mode === "gps" ? "No ranked walks here yet. Be the first!" : "No arcade runs here yet. Be the first!"));
        return;
      }
      const row = (e) => el("li", { class: e.me ? "me" : "" },
        el("span", { class: "rank" }, MEDALS[e.rank - 1] || `#${e.rank}`),
        el("span", { class: "who-name" }, e.player),
        el("span", { class: "score" }, `${e.houses} 🍬 · ${fmtTime(e.seconds)}`));
      const rows = b.rows.map(row);
      if (b.me && !b.rows.some((e) => e.me)) rows.push(el("li", { class: "sep" }, "⋯"), row(b.me));
      if (b.bots) rows.push(el("li", { class: "board-note" }, "✨ Includes demo players, so there's always someone to beat"));
      list.replaceChildren(...rows);
    } catch (e) {
      list.replaceChildren(el("li", { class: "board-empty" }, e.message));
    }
  };
  container.replaceChildren(el("div", { class: "stack" }, el("h3", {}, "🏆 Leaderboard"), modeTabs, scopeTabs, list));
  draw();
}

function openLeaderboard() {
  const box = el("div");
  const close = openModal(el("div", { class: "stack" }, box, el("button", { class: "primary", onclick: () => close() }, "Close")), { wide: true });
  renderBoard(box, { mode: S.mode, scope: S.isDefault ? "world" : "street", at: S.located || S.center });
}

async function share() {
  const r = S.lastResult;
  if (!r) return;
  const text = `🎃 I collected ${r.houses}/${r.total} candy in ${fmtTime(r.seconds)} on Pack_Ween${r.ghosts ? ` and ate ${r.ghosts} ghost${r.ghosts === 1 ? "" : "s"}` : ""}! Can you beat me?`;
  const url = location.origin + location.pathname;
  try {
    if (navigator.share) await navigator.share({ title: "Pack_Ween", text, url });
    else { await navigator.clipboard.writeText(`${text} ${url}`); toast("Copied to clipboard!", "good"); }
  } catch { /* share sheet closed */ }
}

// ---------- Hosting a candy house ----------
function openHost() {
  const name = el("input", { maxlength: "40", placeholder: "House name, e.g. Maple St porch", value: S.profile ? `${S.profile.name}'s porch` : "" });
  const full = el("input", { type: "checkbox" });
  const status = el("p", { class: "hint" }, "Stand at your front door: we pin the house where you are right now.");
  const submit = el("button", { class: "primary" }, "📍 Pin my house here");
  const mine = el("div", { class: "stack" });
  const renderMine = () => {
    const houses = S.profile?.houses || [];
    mine.replaceChildren(...(houses.length ? [el("h3", {}, "Your houses"), ...houses.map((h) =>
      el("div", { class: "row" }, el("span", { style: "align-self:center" }, `${h.fullSize ? "🍫" : "🍬"} ${h.name}`), el("button", { onclick: () => removeHouse(h.id) }, "Remove")))] : []));
  };
  renderMine();
  submit.onclick = async () => {
    if (!(await ensureSignedIn())) return;
    submit.disabled = true;
    status.textContent = "📡 Getting your exact location…";
    const pos = await locate(12000);
    if (!pos) { status.textContent = "We need your location to pin the house. Allow it and try again."; submit.disabled = false; return; }
    if (pos.accuracy > 100) { status.textContent = `Your location is only accurate to ±${Math.round(pos.accuracy)} m. Step outside and try again.`; submit.disabled = false; return; }
    try {
      await api("/houses", { body: { name: name.value, lat: pos.lat, lng: pos.lng, fullSize: full.checked } });
      close();
      toast("🏠 Your house is on the map! It gets a ✓ once 3 trick-or-treaters collect from it.", "good", 5000);
      S.located = pos;
      await loadProfile();
      await loadNeighbourhood(pos);
    } catch (e) {
      status.textContent = e.message;
      submit.disabled = false;
    }
  };
  const close = openModal(el("div", { class: "stack" },
    el("h2", {}, "🏠 Hand out candy"),
    el("p", {}, "Put your house on the Pack_Ween map so trick-or-treaters can find it. It's verified automatically once three different players collect your candy."),
    S.profile ? null : el("p", { class: "hint" }, "Sign in with your name and PIN on the start screen first."),
    name,
    el("label", { class: "row", style: "align-items:center;flex:none;gap:10px" }, full, el("span", { style: "flex:9" }, "Full-size bars (makes it a 🍫 power-up house)")),
    status,
    el("div", { class: "row" }, el("button", { onclick: () => close() }, "Cancel"), submit),
    mine));
}

// ---------- Chat ----------
const chatAt = () => S.center || S.located;

async function loadChat() {
  const at = chatAt();
  const q = at ? `?lat=${at.lat}&lng=${at.lng}` : "";
  const msgs = await api(`/chat${q}`, { retries: 0 }).catch(() => null);
  if (!msgs) return null;
  const box = $("msgs");
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren();
  if (!msgs.length) box.append(el("p", { class: "empty" }, "No messages yet. Tell your neighbours which house has the best candy!"));
  for (const m of msgs) {
    const time = new Date(m.time).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    box.append(el("div", { class: `msg${!m.bot && S.profile && m.player === S.profile.name ? " mine" : ""}` },
      el("b", {}, m.player), m.bot && el("span", { class: "bot-tag", title: "Demo player" }, "demo"), el("small", {}, time), el("p", {}, m.text)));
  }
  if (atBottom) box.scrollTop = box.scrollHeight;
  if (msgs.length) S.chatSeen = Math.max(S.chatSeen, msgs[msgs.length - 1].time);
  $("chatBadge").hidden = true;
  return msgs;
}

let chatTimer = null;
function openChat() {
  $("chat").hidden = false;
  S.chatOpen = true;
  loadChat().then(() => { $("msgs").scrollTop = $("msgs").scrollHeight; });
  clearInterval(chatTimer);
  chatTimer = setInterval(loadChat, 3000);
  $("chatText").focus();
}
function closeChat() {
  $("chat").hidden = true;
  S.chatOpen = false;
  clearInterval(chatTimer);
}
async function pollChatBadge() {
  if (S.chatOpen) return;
  const at = chatAt();
  const msgs = (await api(`/chat${at ? `?lat=${at.lat}&lng=${at.lng}` : ""}`, { retries: 0 }).catch(() => null)) || [];
  const newest = msgs.length ? msgs[msgs.length - 1] : null;
  if (newest && newest.time > S.chatSeen && (newest.bot || newest.player !== S.profile?.name)) $("chatBadge").hidden = false;
}

// ---------- Other players ----------
// Point the roaming players at the current houses and streets
function refreshRivals() {
  if (!S.proj || !S.houses.length) return;
  let graph = null;
  if (S.playing) graph = S.graph;
  else if (S.streetsStatus === "ready") graph = S.previewGraph || (S.previewGraph = new StreetGraph(S.streets, S.proj));
  const speed = S.playing && S.run.mode === "gps" ? [1.2, 1.7] : [12, 17];
  rivals.setWorld(graph, S.houses.map((h) => [h.x, h.y]), speed);
}

const ago = (t) => {
  const m = Math.round((Date.now() - t) / 60000);
  return m < 1 ? "just now" : `${m} min ago`;
};

async function loadActivity() {
  const at = S.center || S.located;
  const a = await api(`/activity${at ? `?lat=${at.lat}&lng=${at.lng}` : ""}`, { retries: 0 }).catch(() => null);
  if (!a) return;
  S.activity = a;
  rivals.setPlayers(a.players);
  $("live").hidden = false;
  $("liveCount").textContent = a.playing;
  $("liveFeed").replaceChildren(...a.feed.slice(0, 3).map((f) => el("li", {}, f.text, el("small", {}, ago(f.time)))));
  if (S.playing) feedToast(a.feed);
}

// Now and then, mention what someone else just did
let lastFeedToast = 0;
function feedToast(feed) {
  const me = S.profile?.name;
  const fresh = feed.find((f) => f.time > S.feedSeen && !(me && f.text.startsWith(`${me} `)));
  S.feedSeen = Math.max(S.feedSeen, ...feed.map((f) => f.time));
  if (fresh && Date.now() - lastFeedToast > 45000) {
    lastFeedToast = Date.now();
    toast(`👀 ${fresh.text}`, "info", 3000);
  }
}

// ---------- Wiring ----------
function setMode(mode) {
  S.mode = mode;
  store.set(MODE_KEY, mode);
  document.querySelectorAll(".mode").forEach((b) => b.setAttribute("aria-checked", String(b.dataset.mode === mode)));
}
document.querySelectorAll(".mode").forEach((b) => (b.onclick = () => { sfx.click(); setMode(b.dataset.mode); }));
setMode(S.mode);

$("go").onclick = startGame;
$("signIn").onsubmit = (e) => e.preventDefault();
$("name").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); $("pin").focus(); } });
$("pin").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); startGame(); } });
$("demoBtn").onclick = async () => {
  $("name").value = "Demo";
  $("pin").value = "1234";
  await ensureSignedIn();
};
$("switchUser").onclick = () => { setToken(null); S.profile = null; renderWho(); $("name").focus(); };
$("resumeGo").onclick = resumeRun;
$("resumeEnd").onclick = async () => {
  try { await api(`/runs/${S.profile.activeRun.runId}/finish`, { body: {} }); } catch { /* already over */ }
  await loadProfile();
  toast("Old run ended", "good");
};
$("boardBtn").onclick = openLeaderboard;
$("hostBtn").onclick = openHost;

$("findBtn").onclick = findCandy;
$("routeBtn").onclick = () => setRoute(!S.routeOn);
$("chatBtn").onclick = () => (S.chatOpen ? closeChat() : openChat());
$("chatClose").onclick = closeChat;
$("resChat").onclick = openChat;
$("endBtn").onclick = endButton;
$("again").onclick = () => {
  closeChat();
  $("results").hidden = true;
  S.pacMarker?.remove();
  S.pacMarker = null;
  S.pac = null;
  S.run = null;
  S.graph = null;
  $("start").hidden = false;
  loadNeighbourhood(S.located);
};
$("shareBtn").onclick = share;
$("recenterBtn").onclick = () => { S.userPannedAt = 0; map.panTo(toLatLng(S.pac.x, S.pac.y)); };
$("legendBtn").onclick = () => {
  const l = $("legend");
  l.hidden = !l.hidden;
  $("legendBtn").setAttribute("aria-expanded", String(!l.hidden));
};
const renderMute = () => { $("muteBtn").textContent = isMuted() ? "🔇" : "🔊"; };
$("muteBtn").onclick = () => { setMuted(!isMuted()); renderMute(); if (!isMuted()) sfx.click(); };
renderMute();

$("chatForm").onsubmit = async (e) => {
  e.preventDefault();
  const text = $("chatText").value.trim();
  if (!text) return;
  if (!(await ensureSignedIn())) return;
  const at = chatAt();
  try {
    await api("/chat", { body: { text, ...(at ? { lat: at.lat, lng: at.lng } : {}) } });
    $("chatText").value = "";
    await loadChat();
    $("msgs").scrollTop = $("msgs").scrollHeight;
  } catch (err) { toast(err.message, "bad"); }
};

// D-pad: react on press, not on click, so it feels instant on phones
document.querySelectorAll("#pad button").forEach((b) => {
  b.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    if (!S.playing || !S.pac) return;
    S.pac.setWant(b.dataset.dir);
    b.classList.add("on");
  });
  for (const ev of ["pointerup", "pointerleave", "pointercancel"]) b.addEventListener(ev, () => b.classList.remove("on"));
});
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT" || e.metaKey || e.ctrlKey) return;
  if (e.key === "m" || e.key === "M") { $("muteBtn").click(); return; }
  const dir = KEYS[e.key];
  if (!dir || !S.playing || S.run?.mode !== "arcade") return;
  e.preventDefault();
  S.pac.setWant(dir);
  const b = document.querySelector(`#pad [data-dir="${dir}"]`);
  b?.classList.add("on");
  setTimeout(() => b?.classList.remove("on"), 120);
});

// ---------- Boot ----------
setInterval(loadActivity, 20000);
(async () => {
  loadProfile();
  // Show the default neighbourhood straight away, then move to the player once located
  const first = loadNeighbourhood(null).catch(() => {
    $("hoodStatus").textContent = "👻 Waking up the haunted server… (first visit can take a few seconds)";
  });
  const pos = await locate();
  await first;
  if (pos && !S.playing) {
    S.located = pos;
    try { await loadNeighbourhood(pos); } catch { /* keep the default neighbourhood */ }
  } else if (!S.center) {
    // the server was asleep: keep trying until it answers
    for (let i = 0; i < 10 && !S.center; i++) {
      await sleep(3000);
      await loadNeighbourhood(null).catch(() => {});
    }
  }
})();
