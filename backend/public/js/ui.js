// DOM helpers: toasts, modals, formatting.

export const $ = (id) => document.getElementById(id);

// el("button", { class: "x", onclick }, "text", child...)
export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "class") node.className = v;
    else if (k === "hidden") node.hidden = !!v;
    else node.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c.nodeType ? c : String(c));
  return node;
}

export function fmtTime(s) {
  s = Math.max(0, Math.round(s));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

export const fmtDist = (m) => (m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`);

// Stacked toasts. kind: info | good | warn | bad
export function toast(msg, kind = "info", ms = 2800) {
  const box = $("toasts");
  const t = el("div", { class: `toast ${kind}`, role: "status" }, msg);
  box.append(t);
  while (box.children.length > 3) box.firstElementChild.remove();
  requestAnimationFrame(() => t.classList.add("show"));
  setTimeout(() => {
    t.classList.remove("show");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

// Generic modal. content: a node; returns a close() function.
let closeCurrent = null;
export function openModal(content, { onClose, wide } = {}) {
  closeCurrent?.();
  const modal = $("modal");
  const card = $("modalCard");
  card.replaceChildren(content);
  card.classList.toggle("wide", !!wide);
  modal.hidden = false;
  const close = () => {
    modal.hidden = true;
    card.replaceChildren();
    document.removeEventListener("keydown", onKey);
    if (closeCurrent === close) closeCurrent = null;
    onClose?.();
  };
  const onKey = (e) => e.key === "Escape" && close();
  document.addEventListener("keydown", onKey);
  modal.onclick = (e) => e.target === modal && close();
  closeCurrent = close;
  card.querySelector("input, button.primary")?.focus();
  return close;
}

export function confirmModal({ title, text, ok = "OK", cancel = "Cancel", danger }) {
  return new Promise((resolve) => {
    let answered = false;
    const done = (v) => { answered = true; close(); resolve(v); };
    const close = openModal(
      el("div", { class: "stack" },
        el("h2", {}, title),
        el("p", {}, text),
        el("div", { class: "row" },
          el("button", { onclick: () => done(false) }, cancel),
          el("button", { class: danger ? "primary danger" : "primary", onclick: () => done(true) }, ok))),
      { onClose: () => !answered && resolve(false) });
  });
}

// "+1" style text that floats up from a map position and fades away
export function floatText(map, latlng, text, cls = "") {
  const m = L.marker(latlng, {
    icon: L.divIcon({ className: "float-icon", html: `<div class="float-text ${cls}">${text}</div>`, iconSize: [0, 0] }),
    interactive: false,
    keyboard: false,
    zIndexOffset: 2000,
  }).addTo(map);
  setTimeout(() => m.remove(), 1200);
}

export function vibrate(pattern) {
  try { navigator.vibrate?.(pattern); } catch { /* not supported */ }
}

export const reducedMotion = () => window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
