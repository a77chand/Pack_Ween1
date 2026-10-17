// Tests for the game's own logic (public/js): the street maze, route planning
// and ghost AI, run against the real baked Waterloo street map.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { StreetGraph, Walker } from "../public/js/streets.js";
import { planRoute, sampleDots, sumPath } from "../public/js/route.js";
import { projector } from "../public/js/geo.js";

// Ghosts draw Leaflet markers; a stub is enough here
globalThis.L = { marker: () => ({ addTo() { return this; }, setLatLng() {}, getElement: () => null, remove() {} }), divIcon: () => ({}) };
const { Ghosts } = await import("../public/js/ghosts.js");

const data = JSON.parse(fs.readFileSync(new URL("../osm/waterloo.json", import.meta.url)));
const proj = projector(data.lat, data.lng);

test("attach() makes an off-street house reachable with a short driveway", () => {
  const g = new StreetGraph(data, proj);
  const e = g.nearestEdge(0, 0);
  const [hx, hy] = [e.px + 18, e.py + 18]; // a house 25 m off the street
  const before = g.size;
  const node = g.attach(hx, hy);
  assert.equal(g.size, before + 2, "a node on the street plus one at the door");
  assert.equal(g.adj[node].length, 1);
  const { dist } = g.dijkstra(g.nearestNode(300, 300));
  assert.ok(Number.isFinite(dist[node]), "reachable from anywhere");
});

test("a walker follows the street and stops where choose() says", () => {
  const g = new StreetGraph({ nodes: [[0, 0], [0, 0.0005], [0, 0.001]], edges: [[0, 1], [1, 2]] }, projector(0, 0));
  const w = new Walker(g, 0);
  w.advance(30, (node, came) => g.adj[node].find((n) => n !== came) ?? null);
  assert.ok(Math.abs(w.x - 30) < 0.01 && Math.abs(w.y) < 0.01);
  w.advance(500, (node, came) => g.adj[node].find((n) => n !== came) ?? null);
  assert.equal(w.moving, false, "stopped at the dead end");
  assert.ok(Math.abs(w.x - g.x[2]) < 0.01);
  w.from = 2; w.to = 1; w.t = 0.25;
  w.reverse();
  assert.equal(w.from, 1);
  assert.equal(w.to, 2);
  assert.equal(w.t, 0.75);
});

test("street route visits every house and its Pac-dots follow the path", () => {
  const g = new StreetGraph(data, proj);
  const houses = [[60, 80], [-90, 40], [120, -60], [-40, -110], [10, 150]].map(([x, y]) => ({ x, y, node: g.attach(x, y) }));
  const start = g.nearestNode(0, 0);
  const r = planRoute(g, [g.x[start], g.y[start]], start, houses);
  assert.deepEqual([...r.order].sort(), [0, 1, 2, 3, 4]);
  // the path passes every house's door
  for (const h of houses) assert.ok(r.path.some(([x, y]) => Math.hypot(x - g.x[h.node], y - g.y[h.node]) < 0.01));
  const straight = planRoute(null, [g.x[start], g.y[start]], -1, houses);
  assert.ok(r.meters >= straight.meters - 1, "streets are never shorter than a straight line");
  const dots = sampleDots(r.path, 11);
  assert.ok(Math.abs(dots.length - sumPath(r.path) / 11) < 2);
});

test("ghosts catch a Pac-Man who stands still, and a power-up makes them edible", () => {
  const g = new StreetGraph(data, proj);
  const e = g.nearestEdge(-80, 20);
  const pnode = g.split(e.a, e.b, e.t);
  const pac = { x: g.x[pnode], y: g.y[pnode], hx: 1, hy: 0 };
  let home = 0, best = Infinity;
  for (let i = 0; i < g.size; i++) {
    const s = Math.abs(Math.hypot(g.x[i] - pac.x, g.y[i] - pac.y) - 150);
    if (g.adj[i].length && s < best) { best = s; home = i; }
  }
  const events = [];
  const make = () => new Ghosts({
    graph: g, toLatLng: proj.toLatLng, layer: null, home: [g.x[home], g.y[home]],
    corners: [[300, 300], [-300, 300], [300, -300], [-300, -300]], mode: "arcade", count: 4,
    speeds: { chase: 16.5, fright: 10, eaten: 45 }, catchRadius: 9,
    onCatch: (gh) => events.push(["caught", gh.kind.name]), onEat: (gh) => events.push(["eaten", gh.kind.name]),
  });

  const ghosts = make();
  for (let f = 0; f < 60 * 45 && !events.length; f++) ghosts.update(1 / 60, pac, true);
  assert.equal(events[0]?.[0], "caught", "caught within 45 s");
  assert.ok(ghosts.list.every((gh) => gh.state === "house"), "everyone goes home after a catch");

  // Power-up: a frightened ghost touching Pac-Man gets eaten instead
  events.length = 0;
  const scared = make();
  for (let f = 0; f < 60 * 45 && !events.length; f++) {
    if (f === 60 * 3) scared.frighten(60);
    scared.update(1 / 60, pac, true);
  }
  assert.ok(!events.some(([type]) => type === "caught"), "no catches while frightened");
});
