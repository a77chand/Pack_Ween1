// AR view: the phone camera with the ghosts and candy houses floating where
// they really are. It uses the compass to know which way the phone points;
// without one (a laptop) it uses the direction Pac-Man is facing.

const FOV = 60; // degrees of view across the screen

export class ArView {
  constructor({ getWorld }) {
    this.getWorld = getWorld; // () => ({ me: {x, y, hx, hy}, ghosts: [{x, y, color, name, state}], houses: [{x, y, name, visited, icon}] })
    this.heading = null;
    this.onOrient = (e) => {
      if (e.webkitCompassHeading != null) this.heading = e.webkitCompassHeading;
      else if (e.absolute && e.alpha != null) this.heading = (360 - e.alpha) % 360;
    };
  }

  async open() {
    const root = document.createElement("div");
    root.className = "ar";
    root.innerHTML = '<video playsinline muted autoplay></video><div class="ar-layer"></div><div class="ar-hud"><span class="ar-note"></span><button class="ar-close" aria-label="Close AR">✕</button></div><div class="ar-radar"></div>';
    document.body.append(root);
    this.root = root;
    this.layer = root.querySelector(".ar-layer");
    root.querySelector(".ar-close").onclick = () => this.close();
    const note = root.querySelector(".ar-note");
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
      root.querySelector("video").srcObject = this.stream;
    } catch {
      root.classList.add("no-camera");
      note.textContent = "No camera, so here's the spooky void instead 👻";
    }
    try {
      if (typeof DeviceOrientationEvent?.requestPermission === "function") await DeviceOrientationEvent.requestPermission();
    } catch { /* denied: fall back to Pac-Man's direction */ }
    window.addEventListener("deviceorientationabsolute", this.onOrient);
    window.addEventListener("deviceorientation", this.onOrient);
    this.running = true;
    const loop = () => { if (!this.running) return; this.draw(); requestAnimationFrame(loop); };
    loop();
    setTimeout(() => { if (this.heading == null && !note.textContent) note.textContent = "No compass: turn by moving Pac-Man"; }, 1500);
  }

  draw() {
    const w = this.getWorld();
    if (!w) return;
    const { me } = w;
    const heading = this.heading ?? ((Math.atan2(me.hx, me.hy) * 180) / Math.PI + 360) % 360;
    const W = this.root.clientWidth, H = this.root.clientHeight;
    const things = [
      ...w.ghosts.filter((g) => g.state !== "eaten").map((g) => ({ ...g, kind: "ghost" })),
      ...w.houses.filter((h) => !h.visited).map((h) => ({ ...h, kind: "house" })),
    ];
    const html = [];
    const radar = [];
    for (const t of things) {
      const dx = t.x - me.x, dy = t.y - me.y;
      const dist = Math.hypot(dx, dy);
      const bearing = ((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360;
      let rel = bearing - heading;
      rel = ((rel + 540) % 360) - 180;
      // radar dot (top-down, phone facing up)
      const rr = Math.min(1, dist / 250) * 44;
      const ra = (rel * Math.PI) / 180;
      radar.push(`<i class="${t.kind}" style="left:${50 + Math.sin(ra) * rr}px;top:${50 - Math.cos(ra) * rr}px;${t.kind === "ghost" ? `background:${t.color}` : ""}"></i>`);
      if (Math.abs(rel) > FOV / 2 + 10 || dist > 400) continue;
      const x = W / 2 + (rel / (FOV / 2)) * (W / 2);
      const size = Math.max(28, Math.min(220, 2600 / Math.max(dist, 8)));
      const y = H * 0.55 - size / 2 + (t.kind === "ghost" ? Math.sin(Date.now() / 400 + t.x) * 10 : 0);
      const label = `${t.kind === "ghost" ? t.name : t.name} · ${Math.round(dist)} m`;
      html.push(t.kind === "ghost"
        ? `<div class="ar-thing" style="left:${x - size / 2}px;top:${y}px;width:${size}px;z-index:${Math.round(1000 - dist)}"><svg viewBox="0 0 28 30" style="filter:drop-shadow(0 0 12px ${t.color})"><path d="M2 28V13a12 12 0 0 1 24 0v15l-4-3-4 3-4-3-4 3-4-3z" fill="${t.state === "fright" ? "#8b3dff" : t.color}" opacity=".85"/><ellipse cx="9.5" cy="12.5" rx="3.6" ry="4.2" fill="#fff"/><ellipse cx="18.5" cy="12.5" rx="3.6" ry="4.2" fill="#fff"/><circle cx="9.5" cy="13" r="2" fill="#1d0b5e"/><circle cx="18.5" cy="13" r="2" fill="#1d0b5e"/></svg><span>${escapeHtml(label)}</span></div>`
        : `<div class="ar-thing house" style="left:${x - size / 2}px;top:${y}px;width:${size}px;z-index:${Math.round(1000 - dist)}"><b style="font-size:${size * 0.6}px">🏠${t.icon}</b><span>${escapeHtml(label)}</span></div>`);
    }
    this.layer.innerHTML = html.join("");
    this.root.querySelector(".ar-radar").innerHTML = `<i class="me"></i>${radar.join("")}`;
  }

  close() {
    this.running = false;
    window.removeEventListener("deviceorientationabsolute", this.onOrient);
    window.removeEventListener("deviceorientation", this.onOrient);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.root?.remove();
    this.root = null;
  }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
