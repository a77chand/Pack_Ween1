// First-run tutorial and the shareable result picture.

import { store } from "./api.js";

// ---------- Tutorial ----------
// A coach bubble that walks a first-time player through their first Arcade run.
// Each step waits for the player to actually do the thing.
const TUTORIAL_KEY = "packween.tutorialDone";
const STEPS = [
  { id: "move", text: "👋 Welcome! Press an arrow key (or the D-pad) to run along the street." },
  { id: "dot", text: "⭐ Nice! Gobble the glowing dots on the streets for points." },
  { id: "candy", text: "🏠🍬 Now head for a candy house. 🍬 Find draws a line to the closest one." },
  { id: "ghosts", text: "👻 Watch out for the ghosts! Each one that catches you costs a life. 🍫 houses let you eat them." },
  { id: "done", text: "🎉 You've got it! Collect every house to clear the level. Have fun!" },
];

export class Tutorial {
  constructor() {
    this.step = -1;
    this.el = null;
    this.seen = new Set(); // things already done before their step came up
  }

  static needed() { return store.get(TUTORIAL_KEY) !== "1"; }

  start() {
    this.el = document.createElement("div");
    this.el.className = "coach";
    this.el.setAttribute("role", "status");
    this.el.innerHTML = '<p></p><div class="coach-row"><span class="coach-dots"></span><button type="button" class="link">Skip tutorial</button></div>';
    this.el.querySelector("button").onclick = () => this.finish();
    document.body.append(this.el);
    this.go(0);
  }

  go(i) {
    this.step = i;
    if (!this.el) return;
    this.el.querySelector("p").textContent = STEPS[i].text;
    this.el.querySelector(".coach-dots").textContent = STEPS.map((_, k) => (k <= i ? "●" : "○")).join(" ");
    this.el.classList.remove("pop");
    void this.el.offsetWidth;
    this.el.classList.add("pop");
    if (this.seen.has(STEPS[i].id)) return setTimeout(() => this.event(STEPS[i].id), 1500);
    if (STEPS[i].id === "ghosts") setTimeout(() => this.event("ghosts"), 6000);
    if (STEPS[i].id === "done") setTimeout(() => this.finish(), 5000);
  }

  // The game reports what happened; matching events move the tutorial on
  event(id) {
    this.seen.add(id);
    if (this.el && STEPS[this.step]?.id === id) this.go(this.step + 1);
  }

  finish() {
    store.set(TUTORIAL_KEY, "1");
    this.el?.remove();
    this.el = null;
  }
}

// ---------- Result picture ----------
// Draws a 1080x1350 card (a good size for Instagram and stories) with the run's
// stats in the game's style, and returns it as a PNG Blob.
export async function resultCard(r, { player, skinColor = "#ff7518" }) {
  await document.fonts?.load?.('32px "Press Start 2P"').catch(() => {});
  const W = 1080, H = 1350;
  const c = document.createElement("canvas");
  c.width = W;
  c.height = H;
  const g = c.getContext("2d");
  const arcade = '"Press Start 2P", monospace';

  // night sky
  const sky = g.createLinearGradient(0, 0, 0, H);
  sky.addColorStop(0, "#1f0d2e");
  sky.addColorStop(1, "#0d0612");
  g.fillStyle = sky;
  g.fillRect(0, 0, W, H);
  g.fillStyle = "rgba(255, 201, 60, .9)";
  g.beginPath();
  g.arc(870, 190, 90, 0, Math.PI * 2); // moon
  g.fill();
  g.fillStyle = "#1f0d2e";
  g.beginPath();
  g.arc(910, 165, 85, 0, Math.PI * 2);
  g.fill();
  for (let i = 0; i < 60; i++) {
    g.fillStyle = `rgba(232, 217, 245, ${0.2 + ((i * 37) % 10) / 20})`;
    g.fillRect((i * 173) % W, (i * 97) % 500, 3, 3);
  }

  // neon maze lines
  g.strokeStyle = "rgba(139, 61, 255, .35)";
  g.lineWidth = 10;
  for (let y = 980; y < H; y += 90) { g.beginPath(); g.moveTo(0, y); g.lineTo(W, y + 40); g.stroke(); }
  for (let x = 60; x < W; x += 180) { g.beginPath(); g.moveTo(x, 940); g.lineTo(x + 60, H); g.stroke(); }

  // pumpkin Pac-Man
  g.fillStyle = skinColor;
  g.shadowColor = skinColor;
  g.shadowBlur = 40;
  g.beginPath();
  g.moveTo(240, 330);
  g.arc(240, 330, 120, 0.25 * Math.PI, 1.75 * Math.PI);
  g.closePath();
  g.fill();
  g.shadowBlur = 0;
  // ghosts
  const ghost = (x, col) => {
    g.fillStyle = col;
    g.beginPath();
    g.arc(x, 320, 45, Math.PI, 0);
    g.lineTo(x + 45, 375);
    for (let k = 0; k < 4; k++) g.lineTo(x + 45 - (k + 0.5) * 22.5, k % 2 ? 375 : 360);
    g.lineTo(x - 45, 375);
    g.closePath();
    g.fill();
    g.fillStyle = "#fff";
    g.beginPath(); g.arc(x - 15, 315, 10, 0, 7); g.arc(x + 15, 315, 10, 0, 7); g.fill();
  };
  ghost(470, "#ff3b5c");
  ghost(590, "#7cff4f");

  g.textAlign = "center";
  g.fillStyle = "#ff7518";
  g.shadowColor = "#ff7518";
  g.shadowBlur = 20;
  g.font = `64px ${arcade}`;
  g.fillText("PACK_WEEN", W / 2, 570);
  g.shadowBlur = 0;
  g.fillStyle = "#e8d9f5";
  g.font = "bold 40px system-ui, sans-serif";
  const sub = r.daily ? `Daily ${r.daily.key} · ${r.daily.twist}` : r.mode === "gps" ? "Walk · Ranked" : `Arcade · Level ${r.level}`;
  g.fillText(`${player} · ${sub}`, W / 2, 640);

  // stat tiles
  const tiles = [
    ["SCORE", (r.score || 0).toLocaleString()],
    ["CANDY", `${r.houses}/${r.total}`],
    ["TIME", `${Math.floor(r.seconds / 60)}:${String(r.seconds % 60).padStart(2, "0")}`],
    ["GHOSTS", r.mode === "gps" ? "👻" : String(r.ghosts)],
  ];
  tiles.forEach(([label, value], i) => {
    const x = 90 + (i % 2) * 460, y = 700 + Math.floor(i / 2) * 150;
    g.fillStyle = "rgba(22, 10, 34, .92)";
    g.strokeStyle = "#ff7518";
    g.lineWidth = 4;
    g.beginPath();
    g.roundRect(x, y, 440, 130, 24);
    g.fill();
    g.stroke();
    g.fillStyle = "#a78fc9";
    g.font = "bold 26px system-ui, sans-serif";
    g.fillText(label, x + 220, y + 45);
    g.fillStyle = "#fff";
    g.font = `40px ${arcade}`;
    g.fillText(value, x + 220, y + 105);
  });

  g.fillStyle = "#ffc93c";
  g.font = "bold 36px system-ui, sans-serif";
  g.fillText(r.mode === "arcade" ? "⚔️ Can you beat my run?" : "Trick-or-treat with Pac-Man!", W / 2, 1060);
  g.fillStyle = "#e8d9f5";
  g.font = "30px system-ui, sans-serif";
  g.fillText(location.host, W / 2, 1290);

  return new Promise((resolve) => c.toBlob(resolve, "image/png"));
}
