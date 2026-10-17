# Pack_Ween Backend API

Express 5 server with SQLite storage (Node's built-in `node:sqlite`). It serves the game page from `public/` and the JSON API below.

## Run locally

```bash
cd backend
npm install
npm start      # http://localhost:4000 (or $PORT)
npm test
```

Data is stored in `$DATA_DIR/pack-ween.db` (default `backend/data/`). Set `OSM_DISABLED=1` to never call Overpass.

All POST bodies are JSON (`Content-Type: application/json`). Errors look like `{"error": "message"}`.

## Accounts

Endpoints marked 🔒 need `Authorization: Bearer <token>`, where the token comes from `POST /players`.

### `POST /players`
Sign up or sign in. A name nobody has used yet is claimed with the PIN you send; after that, the same name needs the same PIN.
```json
{"name": "Milo Moon", "pin": "4321"}
```
```json
{"token": "9f2c…64 hex chars", "created": true, "player": {"id": 1, "name": "Milo Moon"}}
```
- 400: the name must be 2-20 letters, numbers or spaces; the PIN must be 4-8 digits
- 401: the name is taken and the PIN doesn't match
- 429: too many attempts (20 a minute per IP; 5 wrong PINs per name in 10 minutes)

### `GET /players/me` 🔒
```json
{"id": 1, "name": "Milo Moon",
 "stats": {"runs": 3, "candy": 27, "ghosts": 4, "meters": 5120, "best": {"houses": 12, "seconds": 151, "mode": "arcade"}},
 "activeRun": {"runId": 7, "mode": "gps", "startTime": 1791661597217},
 "houses": [{"id": 2, "name": "Maple St porch", "lat": 43.47, "lng": -80.54, "fullSize": true}]}
```
`activeRun` is an unfinished run you can resume. Runs left idle for 3 hours are closed automatically.

## Map data

### `GET /neighbourhood?lat=&lng=`
Candy houses around a point. Without `lat`/`lng` you get the default demo neighbourhood (Waterloo).

Volunteer houses within 500 m always count. If there are fewer than 3 of them, 12 generated **demo houses** fill the area. Demo houses are anchored to a ~280 m grid, so everyone nearby gets the same ones. When the street map is known, each one is moved onto a real building next to a street.
```json
{"center": {"lat": 43.4723, "lng": -80.5449}, "isDefault": true, "streets": "ready",
 "houses": [{"id": null, "name": "Spooky Manor", "lat": 43.472096, "lng": -80.546469, "fullSize": true, "demo": true}]}
```
`id` is the volunteer house id, or null for a demo house. `streets` is `ready`, `pending` or `failed`.

### `GET /streets?lat=&lng=`
The street graph used as the Pac-Man maze: OpenStreetMap streets and footpaths (not sidewalks), largest connected piece only, with straight stretches simplified.
- **200**: `{"v": 1, "lat": …, "lng": …, "nodes": [[lat, lng], …], "edges": [[a, b], …], "buildings": [[lat, lng, isHome], …]}`
- **202**: `{"status": "pending"}`, still downloading from Overpass (often 20-40 s); poll again
- **503**: Overpass is unavailable right now (retried after 2 minutes)

Maps are cached per 0.005° cell in SQLite. Pre-baked maps in `osm/` are used within 300 m of their centre.

## Volunteer houses

### `GET /houses?lat=&lng=&radius=`
Visible volunteer houses within `radius` meters (default 500, max 10000). Without `lat`/`lng`: the 200 newest.
```json
[{"id": 2, "name": "Maple St porch", "lat": 43.4731, "lng": -80.544, "fullSize": true, "claims": 3, "verified": true, "mine": false, "distance": 41}]
```
`claims` is how many different players have collected candy there in runs that weren't flagged. A house is `verified` at 3.

### `POST /houses` 🔒
```json
{"name": "Maple St porch", "lat": 43.4731, "lng": -80.5440, "fullSize": true}
```
Returns 201 with the house. `fullSize` makes it a power-up house.
- 400: the name must be 2-40 characters, or you already host 3 houses
- 409: there's already a candy house within 15 m

### `DELETE /houses/:id` 🔒
Only the host can remove a house. Returns `{"deleted": 2}`.

### `POST /houses/:id/report` 🔒
"No candy here." Send your position; you must be within 60 m of the house.
```json
{"lat": 43.4731, "lng": -80.5441}
```
```json
{"reports": 3, "hidden": false}
```
A house is hidden once it has at least 3 reports and the reports outnumber its claims.

## Runs

### `POST /runs/start` 🔒
```json
{"mode": "arcade", "lat": 43.4727, "lng": -80.5455}
```
`mode` is `gps` (Walk · Ranked) or `arcade`. The run's candy houses are fixed at this point and returned with run-local ids. Starting a new run closes any unfinished one.
```json
{"runId": 7, "mode": "arcade", "startTime": 1791661597217, "ended": false, "flagged": false, "strikes": 0,
 "penalty": 0, "bonus": 0, "ghosts": 0, "spooks": 0, "last": {"lat": 43.4727, "lng": -80.5455}, "streets": "ready",
 "houses": [{"id": 1, "name": "Pumpkin Porch", "lat": 43.47, "lng": -80.54, "fullSize": false, "demo": true, "ref": null, "visited": false}]}
```

### `GET /runs/:id` 🔒
The same state plus `seconds` elapsed, for resuming. You can only read your own runs (others get 404).

### `POST /runs/:id/ping` 🔒
Your position every couple of seconds while playing.
```json
{"lat": 43.4729, "lng": -80.5452}
```
```json
{"ok": true, "strikes": 0, "flagged": false, "cooldown": 0}
```

### `POST /runs/:id/visit` 🔒
Claim a house's candy. Send the run-local house id and your position; you must be within **25 m**.
```json
{"houseId": 1, "lat": 43.47338, "lng": -80.54440}
```
```json
{"visited": 4, "remaining": 8, "total": 12, "power": false, "ok": true, "strikes": 0, "flagged": false, "cooldown": 0}
```
`power` is true when this claim was a full-size-bar house. Claiming the same house twice is fine; it just isn't counted again.
- 400 `{"error": "too far from house", "distanceMeters": 87}`
- 429: candy claims are paused after moving impossibly fast (see below)

### Anti-cheat
Every ping and visit passes through a speed check. Each run has a movement budget that refills at the mode's top speed: 7 m/s walking, about 30 m/s arcade. Leftover budget is capped at a small slack (40 m / 30 m) to absorb GPS jitter, so standing still doesn't bank speed, and pinging more often doesn't help. Moving further than the budget allows:

1. adds a strike,
2. pauses candy claims for 20 seconds,
3. accepts the new position, so one bad GPS fix doesn't snowball.

Five strikes flag the run. Flagged runs never appear on leaderboards and don't count towards house verification.

### `POST /runs/:id/event` 🔒
```json
{"type": "spooked"}
```
`spooked` means a ghost caught you: +10 seconds. `ghost` means you ate a ghost: −5 seconds. Eating only counts within the power-up window after claiming a full-size-bar house (11 s arcade, 35 s walking), and only up to 4 ghosts per power-up. Returns `{"penalty": 10, "bonus": 5}`.

### `POST /runs/:id/finish` 🔒
```json
{"houses": 9, "total": 12, "seconds": 146, "rawSeconds": 151, "penalty": 0, "bonus": 5,
 "ghosts": 1, "spooks": 0, "meters": 1830, "mode": "arcade", "flagged": false, "strikes": 0}
```
`seconds` is the ranked time: `rawSeconds + penalty − bonus`.

## Leaderboards, routes and chat

### `GET /leaderboard?scope=&mode=&lat=&lng=`
`scope` is `street` (300 m), `district` (3 km), `city` (25 km) or `world` (default); local scopes need `lat`/`lng` and match runs that **started** that close. `mode` is `gps` (default) or `arcade`. Each player's best finished, unflagged run with at least one candy counts, ranked by most candy, then lowest `seconds`.
```json
{"scope": "street", "mode": "arcade", "count": 2,
 "rows": [{"rank": 1, "player": "Milo Moon", "houses": 12, "total": 12, "seconds": 146, "ghosts": 1, "runId": 7, "me": true}],
 "me": {"rank": 1, "player": "Milo Moon", …}}
```
`me` is your own entry (send your token), even when you're outside the top 20.

### `GET /route?lat=&lng=&runId=`
Walking order through a run's unvisited houses (or the neighbourhood's houses without `runId`): nearest-neighbour, then 2-opt. Straight-line distances; the game redoes this along streets.
```json
{"totalMeters": 1240, "stops": [{"id": 7, "name": "Witchy Way", "lat": 43.4746, "lng": -80.5434, "legMeters": 161}]}
```

### `GET /chat?lat=&lng=`
Last 50 messages posted within 5 km (or anywhere, without `lat`/`lng`).
```json
[{"id": 1, "player": "Milo Moon", "text": "Vampire Villa has full-size bars!", "time": 1791664053703}]
```

### `POST /chat` 🔒
```json
{"text": "Hi!", "lat": 43.4723, "lng": -80.5449}
```
`text` is required (max 300 characters). One message per 1.5 s per player.

### Unknown routes
404 `{"error": "not found"}`
