# 🎃 Pack_Ween

**Pac-Man on your real streets.** Trick-or-treat around your actual neighbourhood, collect candy from volunteer houses, dodge ghosts that hunt you through the streets, and race your neighbours up the leaderboard.

**▶ Play it live: https://pack-ween.onrender.com**
<sub>Hosted on Render's free tier and kept awake by a scheduled ping, so it should load straight away. If it ever does sleep, the first load takes 20–60 seconds.</sub>

![Pack_Ween gameplay: a pumpkin Pac-Man on a dark street map, candy houses with claim rings, four coloured ghosts and a trail of Pac-dots along the streets](docs/screenshot.jpg)

## How it works

The streets around you become a Pac-Man maze. The game downloads your neighbourhood's real street network from OpenStreetMap and turns it into a graph: in **Arcade** mode Pac-Man runs along the actual roads and footpaths, turning at real intersections. Houses handing out candy show up as 🏠🍬. Get within **25 m** of one and the server checks your position before the candy counts.

Four ghosts chase you along the same streets. Each has its own Pac-Man personality, and they switch between scattering to their corners and hunting you. A 🍫 **full-size-bar house** is a power-up: the ghosts turn purple and run, and you can eat them.

Play it two ways:

- 🕹️ **Arcade:** arrow keys, WASD or the on-screen D-pad, from anywhere.
- 🚶 **Walk · Ranked:** your real GPS. You physically walk to the houses, and the run goes on a separate ranked leaderboard that the server protects with speed checks.

## Features

- 🗺️ **Real streets as the maze.** Streets and footpaths from OpenStreetMap are compacted into a graph (largest connected piece only, straight stretches simplified). Every candy house gets a "driveway" onto it, so every house is reachable.
- 👻 **Ghost AI.** Banshee chases you directly, Ghoul cuts you off ahead, Sheet flanks you with Banshee, and Spook loses its nerve up close. At each junction a ghost takes the street that is shortest to its target, using a Dijkstra distance field refreshed a few times a second. It never turns back except at a dead end.
- 🍫 **Power-ups.** Full-size-bar houses frighten the ghosts; eat one for **−5 s**. A ghost that catches you costs **+10 s**.
- 🧭 **Route planner.** It finds the shortest street distance between every pair of houses, starts from a nearest-neighbour route, then improves it with 2-opt. The result is drawn as Pac-dots along the streets, and you eat them as you go.
- 🛡️ **Anti-cheat.** The server tracks a movement budget for each run that refills at walking or running speed. Teleporting or driving earns strikes and pauses candy claims, and five strikes flag the run so it stays off the leaderboard.
- 👤 **Accounts with a name and PIN.** Names are unique and protected. PINs are hashed with scrypt, and wrong PINs are rate-limited.
- 🏠 **Volunteer houses with real verification.** Anyone can pin their house where they're standing. A house gets a ✓ once three different players have collected candy there. Players standing at a house can report it as "no candy here", and a house is hidden when reports outnumber real visits.
- 🏆 **Local leaderboards.** Street (300 m), district (3 km), city (25 km) or world, based on where each run started. Each player's best run counts, ranked by most candy, then fastest time. Ranked and arcade boards are separate.
- 💾 **Saved in SQLite.** Accounts, runs, houses and chat are kept in Node's built-in `node:sqlite`, so there's nothing extra to install.
- ↩️ **Resume.** Reload or lose signal mid-run and you can pick up where you left off.
- 💬 **Neighbourhood chat** for messages within 5 km, with an unread badge.
- 🔊 **Retro sound effects** synthesised with the Web Audio API, plus vibration on phones and a screen wake lock while you walk.

## How to play

1. Open **https://pack-ween.onrender.com** and allow location access. Without it you get the demo neighbourhood in Waterloo.
2. Enter a name and a 4-digit PIN. A new name is claimed for you, and returning players use the same PIN.
3. Pick **Arcade** or **Walk · Ranked**, then **Start trick-or-treating**.
4. Collect every 🏠🍬. **🍬 Find** draws a green line to the nearest one and **🧭 Route** lays Pac-dots through all of them.
5. Grab a 🍫 house to turn the tables on the ghosts.
6. Collect everything, or tap **🏁 End**, to see your stats and the leaderboard. Share your score or chat with neighbours.

To hand out candy, tap **🏠 Hand out candy** on the start screen while standing at your door.

If nobody near you is handing out candy yet, the game fills the area with 12 demo houses. Players in the same area get the same demo houses, so they can race each other fairly.

## Tech stack

| Part | Built with |
|---|---|
| Backend | Node.js 22.13+, Express 5, SQLite (`node:sqlite`) |
| Game | Vanilla JavaScript modules (no build step), [Leaflet](https://leafletjs.com/) |
| Street data | [OpenStreetMap](https://www.openstreetmap.org/) via the [Overpass API](https://overpass-api.de/), cached per area |
| Map tiles | Esri World Street Map, with OpenStreetMap France as a backup |
| Tests | `node:test`: API, anti-cheat, house verification, route planning, street maze and ghost AI |
| Hosting | Render (free web service) |

## Run it locally

Needs [Node.js](https://nodejs.org/) 22.13 or newer.

```bash
cd backend
npm install
npm start        # http://localhost:4000
npm test         # 14 tests
```

| Environment variable | Default | What it does |
|---|---|---|
| `PORT` | `4000` | Port to listen on |
| `DATA_DIR` | `backend/data` | Where the SQLite database is kept |
| `OSM_DISABLED` | unset | Set to `1` to never call Overpass (only baked maps work, other places play in free-roam mode) |

Overpass often takes 20–40 seconds for a new area, so each map is fetched once, cached in SQLite, and the game lets you roam freely until it arrives. The default Waterloo neighbourhood ships pre-baked in `backend/osm/` so it loads instantly. To bake another area: `npm run bake-osm -- <lat> <lng> <name>`.

## API

The backend serves the game and a JSON API. Full request and response examples are in [backend/README.md](backend/README.md).

| Method | Path | What it does |
|---|---|---|
| GET | `/health` | Health check |
| POST | `/players` | Sign up or sign in with a name and PIN, returns a token |
| GET | `/players/me` | Your stats, hosted houses and any unfinished run |
| GET | `/neighbourhood?lat=&lng=` | Candy houses around a point (demo houses fill empty areas) |
| GET | `/streets?lat=&lng=` | Street graph for the maze (202 while it's still being fetched) |
| GET | `/houses?lat=&lng=&radius=` | Volunteer houses, with claims and verified status |
| POST | `/houses` | Pin your house (signed in) |
| DELETE | `/houses/:id` | Remove your house |
| POST | `/houses/:id/report` | "No candy here" (you must be within 60 m) |
| POST | `/runs/start` | Start a run (`mode`: `gps` or `arcade`) |
| GET | `/runs/:id` | Run state, used to resume |
| POST | `/runs/:id/ping` | Position update for the speed check |
| POST | `/runs/:id/visit` | Claim a house's candy |
| POST | `/runs/:id/event` | Caught by a ghost (+10 s) or ate one during a power-up (−5 s) |
| POST | `/runs/:id/finish` | End a run |
| GET | `/leaderboard?scope=&mode=&lat=&lng=` | Best run per player near you |
| GET | `/route?lat=&lng=&runId=` | Suggested walking order through the remaining houses |
| GET / POST | `/chat` | Read and post neighbourhood chat |

## Project structure

```
backend/
  server.js             Starts the server: database, street maps, app
  src/
    app.js              Express routes: accounts, runs, houses, leaderboards, chat
    anticheat.js        Speed checks: movement budget, strikes, cooldowns, flags
    neighbourhood.js    Which houses a run gets; demo houses snapped to real buildings
    osm.js              Overpass fetching, street-graph compaction, caching
    route.js            Nearest-neighbour + 2-opt route planning
    db.js               SQLite schema
  public/
    index.html, style.css
    js/main.js          Game flow, HUD, claims, results, chat, hosting
    js/streets.js       Street graph, Dijkstra, the Walker that moves along streets
    js/ghosts.js        Ghost AI
    js/route.js         Street routes and Pac-dots
    js/sound.js         Web Audio sound effects
  osm/waterloo.json     Pre-baked street map for the demo neighbourhood
  scripts/bake-osm.js   Bake a street map for another area
  test/                 node:test suites
front_end/              React + Vite UI prototype from the hackathon frontend team
docs/screenshot.jpg     Screenshot used in this README
```

## Done since the hackathon

The original version listed these as next steps. They're all done now:

- ~~Data resets on restart~~ → stored in **SQLite**.
- ~~Location can be faked~~ → **server-side speed checks** with strikes, claim cooldowns and flagged runs.
- ~~Demo mode is only for trying it out~~ → **Arcade** has its own leaderboard, and **Walk · Ranked** is GPS only.
- ~~No accounts, houses unverified~~ → **name + PIN accounts**, and houses are **verified by real visits** and can be **reported**.
- ~~Ghosts are just decoration~~ → ghosts **chase you along the streets** and can be **eaten**.
- ~~Leaderboard "zones" were just labels~~ → leaderboards are **geographic**: street, district, city or world.
- ~~Route went through every house in the database~~ → the route only covers **your run's houses**, **along real streets**.

## Limitations

- **The free hosting plan wipes its disk on every deploy,** so the live demo's data resets when new code ships. Pointing `DATA_DIR` at a persistent disk fixes it on any paid host.
- **A new area's street map can take up to a minute** to arrive from Overpass the first time. Until then you can roam freely, and after that it's cached.
- **Speed checks catch teleporting and driving, not a careful spoofer** who fakes a believable walking path. Ghost encounters are reported by the browser and limited by the server, but not proven.
- **Demo houses are generated,** so in areas without volunteers they sit on real buildings, but nobody there is actually handing out candy.

## Team

Built at ElleHacks by a team of four.

- Anusha Chandra: backend
- Homaira Hotak: backend
- Urooj Ahmed: frontend
- Sofia Pimenovsky: frontend

## Credits

Map and street data © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors (ODbL), fetched through the [Overpass API](https://overpass-api.de/). Map tiles © Esri. Map library: [Leaflet](https://leafletjs.com/). Font: [Press Start 2P](https://fonts.google.com/specimen/Press+Start+2P).
