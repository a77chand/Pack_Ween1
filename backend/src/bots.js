// Demo players, for display only, so the game never feels empty: leaderboard
// entries, neighbourhood chat (background chatter plus replies to what you say)
// and the "who's playing" feed. Nothing here is stored except chat replies.
// Everything else comes from a seeded random generator, so it is the same for
// everyone in an area and changes slowly over time.

const { anchorFor } = require("./neighbourhood");

// Colours avoid pumpkin orange, which is reserved for the player's own Pac-Man
const BOTS = [
  { name: "WitchyWin", color: "#b48cff" },
  { name: "PumpkinPup", color: "#ffc93c" },
  { name: "GoboGhost", color: "#7cff4f" },
  { name: "CandyKid99", color: "#ffe066" },
  { name: "MoonlitMilo", color: "#e8d9f5" },
  { name: "HexHannah", color: "#c79bff" },
  { name: "SkeleTom", color: "#f0e6ff" },
  { name: "BatBoi", color: "#9dff7a" },
  { name: "CauldronCarl", color: "#ffd76a" },
  { name: "VampVera", color: "#ff6b7f" },
  { name: "MummyMo", color: "#fff3d6" },
  { name: "SpookySue", color: "#d6b3ff" },
];
const GHOSTS = ["Banshee", "Ghoul", "Sheet", "Spook"];
const DAY = 24 * 60 * 60 * 1000;
const GRID = { street: 0.0025, district: 0.03, city: 0.25 }; // degrees: who shares the same demo players

function hashString(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
// mulberry32: small, fast, good enough for games
function rng(seed) {
  let a = hashString(String(seed));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = (r, list) => list[Math.floor(r() * list.length)];
function shuffled(r, list) {
  const a = list.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(r() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
const areaKey = (pos) => {
  if (!pos) return "default";
  const a = anchorFor(pos.lat, pos.lng);
  return `${a.lat},${a.lng}`;
};
const fmtTime = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;

// Fill {house}, {house2}, {ghost}, {bot}, {time}, {n}, {name} in a chat template
function fill(template, r, houses, name = "") {
  const h = shuffled(r, houses.length ? houses : ["the corner house"]);
  return template
    .replaceAll("{house}", h[0])
    .replaceAll("{house2}", h[1] || h[0])
    .replaceAll("{ghost}", pick(r, GHOSTS))
    .replaceAll("{bot}", pick(r, BOTS).name)
    .replaceAll("{time}", fmtTime(150 + Math.floor(r() * 110)))
    .replaceAll("{n}", String(8 + Math.floor(r() * 5)))
    .replaceAll("{name}", name);
}

// ---------- Leaderboard ----------
// Beatable but respectable scores, stable for a day in each area
function leaderboardBots({ scope, mode, pos, now }) {
  const cell = scope === "world" || !pos ? "world" : `${Math.round(pos.lat / GRID[scope])},${Math.round(pos.lng / GRID[scope])}`;
  const r = rng(`board:${mode}:${scope}:${cell}:${Math.floor(now / DAY)}`);
  const count = { street: 4, district: 6, city: 8, world: 10 }[scope];
  return shuffled(r, BOTS).slice(0, count).map((b) => {
    const houses = mode === "arcade" ? 12 - Math.floor(r() ** 1.6 * 7) : 12 - Math.floor(r() ** 1.2 * 9);
    const seconds = mode === "arcade" ? Math.round(85 + houses * 7 + r() * 110) : Math.round(houses * (110 + r() * 120));
    return { player: b.name, houses, total: 12, seconds, ghosts: mode === "arcade" ? Math.floor(r() * r() * 5) : 0, bot: true };
  });
}

// ---------- Chat ----------
const CHATTER = [
  "{house} is giving out full-size bars 🍫",
  "anyone else playing from home tonight? 🕹️",
  "{ghost} got me twice in a row 😭",
  "just cleared all 12 in {time}!! 🎃",
  "pro tip: grab the 🍫 houses first, then hunt the ghosts",
  "{house} has the best decorations on the street",
  "the 🧭 Route button is so good",
  "who's beating {bot} tonight? they're way too fast",
  "skip {house}, they ran out of candy lol",
  "walked the whole loop with my little sister, {n} candy 🍬",
  "happy halloween everyone!! 👻",
  "ate {ghost} right at the corner 😋 −5s",
  "{house} → {house2} is the fastest way, trust",
  "is it just me or is {ghost} faster than the others",
  "my bag is SO heavy rn 🎒🍬",
];

// Background chatter over the last hour: about one message every few minutes
function chatter(pos, now, houses) {
  const BUCKET = 4 * 60 * 1000;
  const area = areaKey(pos);
  const out = [];
  const last = Math.floor(now / BUCKET);
  for (let b = last - 15; b <= last; b++) {
    const r = rng(`chat:${area}:${b}`);
    if (r() > 0.55) continue;
    const time = b * BUCKET + Math.floor(r() * BUCKET);
    if (time > now) continue;
    out.push({ id: -b, player: pick(r, BOTS).name, text: fill(pick(r, CHATTER), r, houses), time, bot: true });
  }
  return out;
}

const GREETING = /\b(hi|hey|hello|yo|sup|hiya|howdy|hii+)\b/i;
const GREETINGS = ["hey {name}! 👋 happy halloween", "yo {name}! you playing arcade or walking?", "hiii {name} 🎃"];
const REPLIES = [
  [/\b(thanks?|thx|ty)\b/i, ["np! 🎃", "anytime 👻"]],
  [/(candy|best|house|full|bar|choc|treat)/i, ["{house} has full-size bars 🍫 go go go", "{house} and {house2} were the best for me", "skip {house}, they ran out lol"]],
  [/(ghost|banshee|ghoul|sheet|spook|caught|chase)/i, ["Banshee (the red one) never gives up 😭", "grab a 🍫 house and eat them, −5s each!", "{ghost} always cuts me off at the corners"]],
  [/(route|lost|where|find|map)/i, ["hit 🧭 Route, it plans the shortest loop through every house", "🍬 Find draws a line to the closest candy"]],
  [/(score|leader|board|win|fast|time|record|beat)/i, ["{bot} is top of the board rn, go beat them 😤", "my best is {n} candy in {time}", "a full clear under 3 min is the dream"]],
  [/(walk|gps|real|outside|outdoor)/i, ["walk mode is the best, the ghosts are just for vibes out there", "bring a flashlight 🔦 and watch the road!"]],
  [/\?\s*$/, ["good question 🤔 anyone know?", "not sure tbh, try it and report back 👀"]],
];
const SMALL_TALK = ["lol same", "👻👻👻", "{house} is spooky tonight", "anyone else doing arcade from home?", "this game is so fun 🎃", "brb getting more candy"];

// Answer the topic of the message; a greeting gets a "hey" in front
function replyTo(text, name, now, houses) {
  const r = rng(`reply:${text}:${now}`);
  const rule = REPLIES.find(([re]) => re.test(text));
  const greeted = GREETING.test(text);
  const answer = rule ? pick(r, rule[1]) : greeted ? pick(r, GREETINGS) : pick(r, SMALL_TALK);
  const prefix = rule && greeted ? "hey {name}! " : "";
  return { player: pick(r, BOTS).name, text: fill(prefix + answer, r, houses, name) };
}

// ---------- Who's playing ----------
function activity(pos, now, houses) {
  const area = areaKey(pos);
  const r = rng(`players:${area}:${Math.floor(now / (10 * 60 * 1000))}`);
  const players = shuffled(r, BOTS).slice(0, 3 + Math.floor(r() * 4));
  const BUCKET = 2 * 60 * 1000;
  const last = Math.floor(now / BUCKET);
  const feed = [];
  for (let b = last - 15; b <= last; b++) {
    const f = rng(`feed:${area}:${b}`);
    if (f() > 0.6) continue;
    const time = b * BUCKET + Math.floor(f() * BUCKET);
    if (time > now) continue;
    const bot = pick(f, BOTS).name;
    const kind = f();
    const text = kind < 0.4 ? fill(`${bot} grabbed candy at {house}`, f, houses)
      : kind < 0.6 ? fill(`${bot} finished with {n} 🍬 in {time}`, f, houses)
      : kind < 0.75 ? fill(`${bot} ate {ghost}! 👻`, f, houses)
      : kind < 0.88 ? fill(`${bot} got caught by {ghost} 😱`, f, houses)
      : `${bot} started trick-or-treating`;
    feed.push({ text, time, bot: true });
  }
  return { players, extra: Math.floor(r() * 3), feed };
}

module.exports = { BOTS, leaderboardBots, chatter, replyTo, activity, rng };
