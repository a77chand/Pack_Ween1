// Real street maps from OpenStreetMap (via the Overpass API).
//
// The game turns the streets around the player into a Pac-Man maze and puts the
// neighbourhood's houses on real buildings. Overpass is free but slow (often
// 20-40 s), so every map is fetched once per ~500 m cell, compacted to a small
// graph and cached in SQLite. The default demo neighbourhood ships pre-baked.

const fs = require("fs");
const path = require("path");
const { projector, distanceMeters, round } = require("./geo");

const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const USER_AGENT = "PackWeen/2.0 (+https://github.com/a77chand/Pack_Ween1)";
const CELL_DEG = 0.005;           // maps are cached per cell of 0.005 degrees
const RADIUS = 900;               // meters of map fetched around a cell's centre
const FETCH_TIMEOUT = 60000;
const RETRY_AFTER_FAIL = 2 * 60 * 1000;
const MAX_INFLIGHT = 3;
const BAKED_RADIUS = 300;         // use a baked map within this many meters of its centre
const SIMPLIFY_METERS = 2;        // straight-ish road points closer than this to the line are dropped
const MAX_BUILDINGS = 1500;

// Streets plus walking paths (park trails, campus paths); sidewalks are left out
// because they would draw a second line next to every street.
const ROADS = /^(primary|primary_link|secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|living_street|pedestrian|service|footway|path|steps|cycleway)$/;
const SKIP_SERVICE = /^(parking_aisle|driveway|drive-through|emergency_access)$/;
const SKIP_FOOTWAY = /^(sidewalk|traffic_island)$/;
const SKIP_ACCESS = /^(private|no)$/;
const SKIP_BUILDINGS = /^(no|roof|shed|garage|garages|carport|bridge|service|hut|kiosk|transformer_tower|construction|ruins|greenhouse)$/;
const HOMES = /^(yes|house|detached|semidetached_house|terrace|residential|apartments|bungalow)$/;

function cellFor(lat, lng) {
  const i = Math.round(lat / CELL_DEG);
  const j = Math.round(lng / CELL_DEG);
  return { key: `${i}:${j}`, lat: round(i * CELL_DEG), lng: round(j * CELL_DEG) };
}

function overpassQuery(lat, lng, radius) {
  const around = `(around:${radius},${lat},${lng})`;
  return `[out:json][timeout:55];way["highway"~"${ROADS.source}"]${around};out geom qt;way["building"]${around};out center qt;`;
}

// Ask every mirror at once and keep the first good answer
async function fetchOverpass(lat, lng, radius) {
  const body = new URLSearchParams({ data: overpassQuery(lat, lng, radius) }).toString();
  const controllers = MIRRORS.map(() => new AbortController());
  const attempt = async (url, i) => {
    const signal = AbortSignal.any([controllers[i].signal, AbortSignal.timeout(FETCH_TIMEOUT)]);
    const res = await fetch(url, {
      method: "POST",
      body,
      headers: { "User-Agent": USER_AGENT, "Content-Type": "application/x-www-form-urlencoded" },
      signal,
    });
    if (!res.ok) throw new Error(`Overpass ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.elements)) throw new Error("Overpass sent no elements");
    controllers.forEach((c, k) => k !== i && c.abort());
    return json;
  };
  return Promise.any(MIRRORS.map(attempt));
}

// Douglas-Peucker on one chain of points: returns which indexes to keep
function simplifyChain(pts, tolerance) {
  const keep = new Uint8Array(pts.length);
  keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a];
    const [bx, by] = pts[b];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let worst = -1, worstD = tolerance;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = pts[i];
      let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
      t = Math.max(0, Math.min(1, t));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > worstD) { worst = i; worstD = d; }
    }
    if (worst > 0) {
      keep[worst] = 1;
      stack.push([a, worst], [worst, b]);
    }
  }
  return keep;
}

// Overpass JSON -> { nodes: [[lat,lng]], edges: [[a,b]], buildings: [[lat,lng,isHome]] }
function compact(json, lat0, lng0) {
  const { toXY, toLatLng } = projector(lat0, lng0);
  const idToIndex = new Map();
  const xy = [];
  const adj = [];

  for (const el of json.elements || []) {
    if (el.type !== "way" || !el.tags || !el.geometry || !el.nodes) continue;
    const t = el.tags;
    if (!ROADS.test(t.highway || "") || SKIP_SERVICE.test(t.service || "") || SKIP_FOOTWAY.test(t.footway || "") ||
        SKIP_ACCESS.test(t.access || "") || t.area === "yes") continue;
    let prev = -1;
    for (let k = 0; k < el.nodes.length; k++) {
      const g = el.geometry[k];
      if (!g) { prev = -1; continue; }
      let i = idToIndex.get(el.nodes[k]);
      if (i === undefined) {
        i = xy.length;
        idToIndex.set(el.nodes[k], i);
        xy.push(toXY(g.lat, g.lon));
        adj.push(new Set());
      }
      if (prev >= 0 && prev !== i) { adj[prev].add(i); adj[i].add(prev); }
      prev = i;
    }
  }

  // Keep only the largest connected piece, so Pac-Man can never get stranded
  const comp = new Int32Array(xy.length).fill(-1);
  let best = -1, bestSize = 0, c = 0;
  for (let s = 0; s < xy.length; s++) {
    if (comp[s] >= 0) continue;
    let size = 0;
    const stack = [s];
    comp[s] = c;
    while (stack.length) {
      const u = stack.pop();
      size++;
      for (const v of adj[u]) if (comp[v] < 0) { comp[v] = c; stack.push(v); }
    }
    if (size > bestSize) { bestSize = size; best = c; }
    c++;
  }

  // Junctions and dead ends always stay; points along a road stay only where it bends
  const keep = new Uint8Array(xy.length);
  let anyKept = false;
  for (let i = 0; i < xy.length; i++) {
    if (comp[i] === best && adj[i].size !== 2) { keep[i] = 1; anyKept = true; }
  }
  if (!anyKept && best >= 0) keep[comp.indexOf(best)] = 1; // the whole map is one ring road

  const edgeKeys = new Set();
  const edges = [];
  const walked = new Set();
  const ekey = (a, b) => (a < b ? `${a},${b}` : `${b},${a}`);
  const addEdge = (a, b) => {
    if (a === b) return;
    const k = ekey(a, b);
    if (!edgeKeys.has(k)) { edgeKeys.add(k); edges.push([a, b]); }
  };

  for (let start = 0; start < xy.length; start++) {
    if (!keep[start]) continue;
    for (const first of adj[start]) {
      if (walked.has(ekey(start, first))) continue;
      const chain = [start];
      let prev = start, cur = first;
      walked.add(ekey(prev, cur));
      while (!keep[cur]) {
        chain.push(cur);
        const next = [...adj[cur]].find((n) => n !== prev);
        if (next === undefined) break;
        prev = cur;
        cur = next;
        if (walked.has(ekey(prev, cur))) break;
        walked.add(ekey(prev, cur));
      }
      chain.push(cur);
      const flags = simplifyChain(chain.map((i) => xy[i]), SIMPLIFY_METERS);
      if (chain[0] === chain[chain.length - 1] && chain.length > 3) {
        // a loop back to the same junction needs two corners to stay a loop
        flags[Math.floor(chain.length / 3)] = 1;
        flags[Math.floor((2 * chain.length) / 3)] = 1;
      }
      let last = chain[0];
      for (let k = 1; k < chain.length; k++) {
        if (!flags[k]) continue;
        keep[chain[k]] = 1;
        addEdge(last, chain[k]);
        last = chain[k];
      }
    }
  }

  // Re-number the kept nodes
  const newIndex = new Map();
  const nodes = [];
  for (const [a, b] of edges) {
    for (const i of [a, b]) {
      if (!newIndex.has(i)) {
        newIndex.set(i, nodes.length);
        const [lat, lng] = toLatLng(...xy[i]);
        nodes.push([round(lat), round(lng)]);
      }
    }
  }

  const buildings = (json.elements || [])
    .filter((el) => el.tags && el.tags.building && el.center && !SKIP_BUILDINGS.test(el.tags.building))
    .map((el) => ({
      lat: el.center.lat,
      lng: el.center.lon,
      home: HOMES.test(el.tags.building) ? 1 : 0,
      d: distanceMeters(lat0, lng0, el.center.lat, el.center.lon),
    }))
    .sort((a, b) => a.d - b.d)
    .slice(0, MAX_BUILDINGS)
    .map((b) => [round(b.lat, 5), round(b.lng, 5), b.home]);

  return {
    v: 1,
    lat: lat0,
    lng: lng0,
    nodes,
    edges: edges.map(([a, b]) => [newIndex.get(a), newIndex.get(b)]),
    buildings,
  };
}

function loadBaked(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Cache-backed street maps. lookup() never waits: it answers ready, pending or failed.
function createStreetService(db, { fetcher = fetchOverpass, baked = [], enabled = true } = {}) {
  const getRow = db.prepare("SELECT data FROM osm_cache WHERE cell = ?");
  const putRow = db.prepare("INSERT OR REPLACE INTO osm_cache (cell, data, fetched_at) VALUES (?, ?, ?)");
  const memory = new Map(); // cell -> { data, json }, a small LRU in front of SQLite
  const inflight = new Map();
  const failedAt = new Map();

  const remember = (key, data, json) => {
    memory.delete(key);
    memory.set(key, { data, json: json || JSON.stringify(data) });
    if (memory.size > 24) memory.delete(memory.keys().next().value);
    return memory.get(key);
  };
  baked.forEach((b, i) => remember(`baked:${i}`, b));

  function lookup(lat, lng) {
    for (let i = 0; i < baked.length; i++) {
      if (distanceMeters(lat, lng, baked[i].lat, baked[i].lng) <= BAKED_RADIUS)
        return { status: "ready", ...memory.get(`baked:${i}`) };
    }
    const cell = cellFor(lat, lng);
    if (memory.has(cell.key)) return { status: "ready", ...remember(cell.key, memory.get(cell.key).data, memory.get(cell.key).json) };
    const row = getRow.get(cell.key);
    if (row) return { status: "ready", ...remember(cell.key, JSON.parse(row.data), row.data) };
    if (!enabled) return { status: "failed" };
    if (inflight.has(cell.key)) return { status: "pending" };
    if (Date.now() - (failedAt.get(cell.key) || 0) < RETRY_AFTER_FAIL) return { status: "failed" };
    if (inflight.size >= MAX_INFLIGHT) return { status: "pending" };

    const job = Promise.resolve()
      .then(() => fetcher(cell.lat, cell.lng, RADIUS))
      .then((json) => {
        const data = compact(json, cell.lat, cell.lng);
        const text = JSON.stringify(data);
        putRow.run(cell.key, text, Date.now());
        remember(cell.key, data, text);
      })
      .catch((err) => {
        failedAt.set(cell.key, Date.now());
        console.warn(`Street map for cell ${cell.key} failed: ${err.message}`);
      })
      .finally(() => inflight.delete(cell.key));
    inflight.set(cell.key, job);
    return { status: "pending" };
  }

  // Like lookup, but waits up to ms for a pending map
  async function wait(lat, lng, ms) {
    const first = lookup(lat, lng);
    if (first.status !== "pending") return first;
    const job = inflight.get(cellFor(lat, lng).key);
    await Promise.race([job || sleep(0), sleep(ms)]);
    return lookup(lat, lng);
  }

  return { lookup, wait };
}

module.exports = { createStreetService, compact, fetchOverpass, loadBaked, cellFor, RADIUS };
