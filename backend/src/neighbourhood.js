// Which candy houses a run gets.
//
// Real volunteer houses near the player always count. Where there are fewer than
// MIN_REAL of them, the neighbourhood is filled with demo houses so the game can be
// played anywhere. Demo houses are generated (never stored): every spot on earth
// maps to an "anchor" on a ~280 m grid, so neighbours playing in the same area get
// the same houses and can race each other fairly. When the street map is known,
// demo houses sit on real buildings next to a street instead of in a lake.

const { distanceMeters, offset, projector, round, toRad } = require("./geo");

const NEAR_METERS = 500;
const MIN_REAL = 3;
const ANCHOR_DEG = 0.0025;
const SNAP_METERS = 45;          // how far a demo house may move to land on a building
const MAX_STREET_GAP = 22;       // a snapped house must be this close to a street

// [north, east] meters from the anchor, name, full-size bars (power-up)
const DEMO_SPOTS = [
  [50, 30, "Pumpkin Porch", 0],
  [-55, 40, "Witchy Way", 0],
  [35, -65, "Bat Cave", 0],
  [-45, -50, "Spooky Manor", 1],
  [95, -10, "Ghost Garden", 0],
  [-15, 100, "Candy Castle", 0],
  [130, 75, "Cauldron Corner", 0],
  [-120, -100, "Skeleton Shack", 0],
  [-150, 55, "Vampire Villa", 1],
  [115, -130, "Mummy Manor", 0],
  [20, 165, "Haunted Hut", 0],
  [-85, 160, "Zombie Lane", 0],
];

function anchorFor(lat, lng) {
  const aLat = Math.round(lat / ANCHOR_DEG) * ANCHOR_DEG;
  const step = ANCHOR_DEG / Math.cos(toRad(aLat));
  const aLng = Math.round(lng / step) * step;
  return { lat: round(aLat), lng: round(aLng) };
}

// Distance from a point to the nearest street segment (meters)
function streetGap(streets, toXY, x, y) {
  let best = Infinity;
  for (const [a, b] of streets.edges) {
    const [ax, ay] = toXY(...streets.nodes[a]);
    const [bx, by] = toXY(...streets.nodes[b]);
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / len2)) : 0;
    best = Math.min(best, Math.hypot(x - ax - t * dx, y - ay - t * dy));
  }
  return best;
}

function demoHouses(lat, lng, streets) {
  const anchor = anchorFor(lat, lng);
  const { toXY } = projector(anchor.lat, anchor.lng);
  const hasMap = streets && streets.nodes.length > 1;
  const used = [];
  return DEMO_SPOTS.map(([north, east, name, fullSize]) => {
    let spot = offset(anchor.lat, anchor.lng, north, east);
    if (hasMap) {
      const [sx, sy] = toXY(spot.lat, spot.lng);
      let best = null, bestScore = Infinity;
      for (const [blat, blng, home] of streets.buildings) {
        const [bx, by] = toXY(blat, blng);
        const d = Math.hypot(bx - sx, by - sy);
        if (d > SNAP_METERS) continue;
        if (used.some(([ux, uy]) => Math.hypot(ux - bx, uy - by) < 30)) continue;
        const score = d - (home ? 10 : 0);
        if (score < bestScore && streetGap(streets, toXY, bx, by) <= MAX_STREET_GAP) {
          best = { lat: blat, lng: blng, x: bx, y: by };
          bestScore = score;
        }
      }
      if (best) {
        spot = best;
        used.push([best.x, best.y]);
      }
    }
    return { name, lat: round(spot.lat), lng: round(spot.lng), fullSize: !!fullSize, demo: true };
  });
}

// Volunteer houses near a point, with how many different players have claimed them
function realHousesNear(db, lat, lng, radius = NEAR_METERS) {
  const dLat = radius / 111320;
  const dLng = radius / (111320 * Math.cos(toRad(lat)));
  const rows = db.prepare(`
    SELECT h.id, h.name, h.lat, h.lng, h.full_size, h.owner_id,
      (SELECT COUNT(DISTINCT r.player_id) FROM run_houses rh JOIN runs r ON r.id = rh.run_id
        WHERE rh.house_id = h.id AND rh.visited_at IS NOT NULL AND r.flagged = 0) AS claims,
      (SELECT COUNT(*) FROM house_reports hr WHERE hr.house_id = h.id) AS reports
    FROM houses h
    WHERE h.hidden = 0 AND h.lat BETWEEN ? AND ? AND h.lng BETWEEN ? AND ?
  `).all(lat - dLat, lat + dLat, lng - dLng, lng + dLng);
  return rows
    .map((h) => ({ ...h, distance: distanceMeters(lat, lng, h.lat, h.lng) }))
    .filter((h) => h.distance <= radius)
    .sort((a, b) => a.distance - b.distance);
}

const VERIFY_CLAIMS = 3;

function publicHouse(h, viewerId) {
  return {
    id: h.id,
    name: h.name,
    lat: h.lat,
    lng: h.lng,
    fullSize: !!h.full_size,
    claims: h.claims,
    verified: h.claims >= VERIFY_CLAIMS,
    mine: viewerId != null && h.owner_id === viewerId,
  };
}

// The list of candy houses for a run starting at lat/lng
function neighbourhood(db, lat, lng, streets, viewerId = null) {
  const real = realHousesNear(db, lat, lng).map((h) => ({ ...publicHouse(h, viewerId), ref: h.id, demo: false }));
  let list = real;
  if (real.length < MIN_REAL) {
    const demo = demoHouses(lat, lng, streets)
      .filter((d) => !real.some((r) => distanceMeters(r.lat, r.lng, d.lat, d.lng) < 30))
      .map((d) => ({ ...d, ref: null }));
    list = real.concat(demo);
  }
  return list;
}

const DEMO_NAMES = DEMO_SPOTS.map((s) => s[2]);

module.exports = { neighbourhood, realHousesNear, publicHouse, demoHouses, anchorFor, VERIFY_CLAIMS, NEAR_METERS, MIN_REAL, DEMO_NAMES };
