// The arcade look: a canvas between the map tiles and the sprites that draws
// the streets as glowing neon maze corridors, Pac-dots on every street, glowing
// candy houses, drifting mist, fog of war around Pac-Man and lightning flashes.

export class FxLayer {
  constructor(map) {
    this.map = map;
    const pane = map.createPane("fx");
    pane.style.zIndex = 390; // above tiles (200), below shapes (400) and markers (600)
    pane.style.pointerEvents = "none";
    this.canvas = L.DomUtil.create("canvas", "fx-canvas", pane);
    this.ctx = this.canvas.getContext("2d");
    this.edges = [];     // [[latlngA, latlngB]]
    this.dots = [];      // { x, y, ll, eaten }
    this.houses = [];    // { ll, visited }
    this.flash = 0;
    this.nextFlash = 15 + Math.random() * 20;
    this.mist = Array.from({ length: 22 }, () => ({ x: Math.random(), y: Math.random(), r: 80 + Math.random() * 140, v: 0.004 + Math.random() * 0.01 }));
    map.on("zoomstart", () => { this.canvas.style.visibility = "hidden"; });
    map.on("zoomend", () => { this.canvas.style.visibility = ""; });
  }

  setStreets(graph, toLatLng) {
    this.edges = [];
    if (!graph) return;
    const ll = graph.x.map((x, i) => toLatLng(x, graph.y[i]));
    for (let a = 0; a < graph.size; a++) for (const b of graph.adj[a]) if (b > a) this.edges.push([ll[a], ll[b]]);
  }

  // Pac-dots every `spacing` meters along every street near the candy
  makeDots(graph, toLatLng, box, spacing = 14) {
    this.dots = [];
    this.grid = null;
    if (!graph) return this.dots;
    for (let a = 0; a < graph.size; a++) {
      for (const b of graph.adj[a]) {
        if (b < a) continue;
        const ax = graph.x[a], ay = graph.y[a], bx = graph.x[b], by = graph.y[b];
        const len = Math.hypot(bx - ax, by - ay);
        for (let d = spacing / 2; d < len; d += spacing) {
          const x = ax + ((bx - ax) * d) / len, y = ay + ((by - ay) * d) / len;
          if (x < box[0] || x > box[1] || y < box[2] || y > box[3]) continue;
          this.dots.push({ x, y, ll: toLatLng(x, y), eaten: false });
        }
      }
    }
    // a grid so eating is a lookup, not a scan of thousands of dots
    this.grid = new Map();
    for (const d of this.dots) {
      const k = `${Math.floor(d.x / 20)},${Math.floor(d.y / 20)}`;
      if (!this.grid.has(k)) this.grid.set(k, []);
      this.grid.get(k).push(d);
    }
    return this.dots;
  }

  // Eat every dot within r meters of x, y; returns how many
  eat(x, y, r = 7) {
    if (!this.grid) return 0;
    let n = 0;
    const cx = Math.floor(x / 20), cy = Math.floor(y / 20);
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) {
      for (const d of this.grid.get(`${cx + i},${cy + j}`) || []) {
        if (!d.eaten && Math.hypot(d.x - x, d.y - y) < r) { d.eaten = true; n++; }
      }
    }
    return n;
  }

  setHouses(houses) { this.houses = houses; }

  draw(dt, { pac, fog, powered, t }) {
    const map = this.map, ctx = this.ctx, c = this.canvas;
    const size = map.getSize();
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    if (c.width !== size.x * dpr || c.height !== size.y * dpr) {
      c.width = size.x * dpr;
      c.height = size.y * dpr;
      c.style.width = `${size.x}px`;
      c.style.height = `${size.y}px`;
    }
    L.DomUtil.setPosition(c, map.containerPointToLayerPoint([0, 0]));
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, size.x, size.y);
    const P = (ll) => map.latLngToContainerPoint(ll);
    const on = (p) => p.x > -40 && p.y > -40 && p.x < size.x + 40 && p.y < size.y + 40;
    const zoomK = Math.pow(2, map.getZoom() - 17);

    // Neon maze: a wide soft glow, then a bright core
    if (this.edges.length) {
      ctx.beginPath();
      for (const [a, b] of this.edges) {
        const pa = P(a), pb = P(b);
        if (!on(pa) && !on(pb)) continue;
        ctx.moveTo(pa.x, pa.y);
        ctx.lineTo(pb.x, pb.y);
      }
      ctx.lineCap = "round";
      ctx.lineJoin = "round";
      const hue = powered ? "139, 61, 255" : "111, 60, 255";
      ctx.strokeStyle = `rgba(${hue}, 0.22)`;
      ctx.lineWidth = 14 * zoomK;
      ctx.stroke();
      ctx.strokeStyle = `rgba(${hue}, 0.45)`;
      ctx.lineWidth = 6 * zoomK;
      ctx.stroke();
      ctx.strokeStyle = powered ? "rgba(214, 179, 255, 0.95)" : "rgba(190, 160, 255, 0.85)";
      ctx.lineWidth = 1.6;
      ctx.stroke();
    }

    // Pac-dots
    if (this.dots.length && zoomK > 0.35) {
      ctx.fillStyle = "#ffe6b8";
      ctx.shadowColor = "#ffb347";
      ctx.shadowBlur = 6;
      ctx.beginPath();
      const r = Math.max(1.8, 3 * Math.min(1.5, zoomK));
      for (const d of this.dots) {
        if (d.eaten) continue;
        const p = P(d.ll);
        if (!on(p)) continue;
        ctx.moveTo(p.x + r, p.y);
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      }
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Candy houses glow like jack-o'-lanterns, flickering
    for (const h of this.houses) {
      if (h.visited) continue;
      const p = P(h.ll);
      if (!on(p)) continue;
      const flicker = 0.75 + 0.25 * Math.sin(t * 9 + h.ll.lat * 1e5) * Math.sin(t * 5.3 + h.ll.lng * 1e5);
      const g = ctx.createRadialGradient(p.x, p.y, 2, p.x, p.y, 46 * zoomK);
      g.addColorStop(0, `rgba(255, 140, 40, ${0.45 * flicker})`);
      g.addColorStop(1, "rgba(255, 117, 24, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(p.x - 50 * zoomK, p.y - 50 * zoomK, 100 * zoomK, 100 * zoomK);
    }

    // Drifting mist
    for (const m of this.mist) {
      m.x += m.v * dt;
      if (m.x > 1.2) m.x = -0.2;
      const x = m.x * size.x, y = m.y * size.y + Math.sin(t * 0.3 + m.r) * 20;
      const g = ctx.createRadialGradient(x, y, 0, x, y, m.r);
      g.addColorStop(0, "rgba(220, 200, 255, 0.05)");
      g.addColorStop(1, "rgba(220, 200, 255, 0)");
      ctx.fillStyle = g;
      ctx.fillRect(x - m.r, y - m.r, m.r * 2, m.r * 2);
    }

    // Fog of war: darkness everywhere except a lantern circle around Pac-Man
    if (fog && pac) {
      const p = P(pac);
      const R = Math.max(size.x, size.y) * 0.32;
      ctx.save();
      ctx.fillStyle = "rgba(6, 1, 12, 0.7)";
      ctx.fillRect(0, 0, size.x, size.y);
      ctx.globalCompositeOperation = "destination-out";
      const g = ctx.createRadialGradient(p.x, p.y, R * 0.35, p.x, p.y, R);
      g.addColorStop(0, "rgba(0,0,0,1)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(p.x - R, p.y - R, R * 2, R * 2);
      ctx.restore();
    }

    // Lightning: a white flash every 15-35 seconds
    this.nextFlash -= dt;
    if (this.nextFlash <= 0) {
      this.flash = 1;
      this.nextFlash = 15 + Math.random() * 20;
      this.onFlash?.();
    }
    if (this.flash > 0) {
      const a = this.flash > 0.7 ? 0.35 : this.flash > 0.5 ? 0.05 : this.flash * 0.4;
      ctx.fillStyle = `rgba(235, 225, 255, ${a})`;
      ctx.fillRect(0, 0, size.x, size.y);
      this.flash -= dt * 2.2;
    }
  }
}
