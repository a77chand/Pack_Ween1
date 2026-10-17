// Ghosts that hunt Pac-Man through the real streets.
//
// Like the arcade, every ghost has its own target and they alternate between
// "scatter" (each heads for its own corner) and "chase". At each junction a
// ghost takes the street that is shortest to its target along the streets
// (a Dijkstra distance field, refreshed a few times a second), and it never
// turns back unless it hits a dead end. Frightened ghosts wander randomly and
// can be eaten; eaten ghosts race home as a pair of eyes.
// Without a street map they float straight towards their targets instead.
// In Walk mode they are harmless: they just wander for atmosphere, since nothing
// can really catch you in real life.

import { Walker } from "./streets.js";

const KINDS = [
  { name: "Banshee", color: "#ff3b5c", target: "chase", release: 0 },
  { name: "Ghoul", color: "#7cff4f", target: "ambush", release: 3 },
  { name: "Sheet", color: "#e8d9f5", target: "flank", release: 7 },
  { name: "Spook", color: "#ffc93c", target: "shy", release: 11 },
];

// Seconds of scatter, chase, scatter, chase... then chase for good
const PHASES = { arcade: [6, 20, 6, 20, 4], gps: [20, 60, 20] };

const svg = (color) => `
<div class="ghost-sprite" style="--c:${color}">
  <svg viewBox="0 0 28 30" aria-hidden="true">
    <path class="body" d="M2 28V13a12 12 0 0 1 24 0v15l-4-3-4 3-4-3-4 3-4-3z"/>
    <g class="eyes">
      <ellipse cx="9.5" cy="12.5" rx="3.6" ry="4.2" fill="#fff"/>
      <ellipse cx="18.5" cy="12.5" rx="3.6" ry="4.2" fill="#fff"/>
      <circle class="pupil" cx="9.5" cy="12.5" r="2"/>
      <circle class="pupil" cx="18.5" cy="12.5" r="2"/>
    </g>
    <path class="scared-face" d="M7 21l2.5-2 2.5 2 2-2 2 2 2.5-2 2.5 2"/>
    <g class="scared-eyes"><rect x="8" y="10" width="3" height="3"/><rect x="17" y="10" width="3" height="3"/></g>
  </svg>
</div>`;

export class Ghosts {
  // opts: { graph, toLatLng, layer, home:[x,y], corners:[[x,y]x4], mode, count, speeds, catchRadius, harmless, onCatch, onEat }
  constructor(opts) {
    Object.assign(this, opts);
    this.t = 0;
    this.frightUntil = -1;
    this.frightLength = 1;
    this.homeNode = this.graph ? this.graph.nearestNode(...this.home) : -1;
    this.homeField = this.graph ? this.graph.dijkstra(this.homeNode).dist : null;
    this.list = KINDS.slice(0, this.count).map((kind, i) => {
      const marker = L.marker(this.toLatLng(...this.home), {
        icon: L.divIcon({ className: "ghost-icon", html: svg(kind.color), iconSize: [28, 30], iconAnchor: [14, 15] }),
        interactive: false,
        keyboard: false,
        zIndexOffset: 900,
      }).addTo(this.layer);
      const g = { kind, i, marker, state: "house", releaseAt: kind.release, x: this.home[0], y: this.home[1], hx: 0, hy: -1, field: null, fieldNode: -1, fieldAt: -9 };
      if (this.graph) g.walker = new Walker(this.graph, this.homeNode);
      return g;
    });
  }

  phase() {
    const plan = PHASES[this.mode] || PHASES.arcade;
    let t = this.t;
    for (let k = 0; k < plan.length; k++) {
      if (t < plan[k]) return k % 2 === 0 ? "scatter" : "chase";
      t -= plan[k];
    }
    return "chase";
  }

  get frightened() { return this.t < this.frightUntil; }
  get frightLeft() { return Math.max(0, this.frightUntil - this.t); }

  frighten(seconds) {
    this.frightUntil = this.t + seconds;
    this.frightLength = seconds;
    for (const g of this.list) {
      if (g.state === "active" || g.state === "fright") {
        g.state = "fright";
        g.walker?.reverse(); // arcade rule: ghosts turn around when you power up
      }
    }
  }

  // Everyone back to the ghost house (after Pac-Man is caught)
  reset(delay = 1.5) {
    for (const g of this.list) {
      g.state = "house";
      g.releaseAt = this.t + delay + g.kind.release / 3;
      g.walker?.place(this.homeNode);
      [g.x, g.y] = this.home;
    }
  }

  targetFor(g, p) {
    if (g.state === "eaten") return this.home;
    const [cx, cy] = this.corners[g.i % this.corners.length];
    if (this.harmless || this.phase() === "scatter") return [cx, cy];
    const ahead = this.mode === "gps" ? 25 : 60;
    switch (g.kind.target) {
      case "ambush":
        return [p.x + p.hx * ahead, p.y + p.hy * ahead];
      case "flank": {
        const b = this.list[0];
        const ax = p.x + p.hx * ahead * 0.5, ay = p.y + p.hy * ahead * 0.5;
        return [2 * ax - b.x, 2 * ay - b.y];
      }
      case "shy":
        return Math.hypot(g.x - p.x, g.y - p.y) > (this.mode === "gps" ? 60 : 90) ? [p.x, p.y] : [cx, cy];
      default:
        return [p.x, p.y];
    }
  }

  // Distance field towards this ghost's target, refreshed a few times a second
  fieldFor(g, target) {
    if (g.state === "eaten") return this.homeField;
    if (this.t - g.fieldAt > 0.35 + g.i * 0.05) {
      const node = this.graph.nearestNode(target[0], target[1]);
      if (node !== g.fieldNode || this.t - g.fieldAt > 2) {
        g.field = this.graph.dijkstra(node).dist;
        g.fieldNode = node;
      }
      g.fieldAt = this.t;
    }
    return g.field;
  }

  choose(g, node, came, target) {
    const adj = this.graph.adj[node];
    let options = came == null ? adj : adj.filter((n) => n !== came);
    if (!options.length) options = adj; // dead end: turn around
    if (options.length === 1) return options[0];
    if (g.state === "fright" || this.harmless) return options[Math.floor(Math.random() * options.length)];
    const field = this.fieldFor(g, target);
    let best = options[0], bestD = Infinity;
    for (const n of options) {
      const d = field[n] + this.graph.len(node, n);
      if (d < bestD) { bestD = d; best = n; }
    }
    return best;
  }

  speedOf(g) {
    const s = this.speeds;
    if (g.state === "eaten") return s.eaten;
    if (g.state === "fright") return s.fright;
    return g.kind.target === "chase" ? s.chase * 1.06 : s.chase;
  }

  update(dt, player, canCatch) {
    this.t += dt;
    if (!this.frightened) for (const g of this.list) if (g.state === "fright") g.state = "active";

    for (const g of this.list) {
      if (g.state === "house") {
        if (this.t >= g.releaseAt) g.state = this.frightened ? "fright" : "active";
        else { this.draw(g); continue; }
      }
      const target = this.targetFor(g, player);
      const step = this.speedOf(g) * dt;
      if (g.walker) {
        g.walker.advance(step, (node, came) => this.choose(g, node, came, target));
        g.x = g.walker.x;
        g.y = g.walker.y;
        g.hx = g.walker.hx;
        g.hy = g.walker.hy;
      } else {
        // No street map: float towards the target (or away from Pac-Man when scared)
        let dx = target[0] - g.x, dy = target[1] - g.y;
        if (g.state === "fright") { dx = g.x - player.x; dy = g.y - player.y; }
        else if (this.harmless) { // drift around the ghost's own corner
          const w = this.t * 0.15 + g.i * 1.6;
          dx = target[0] + Math.cos(w) * 120 - g.x;
          dy = target[1] + Math.sin(w) * 120 - g.y;
        }
        const l = Math.hypot(dx, dy);
        if (l > 0.5) {
          const wobble = Math.sin(this.t * 2 + g.i * 1.7) * 0.35;
          const ux = dx / l, uy = dy / l;
          g.hx = ux - uy * wobble;
          g.hy = uy + ux * wobble;
          const hl = Math.hypot(g.hx, g.hy);
          g.hx /= hl; g.hy /= hl;
          g.x += g.hx * Math.min(step, l);
          g.y += g.hy * Math.min(step, l);
        }
      }

      if (g.state === "eaten" && Math.hypot(g.x - this.home[0], g.y - this.home[1]) < 4) {
        g.state = "house";
        g.releaseAt = this.t + 1.5;
      }

      const touching = !this.harmless && Math.hypot(g.x - player.x, g.y - player.y) < this.catchRadius;
      if (touching && g.state === "fright") {
        g.state = "eaten";
        this.onEat(g);
      } else if (touching && g.state === "active" && canCatch) {
        this.onCatch(g);
        this.reset(1.5); // everyone back to the ghost house, like losing a life
        return;
      }
      this.draw(g);
    }
  }

  draw(g) {
    g.marker.setLatLng(this.toLatLng(g.x, g.y));
    const el = g.marker.getElement();
    if (!el) return;
    const sprite = el.firstElementChild;
    const flash = g.state === "fright" && this.frightLeft < Math.min(2.5, this.frightLength * 0.3);
    const cls = `ghost-sprite ${g.state}${flash ? " flash" : ""}`;
    if (sprite.className !== cls) sprite.className = cls;
    sprite.style.setProperty("--ex", (g.hx * 1.6).toFixed(2));
    sprite.style.setProperty("--ey", (-g.hy * 1.6).toFixed(2));
  }

  destroy() {
    for (const g of this.list) g.marker.remove();
    this.list = [];
  }
}
