// Planning the walk through the remaining houses, along real streets when the
// street map is loaded: shortest street distance between every pair of stops
// (Dijkstra), nearest-neighbour order, then 2-opt until no swap helps.

import { StreetGraph } from "./streets.js";

function orderStops(D) {
  const n = D.length;
  const order = [0];
  const used = new Set([0]);
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    for (let j = 1; j < n; j++) if (!used.has(j) && (best < 0 || D[last][j] < D[last][best])) best = j;
    order.push(best);
    used.add(best);
  }
  for (let improved = true, rounds = 0; improved && rounds < 50; rounds++) {
    improved = false;
    for (let i = 1; i < n - 1; i++) {
      for (let k = i + 1; k < n; k++) {
        const a = order[i - 1], b = order[i], c = order[k], d = k + 1 < n ? order[k + 1] : -1;
        const before = D[a][b] + (d >= 0 ? D[c][d] : 0);
        const after = D[a][c] + (d >= 0 ? D[b][d] : 0);
        if (after < before - 0.01) {
          order.splice(i, k - i + 1, ...order.slice(i, k + 1).reverse());
          improved = true;
        }
      }
    }
  }
  return order.slice(1).map((i) => i - 1);
}

// start: [x, y]; stops: [{ x, y, node }]. Returns { order, path: [[x,y]...], meters }
export function planRoute(graph, start, startNode, stops) {
  if (!stops.length) return { order: [], path: [], meters: 0 };
  if (!graph) {
    const pts = [start, ...stops.map((s) => [s.x, s.y])];
    const D = pts.map((a) => pts.map((b) => Math.hypot(a[0] - b[0], a[1] - b[1])));
    const order = orderStops(D);
    const path = [start, ...order.map((i) => [stops[i].x, stops[i].y])];
    return { order, path, meters: sumPath(path) };
  }
  const nodes = [startNode, ...stops.map((s) => s.node)];
  const runs = nodes.map((n) => graph.dijkstra(n));
  const D = nodes.map((_, i) => nodes.map((m) => runs[i].dist[m]));
  const order = orderStops(D);
  const path = [start];
  let from = 0;
  for (const i of order) {
    for (const v of StreetGraph.path(runs[from].prev, nodes[i + 1])) path.push([graph.x[v], graph.y[v]]);
    from = i + 1;
  }
  return { order, path, meters: sumPath(path) };
}

export function sumPath(path) {
  let m = 0;
  for (let i = 1; i < path.length; i++) m += Math.hypot(path[i][0] - path[i - 1][0], path[i][1] - path[i - 1][1]);
  return m;
}

// Evenly spaced points along a path: the Pac-dots
export function sampleDots(path, spacing) {
  const dots = [];
  let carry = spacing / 2;
  for (let i = 1; i < path.length; i++) {
    const [ax, ay] = path[i - 1], [bx, by] = path[i];
    const len = Math.hypot(bx - ax, by - ay);
    let d = carry;
    while (d <= len) {
      dots.push([ax + ((bx - ax) * d) / len, ay + ((by - ay) * d) / len]);
      d += spacing;
    }
    carry = d - len;
  }
  return dots;
}
