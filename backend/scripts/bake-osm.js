// Pre-bake a street map so a neighbourhood loads instantly (no Overpass wait).
//
//   node scripts/bake-osm.js <lat> <lng> <name> [saved-overpass.json]
//
// Writes backend/osm/<name>.json. Without a saved file it downloads from Overpass.

const fs = require("fs");
const path = require("path");
const { compact, fetchOverpass, RADIUS } = require("../src/osm");

async function main() {
  const [latArg, lngArg, name, saved] = process.argv.slice(2);
  const lat = Number(latArg), lng = Number(lngArg);
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !name) {
    console.error("usage: node scripts/bake-osm.js <lat> <lng> <name> [saved-overpass.json]");
    process.exit(1);
  }
  const json = saved
    ? JSON.parse(fs.readFileSync(saved, "utf8"))
    : await fetchOverpass(lat, lng, RADIUS);
  const data = compact(json, lat, lng);
  const out = path.join(__dirname, "..", "osm", `${name}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(data));
  console.log(`${out}: ${data.nodes.length} nodes, ${data.edges.length} edges, ${data.buildings.length} buildings, ${(fs.statSync(out).size / 1024).toFixed(0)} KB`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
