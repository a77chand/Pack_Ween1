// The street network as a graph: the maze Pac-Man and the ghosts run on.

class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length;
    k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const top = v[0];
    const lastK = k.pop(), lastV = v.pop();
    if (k.length) {
      let i = 0;
      for (;;) {
        let c = 2 * i + 1;
        if (c >= k.length) break;
        if (c + 1 < k.length && k[c + 1] < k[c]) c++;
        if (k[c] >= lastK) break;
        k[i] = k[c]; v[i] = v[c]; i = c;
      }
      k[i] = lastK; v[i] = lastV;
    }
    return top;
  }
}

export class StreetGraph {
  constructor(data, proj) {
    this.x = [];
    this.y = [];
    this.adj = [];
    for (const [lat, lng] of data.nodes) {
      const [x, y] = proj.toXY(lat, lng);
      this.addNode(x, y);
    }
    for (const [a, b] of data.edges) this.link(a, b);
  }

  get size() { return this.x.length; }

  addNode(x, y) {
    this.x.push(x);
    this.y.push(y);
    this.adj.push([]);
    return this.x.length - 1;
  }

  link(a, b) {
    if (a === b || this.adj[a].includes(b)) return;
    this.adj[a].push(b);
    this.adj[b].push(a);
  }

  unlink(a, b) {
    this.adj[a] = this.adj[a].filter((n) => n !== b);
    this.adj[b] = this.adj[b].filter((n) => n !== a);
  }

  len(a, b) { return Math.hypot(this.x[b] - this.x[a], this.y[b] - this.y[a]); }

  // Unit vector from node a to node b
  dir(a, b) {
    const dx = this.x[b] - this.x[a], dy = this.y[b] - this.y[a];
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }

  nearestNode(x, y) {
    let best = 0, bestD = Infinity;
    for (let i = 0; i < this.x.length; i++) {
      const d = (this.x[i] - x) ** 2 + (this.y[i] - y) ** 2;
      if (d < bestD && this.adj[i].length) { bestD = d; best = i; }
    }
    return best;
  }

  // Closest point on any street: { a, b, t, px, py, d }
  nearestEdge(x, y) {
    let best = null;
    for (let a = 0; a < this.adj.length; a++) {
      for (const b of this.adj[a]) {
        if (b < a) continue;
        const ax = this.x[a], ay = this.y[a];
        const dx = this.x[b] - ax, dy = this.y[b] - ay;
        const l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / l2)) : 0;
        const px = ax + t * dx, py = ay + t * dy;
        const d = Math.hypot(x - px, y - py);
        if (!best || d < best.d) best = { a, b, t, px, py, d };
      }
    }
    return best;
  }

  // Put a node on the street at fraction t between a and b (reusing an end if close)
  split(a, b, t) {
    const l = this.len(a, b);
    if (t * l < 1.5) return a;
    if ((1 - t) * l < 1.5) return b;
    const n = this.addNode(this.x[a] + (this.x[b] - this.x[a]) * t, this.y[a] + (this.y[b] - this.y[a]) * t);
    this.unlink(a, b);
    this.link(a, n);
    this.link(n, b);
    return n;
  }

  // Make a point reachable: join it to the closest street with a short "driveway".
  // Returns the node standing at the point.
  attach(x, y) {
    const e = this.nearestEdge(x, y);
    if (!e) return this.addNode(x, y);
    const n = this.split(e.a, e.b, e.t);
    if (e.d < 3) return n;
    const m = this.addNode(x, y);
    this.link(n, m);
    return m;
  }

  // Shortest street distances from one node to all others
  dijkstra(src) {
    const n = this.size;
    const dist = new Float64Array(n).fill(Infinity);
    const prev = new Int32Array(n).fill(-1);
    const heap = new MinHeap();
    dist[src] = 0;
    heap.push(0, src);
    while (heap.size) {
      const u = heap.pop();
      const du = dist[u];
      for (const v of this.adj[u]) {
        const nd = du + this.len(u, v);
        if (nd < dist[v]) { dist[v] = nd; prev[v] = u; heap.push(nd, v); }
      }
    }
    return { dist, prev };
  }

  // Node list from the Dijkstra source to dst
  static path(prev, dst) {
    const out = [];
    for (let v = dst; v !== -1; v = prev[v]) out.push(v);
    return out.reverse();
  }
}

// Something moving along the streets: sits on the edge from -> to, a fraction t along.
// When from === to it is standing on a node.
export class Walker {
  constructor(graph, node) {
    this.g = graph;
    this.from = node;
    this.to = node;
    this.t = 0;
    this.hx = 1; // last heading (unit vector)
    this.hy = 0;
  }

  get x() { return this.g.x[this.from] + (this.g.x[this.to] - this.g.x[this.from]) * this.t; }
  get y() { return this.g.y[this.from] + (this.g.y[this.to] - this.g.y[this.from]) * this.t; }
  get moving() { return this.from !== this.to; }

  place(node) { this.from = this.to = node; this.t = 0; }

  reverse() {
    if (!this.moving) return;
    [this.from, this.to] = [this.to, this.from];
    this.t = 1 - this.t;
    this.hx = -this.hx;
    this.hy = -this.hy;
  }

  // Move dist meters. choose(node, cameFrom) picks the next node or returns null to stop.
  advance(dist, choose) {
    let guard = 0;
    while (dist > 1e-6 && guard++ < 200) {
      if (!this.moving) {
        const next = choose(this.to, null);
        if (next == null) return;
        this.from = this.to;
        this.to = next;
        this.t = 0;
      }
      const L = this.g.len(this.from, this.to) || 1e-3;
      [this.hx, this.hy] = this.g.dir(this.from, this.to);
      const left = (1 - this.t) * L;
      if (dist < left) {
        this.t += dist / L;
        return;
      }
      dist -= left;
      const at = this.to, came = this.from;
      const next = choose(at, came);
      this.from = at;
      this.t = 0;
      this.to = next == null ? at : next;
      if (next == null) return;
    }
  }
}
