// Anti-cheat: the server never trusts a position without checking that the
// player could actually have got there.
//
// Each run has a movement "budget" in meters that refills at the mode's top speed.
// Every reported position spends the distance moved, and whatever is left over is
// capped at a small slack (for GPS jitter), so standing still doesn't bank speed.
// Moving further than the budget allows means teleporting or riding in a car:
// that is a strike, candy claims pause for COOLDOWN_MS, and after
// MAX_STRIKES the run is flagged and kept off the leaderboard. Sending positions
// more often doesn't help a cheater, because the budget refills with time, not pings.

const { distanceMeters } = require("./geo");

const ARCADE_SPEED = 22; // m/s, must match the game's arcade speed

const LIMITS = {
  // A running kid tops out around 6-7 m/s; 40 m covers a bad GPS fix
  gps: { maxSpeed: 7, slack: 40, powerWindow: 35 },
  arcade: { maxSpeed: ARCADE_SPEED * 1.35, slack: 30, powerWindow: 11 },
};
const MAX_STRIKES = 5;
const COOLDOWN_MS = 20000;
const MIN_COUNTED_STEP = 2; // ignore GPS wobble when adding up distance

// Returns the run fields to update and whether the move looked legitimate
function checkMove(run, lat, lng, now) {
  const lim = LIMITS[run.mode];
  const fields = { last_lat: lat, last_lng: lng, last_time: now };
  if (run.last_time == null) {
    fields.budget = lim.slack;
    return { ok: true, fields };
  }
  const dt = Math.max(0, (now - run.last_time) / 1000);
  const d = distanceMeters(run.last_lat, run.last_lng, lat, lng);
  const available = (run.budget ?? lim.slack) + lim.maxSpeed * dt;
  if (d <= available) {
    fields.budget = Math.min(lim.slack, available - d); // unused time can't be saved up beyond the slack
    if (d >= MIN_COUNTED_STEP) fields.distance = run.distance + d;
    return { ok: true, fields };
  }
  // Too fast. Accept the new position (so one bad GPS fix doesn't snowball)
  // but strike, and pause claims for a while.
  fields.budget = lim.slack;
  fields.strikes = run.strikes + 1;
  fields.cooldown_until = now + COOLDOWN_MS;
  if (fields.strikes >= MAX_STRIKES) fields.flagged = 1;
  return { ok: false, fields, speed: dt > 0 ? d / dt : Infinity };
}

module.exports = { checkMove, LIMITS, MAX_STRIKES, COOLDOWN_MS, ARCADE_SPEED };
