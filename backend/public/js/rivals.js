// Other trick-or-treaters on the map: the demo players from /activity, running
// from candy house to candy house along the streets. Display only: they never
// touch your houses or your score.

import { StreetGraph, Walker } from "./streets.js";
import { el } from "./ui.js";

const MAX_ON_MAP = 4;

export class Rivals {
  constructor({ layer, toLatLng, onArrive }) {
    this.layer = layer;
    this.toLatLng = toLatLng;
    this.onArrive = onArrive;
    this.list = [];
    this.players = [];
    this.graph = null;
    this.targets = [];
    this.speed = [13, 18];
    this.t = 0;
  }

  // graph: StreetGraph or null (then they move in straight lines); targets: [[x, y]] of candy houses
  setWorld(graph, targets, speed) {
    this.graph = graph;
    this.targets = targets;
    this.targetNodes = graph ? targets.map(([x, y]) => graph.nearestNode(x, y)) : [];
    this.speed = speed;
    for (const r of this.list) r.marker.remove();
    this.list = [];
    this.setPlayers(this.players);
  }

  setPlayers(players) {
    this.players = players;
    if (!this.targets.length) return;
    const wanted = players.slice(0, MAX_ON_MAP);
    for (const r of this.list.filter((r) => !wanted.some((p) => p.name === r.name))) r.marker.remove();
    this.list = this.list.filter((r) => wanted.some((p) => p.name === r.name));
    for (const p of wanted) if (!this.list.some((r) => r.name === p.name)) this.spawn(p);
  }

  spawn(p) {
    const k = Math.floor(Math.random() * this.targets.length);
    const [x, y] = this.targets[k];
    const pac = el("div", { class: "pac rival-pac" }, el("div", { class: "body" }));
    const icon = el("div", { class: "rival", style: `--pc:${p.color}` }, pac, el("span", { class: "rival-name" }, p.name));
    const r = {
      name: p.name,
      x, y, hx: 1, hy: 0,
      speed: this.speed[0] + Math.random() * (this.speed[1] - this.speed[0]),
      path: [],
      goal: null,
      restUntil: this.t + Math.random() * 2,
      pac,
      marker: L.marker(this.toLatLng(x, y), {
        icon: L.divIcon({ className: "rival-icon", html: icon, iconSize: [22, 22], iconAnchor: [11, 11] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 800,
      }).addTo(this.layer),
    };
    if (this.graph) r.walker = new Walker(this.graph, this.targetNodes[k]);
    this.list.push(r);
  }

  // Next street node towards the rival's current house; null = arrived, take a breather
  next(r, node) {
    if (this.t < r.restUntil) return null;
    if (!r.path.length) {
      if (r.goal === node) {
        r.goal = null;
        r.restUntil = this.t + 0.8 + Math.random() * 1.5;
        this.onArrive?.(r, this.toLatLng(this.graph.x[node], this.graph.y[node]));
        return null;
      }
      r.goal = this.targetNodes[Math.floor(Math.random() * this.targetNodes.length)];
      r.path = StreetGraph.path(this.graph.dijkstra(node).prev, r.goal).slice(1);
      if (!r.path.length) return null;
    }
    return r.path.shift();
  }

  update(dt) {
    this.t += dt;
    for (const r of this.list) {
      if (r.walker) {
        r.walker.advance(r.speed * dt, (node) => this.next(r, node));
        r.x = r.walker.x;
        r.y = r.walker.y;
        r.hx = r.walker.hx;
        r.hy = r.walker.hy;
      } else if (this.t >= r.restUntil) {
        r.goal = r.goal || this.targets[Math.floor(Math.random() * this.targets.length)];
        const dx = r.goal[0] - r.x, dy = r.goal[1] - r.y;
        const d = Math.hypot(dx, dy);
        if (d < 1) {
          this.onArrive?.(r, this.toLatLng(r.x, r.y));
          r.goal = null;
          r.restUntil = this.t + 0.8 + Math.random() * 1.5;
        } else {
          const step = Math.min(d, r.speed * dt);
          r.hx = dx / d;
          r.hy = dy / d;
          r.x += r.hx * step;
          r.y += r.hy * step;
        }
      }
      r.marker.setLatLng(this.toLatLng(r.x, r.y));
      const theta = (-Math.atan2(r.hy, r.hx) * 180) / Math.PI;
      const tf = r.hx < -0.01 ? `scaleX(-1) rotate(${(180 - theta).toFixed(0)}deg)` : `rotate(${theta.toFixed(0)}deg)`;
      if (tf !== r.tf) { r.pac.style.transform = tf; r.tf = tf; }
    }
  }

  clear() {
    for (const r of this.list) r.marker.remove();
    this.list = [];
    this.targets = [];
  }
}
