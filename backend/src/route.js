// Walking order through the remaining houses: nearest-neighbour to get a decent
// first route, then 2-opt (untangle any two crossing legs) until nothing improves.
// The game redoes this along real streets once the street map has loaded.

const { distanceMeters } = require("./geo");

function planRoute(start, stops) {
  const pts = [start, ...stops];
  const n = pts.length;
  const D = pts.map((a) => pts.map((b) => distanceMeters(a.lat, a.lng, b.lat, b.lng)));

  const order = [0];
  const used = new Set([0]);
  while (order.length < n) {
    const last = order[order.length - 1];
    let best = -1;
    for (let j = 1; j < n; j++) if (!used.has(j) && (best < 0 || D[last][j] < D[last][best])) best = j;
    order.push(best);
    used.add(best);
  }

  // 2-opt on an open path that must start at the player
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

  let total = 0;
  const route = order.slice(1).map((idx, k) => {
    const leg = D[order[k]][idx];
    total += leg;
    return { ...stops[idx - 1], legMeters: Math.round(leg) };
  });
  return { totalMeters: Math.round(total), stops: route };
}

module.exports = { planRoute };
