// Geometry helpers. The game simulates in flat x/y meters around the
// neighbourhood (x = east, y = north) and only converts to lat/lng for the map.

export const M_PER_DEG = 111320;
export const toRad = (d) => (d * Math.PI) / 180;

export function distance(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

export function projector(lat0, lng0) {
  const kx = M_PER_DEG * Math.cos(toRad(lat0));
  return {
    toXY: (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG],
    toLatLng: (x, y) => [lat0 + y / M_PER_DEG, lng0 + x / kx],
  };
}

export const hypot = Math.hypot;
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// Compass bearing in degrees (0 = north, 90 = east) of the vector dx, dy
export const bearingXY = (dx, dy) => ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
