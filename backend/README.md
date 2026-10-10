# Pack_Ween Backend API

Express server. All data is **in memory**, so it resets when the server restarts.

## Run locally

```bash
cd backend
npm install
npm start
```

Server: `http://localhost:4000` (or the `PORT` env variable if set).

All POST bodies are JSON (`Content-Type: application/json`). Errors look like `{"error": "message"}`.

## Important: visit radius

`POST /runs/:id/visit` needs the player's current `lat` and `lng`. A house only counts if the player is within **`VISIT_RADIUS_METERS` = 25 m** of it (constant at the top of `server.js`).

The 10 seed houses have fixed coordinates within about 300 m of `CENTER` (lat 43.4723, lng -80.5449). To move the demo, change `CENTER` at the top of `server.js`.

## Endpoints

### `GET /`
Serves the game page (`backend/public/index.html`).

### `GET /health`
Health check. Response: `{"status":"ok"}`

### `GET /houses`
All houses.
```json
[{"id":1,"name":"House 1","lat":43.473378,"lng":-80.544405}, ...]
```
Optional nearby filter: `GET /houses?lat=43.4723&lng=-80.5449&radius=150` returns only houses within `radius` meters. If you use the filter, send all three params.

### `POST /houses`
Body: `{"name":"Maple St House","lat":43.4731,"lng":-80.5440}`
`name` must be non-empty and `lat`/`lng` must be numbers, otherwise you get 400.
```json
{"id":11,"name":"Maple St House","lat":43.4731,"lng":-80.544}
```

### `POST /runs/start`
Body: `{"player":"amy","zone":"street"}`. Both fields are optional; they default to `"anon"` and `"street"`.
`zone` must be `"street"`, `"district"` or `"city"`, otherwise you get 400.
```json
{"runId":1,"startTime":1791661597217}
```

### `POST /runs/:id/visit`
Body: `{"houseId":1,"lat":43.47338,"lng":-80.54440}` (the player's current position)
```json
{"visited":1,"remaining":9}
```
Errors:
- 400 `{"error":"lat and lng are required"}`
- 400 `{"error":"too far from house","distanceMeters":87}`
- 400 `{"error":"run already finished"}`
- 404 `{"error":"run not found"}` / `{"error":"house not found"}`

Visiting the same house twice is fine. It just isn't counted again.

### `POST /runs/:id/finish`
No body.
```json
{"houses":4,"seconds":312}
```
Returns 400 `{"error":"run already finished"}` if called twice.

### `GET /leaderboard?zone=street`
Finished runs only, sorted by most houses, then fastest time. `zone` is optional; leave it out to get all zones.
```json
[{"player":"amy","zone":"street","houses":4,"seconds":312}]
```

### `GET /route?lat=&lng=&runId=`
Nearest-neighbor walking order through the houses, starting from `lat`/`lng`. `runId` is optional; if you send it, houses that run already visited are skipped.
```json
{"totalMeters":2058,"stops":[{"id":7,"name":"House 7","lat":43.474636,"lng":-80.543415,"legMeters":161}, ...]}
```

### `GET /chat?zone=street`
Last 50 community chat messages (`zone` optional).
```json
[{"id":1,"player":"amy","zone":"street","text":"House 3 has full size bars!","time":1791664053703}]
```

### `POST /chat`
Body: `{"player":"amy","zone":"street","text":"Hi!"}`. Only `text` is required (max 300 chars). Returns the saved message.

### Unknown routes
404 `{"error":"not found"}`
