// Retro sound effects, synthesised with the Web Audio API (no audio files).

import { store } from "./api.js";

const MUTE_KEY = "packween.muted";
let ctx = null;
let muted = store.get(MUTE_KEY) === "1";
let wakaFlip = false;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

function tone({ freq, to = freq, dur = 0.1, type = "square", vol = 0.05, delay = 0 }) {
  if (muted) return;
  const ac = audio();
  if (!ac) return;
  const t0 = ac.currentTime + delay;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(1, to), t0 + dur);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(vol, t0 + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

export const sfx = {
  unlock: () => audio(),
  waka() {
    wakaFlip = !wakaFlip;
    tone(wakaFlip ? { freq: 260, to: 520, dur: 0.11, type: "triangle", vol: 0.07 } : { freq: 500, to: 250, dur: 0.11, type: "triangle", vol: 0.07 });
  },
  candy() {
    [784, 988, 1175, 1568].forEach((f, i) => tone({ freq: f, dur: 0.09, delay: i * 0.07, vol: 0.05 }));
  },
  power() {
    tone({ freq: 200, to: 900, dur: 0.35, type: "sawtooth", vol: 0.04 });
    tone({ freq: 300, to: 1200, dur: 0.35, type: "square", vol: 0.03, delay: 0.3 });
  },
  eat() {
    tone({ freq: 300, to: 1600, dur: 0.18, type: "square", vol: 0.06 });
    tone({ freq: 1600, to: 2400, dur: 0.12, type: "triangle", vol: 0.05, delay: 0.16 });
  },
  spooked() {
    for (let i = 0; i < 6; i++) tone({ freq: 700 - i * 90, to: 600 - i * 90, dur: 0.12, type: "square", vol: 0.05, delay: i * 0.1 });
  },
  win() {
    [523, 659, 784, 1047, 784, 1047].forEach((f, i) => tone({ freq: f, dur: 0.14, delay: i * 0.12, vol: 0.06 }));
  },
  warn() { tone({ freq: 220, to: 180, dur: 0.25, type: "sawtooth", vol: 0.04 }); },
  click() { tone({ freq: 900, to: 700, dur: 0.04, type: "square", vol: 0.03 }); },
};

export const isMuted = () => muted;
export function setMuted(m) {
  muted = m;
  store.set(MUTE_KEY, m ? "1" : null);
}
