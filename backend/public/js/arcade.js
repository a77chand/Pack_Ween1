// Arcade rules that live only in the browser: score, combos, lives, levels,
// skins, house power-ups, the daily challenge and best-run replays.
// (Candy, time and anti-cheat stay on the server; score is for bragging.)

import { store } from "./api.js";

export const POINTS = { dot: 10, candy: 100, levelClear: 1000, ghost: [200, 400, 800, 1600] };
export const COMBO_WINDOW = 10; // seconds between candy claims to keep a combo going
export const START_LIVES = 3;

// Pac-Man skins, unlocked by lifetime candy
export const SKINS = [
  { id: "pumpkin", name: "Pumpkin", need: 0, color: "#ff7518" },
  { id: "witch", name: "Witch", need: 15, color: "#8b3dff", hat: true },
  { id: "vampire", name: "Vampire", need: 40, color: "#d7263d", acc: "🦇" },
  { id: "skeleton", name: "Skeleton", need: 80, color: "#e8d9f5", acc: "💀" },
  { id: "gold", name: "Golden", need: 150, color: "#ffc93c", acc: "👑" },
];
const SKIN_KEY = "packween.skin";
export const skinById = (id) => SKINS.find((s) => s.id === id) || SKINS[0];
export const savedSkin = () => skinById(store.get(SKIN_KEY));
export const saveSkin = (id) => store.set(SKIN_KEY, id);

export function pacHtml(skin) {
  return `<div class="pac idle skin-${skin.id}" style="--pc:${skin.color}"><div class="pac-glow"></div><div class="body"></div><div class="eye"></div>` +
    (skin.id === "pumpkin" ? '<div class="stem"></div>' : "") +
    (skin.hat ? '<div class="hat"></div>' : "") +
    (skin.acc ? `<div class="acc">${skin.acc}</div>` : "") + "</div>";
}

function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Arcade houses can hide extra power-ups (the same for everyone, from the house name)
export const PERKS = {
  speed: { icon: "⚡", label: "Energy drink: speed boost!", seconds: 6 },
  ghosted: { icon: "🎭", label: "Costume: the ghosts can't see you!", seconds: 6 },
  haunted: { icon: "🕸️", label: "Haunted house! The ghosts are furious…", seconds: 10 },
};
export function perkFor(house) {
  if (house.fullSize) return null;
  const n = hash(house.name) % 10;
  return n < 2 ? "speed" : n === 2 ? "ghosted" : n === 3 ? "haunted" : null;
}

// Witching hour: double points between 9 and 10 pm local time
export const isWitchingHour = (d = new Date()) => d.getHours() === 21;

// Daily challenge: everyone plays the demo neighbourhood with the day's twist
const TWISTS = [
  { id: "fast", label: "Speedy ghosts", ghostScale: 1.3 },
  { id: "onelife", label: "One life only", lives: 1 },
  { id: "dark", label: "Pitch dark", fog: 0.2 },
  { id: "dots", label: "Double dots", dotMult: 2 },
  { id: "swarm", label: "Ghost swarm", swarm: true },
];
export const todayKey = (d = new Date()) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
export const dailyTwist = (key = todayKey()) => TWISTS[hash(`daily:${key}`) % TWISTS.length];

// Best scores
export const bestScore = (key) => Number(store.get(`packween.best.${key}`) || 0);
export function saveBest(key, score) {
  if (score <= bestScore(key)) return false;
  store.set(`packween.best.${key}`, String(score));
  return true;
}

// Replays of your fastest full clear in an area: [[t, lat, lng], ...]
const replayKey = (area) => `packween.replay.${area}`;
export function loadReplay(area) {
  try { return JSON.parse(store.get(replayKey(area)) || "null"); } catch { return null; }
}
export function saveReplay(area, seconds, trail) {
  const old = loadReplay(area);
  if (old && old.seconds <= seconds) return false;
  const step = Math.max(1, Math.ceil(trail.length / 1500)); // keep it under localStorage limits
  store.set(replayKey(area), JSON.stringify({ seconds, trail: trail.filter((_, i) => i % step === 0) }));
  return true;
}
