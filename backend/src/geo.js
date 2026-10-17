// Small geometry helpers shared by the API modules.

const EARTH_RADIUS = 6371000;
const M_PER_DEG_LAT = 111320;
const toRad = (d) => (d * Math.PI) / 180;

// Distance between two coordinates in meters (Haversine formula)
function distanceMeters(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS * Math.asin(Math.sqrt(a));
}

// Move a coordinate by a number of meters north and east
function offset(lat, lng, north, east) {
  return {
    lat: lat + north / M_PER_DEG_LAT,
    lng: lng + east / (M_PER_DEG_LAT * Math.cos(toRad(lat))),
  };
}

// Flat x/y meters around an origin. Accurate enough inside a neighbourhood.
function projector(lat0, lng0) {
  const kx = M_PER_DEG_LAT * Math.cos(toRad(lat0));
  return {
    toXY: (lat, lng) => [(lng - lng0) * kx, (lat - lat0) * M_PER_DEG_LAT],
    toLatLng: (x, y) => [lat0 + y / M_PER_DEG_LAT, lng0 + x / kx],
  };
}

const round = (v, digits = 6) => Number(v.toFixed(digits));
const isNum = (v) => typeof v === "number" && Number.isFinite(v);
const isLat = (v) => isNum(v) && v >= -90 && v <= 90;
const isLng = (v) => isNum(v) && v >= -180 && v <= 180;

module.exports = { distanceMeters, offset, projector, round, isNum, isLat, isLng, toRad, M_PER_DEG_LAT };
