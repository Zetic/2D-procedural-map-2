import { ARCHITECTURE_DNA } from "./dna.js";

function hexToRgb(hex) {
  const v = hex.replace("#", "");
  return { r: parseInt(v.slice(0, 2), 16), g: parseInt(v.slice(2, 4), 16), b: parseInt(v.slice(4, 6), 16) };
}

function adjustColor(hex, amount) {
  const c = hexToRgb(hex);
  const clamp = (v) => Math.max(0, Math.min(255, Math.round(v)));
  return "rgb(" + clamp(c.r + amount) + "," + clamp(c.g + amount) + "," + clamp(c.b + amount) + ")";
}

function blend(aHex, bHex) {
  const a = hexToRgb(aHex); const b = hexToRgb(bHex);
  const h = (v) => Math.round(v).toString(16).padStart(2, "0");
  return "#" + h((a.r + b.r) / 2) + h((a.g + b.g) / 2) + h((a.b + b.b) / 2);
}

export class MapRenderer {
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.world = null;
    this.options = { showLabels: true, showGraph: false, showBounds: false, showDoors: true };
    this.view = { scale: 1, x: 0, y: 0 };
    this.drag = null;
    this.onViewChange = null;
    this.viewNotifyFrame = 0;
    this.installEvents();
    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(canvas.parentElement);
    this.resize();
  }

  setWorld(world, fit = true) { this.world = world; if (fit) this.fit(); else this.draw(); }
  setOptions(options) { this.options = { ...this.options, ...options }; this.draw(); }
  setViewChangeHandler(handler) { this.onViewChange = handler; }

  scheduleViewChange() {
    if (!this.onViewChange || this.viewNotifyFrame) return;
    this.viewNotifyFrame = requestAnimationFrame(() => {
      this.viewNotifyFrame = 0;
      if (!this.onViewChange) return;
      const box = this.canvas.getBoundingClientRect();
      const center = this.screenToWorld(box.width / 2, box.height / 2);
      this.onViewChange({
        center,
        scale: this.view.scale,
        worldWidth: box.width / Math.max(0.0001, this.view.scale),
        worldHeight: box.height / Math.max(0.0001, this.view.scale),
      });
    });
  }

  resize() {
    const box = this.canvas.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.canvas.width = Math.max(1, Math.round(box.width * dpr));
    this.canvas.height = Math.max(1, Math.round(box.height * dpr));
    this.dpr = dpr;
    this.draw();
  }

  fit() {
    if (!this.world) return;
    const box = this.canvas.getBoundingClientRect();
    const b = this.world.bounds;
    const pad = 70;
    this.view.scale = Math.max(0.04, Math.min((box.width - pad * 2) / Math.max(1, b.w), (box.height - pad * 2) / Math.max(1, b.h)));
    this.view.x = box.width / 2 - (b.x + b.w / 2) * this.view.scale;
    this.view.y = box.height / 2 - (b.y + b.h / 2) * this.view.scale;
    this.draw();
  }

  screenToWorld(x, y) { return { x: (x - this.view.x) / this.view.scale, y: (y - this.view.y) / this.view.scale }; }

  installEvents() {
    this.canvas.addEventListener("wheel", (event) => {
      event.preventDefault();
      const box = this.canvas.getBoundingClientRect();
      const px = event.clientX - box.left; const py = event.clientY - box.top;
      const before = this.screenToWorld(px, py);
      this.view.scale = Math.max(0.035, Math.min(3.8, this.view.scale * Math.exp(-event.deltaY * 0.0011)));
      this.view.x = px - before.x * this.view.scale;
      this.view.y = py - before.y * this.view.scale;
      this.draw();
      this.scheduleViewChange();
    }, { passive: false });
    this.canvas.addEventListener("pointerdown", (event) => {
      this.canvas.setPointerCapture(event.pointerId);
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, vx: this.view.x, vy: this.view.y };
    });
    this.canvas.addEventListener("pointermove", (event) => {
      if (!this.drag || event.pointerId !== this.drag.id) return;
      this.view.x = this.drag.vx + event.clientX - this.drag.x;
      this.view.y = this.drag.vy + event.clientY - this.drag.y;
      this.draw();
      this.scheduleViewChange();
    });
    const end = (event) => { if (this.drag && event.pointerId === this.drag.id) this.drag = null; };
    this.canvas.addEventListener("pointerup", end);
    this.canvas.addEventListener("pointercancel", end);
    this.canvas.addEventListener("dblclick", () => this.fit());
  }

  drawRect(r, fill, stroke, width) {
    const ctx = this.ctx;
    ctx.fillStyle = fill; ctx.fillRect(r.x, r.y, r.w, r.h);
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = width || 1; ctx.strokeRect(r.x, r.y, r.w, r.h); }
  }

  draw() {
    const ctx = this.ctx; const dpr = this.dpr || 1;
    const w = this.canvas.width / dpr; const h = this.canvas.height / dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.fillStyle = "#0c0e10"; ctx.fillRect(0, 0, w, h);
    if (!this.world) return;
    ctx.save(); ctx.translate(this.view.x, this.view.y); ctx.scale(this.view.scale, this.view.scale);
    if (this.options.showGraph) this.drawTopology();
    for (const c of this.world.macroCorridors) {
      const ids = String(c.edge || "").split(":").map(Number);
      const a = this.world.regions[ids[0]]; const b = this.world.regions[ids[1]];
      const color = a && b ? blend(a.dna.color, b.dna.color) : "#c9bd9e";
      this.drawRect(c, adjustColor(color, -13), "rgba(15,17,19,.64)", 2 / this.view.scale);
    }
    for (const region of this.world.regions) this.drawRegion(region);
    if (this.options.showBounds) this.drawBounds();
    if (this.options.showLabels) this.drawLabels();
    ctx.restore();
  }

  drawRegion(region) {
    const wall = "rgba(9,10,11,.72)";
    for (const c of region.corridors) this.drawRect(c, adjustColor(region.dna.color, -12), wall, 1.5 / this.view.scale);
    for (const room of region.rooms) {
      const variance = Math.round((room.variant - 0.5) * 16) + (room.kind === "hall" ? 7 : 0);
      this.drawRect(room, adjustColor(region.dna.color, variance), wall, 1.6 / this.view.scale);
      if (room.kind === "hall" && this.view.scale > 0.34) this.drawPillars(room, region);
    }
    if (this.options.showDoors && this.view.scale > 0.23) this.drawDoorSeams(region);
  }

  drawPillars(room, region) {
    const ctx = this.ctx; const spacing = 34;
    const radius = Math.max(2.2, Math.min(4.5, Math.min(room.w, room.h) * 0.026));
    ctx.fillStyle = adjustColor(region.dna.color, -28);
    for (let x = room.x + spacing; x < room.x + room.w - spacing * 0.7; x += spacing) {
      for (let y = room.y + spacing; y < room.y + room.h - spacing * 0.7; y += spacing) {
        ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.fill();
      }
    }
  }

  drawDoorSeams(region) {
    const ctx = this.ctx; ctx.save(); ctx.strokeStyle = "rgba(75,64,49,.72)"; ctx.lineWidth = Math.max(1.2 / this.view.scale, 1.8);
    for (const c of region.corridors) {
      if (c.kind === "doorway") continue;
      if (c.w > c.h) {
        for (const x of [c.x, c.x + c.w]) { ctx.beginPath(); ctx.moveTo(x, c.y); ctx.lineTo(x, c.y + c.h); ctx.stroke(); }
      } else {
        for (const y of [c.y, c.y + c.h]) { ctx.beginPath(); ctx.moveTo(c.x, y); ctx.lineTo(c.x + c.w, y); ctx.stroke(); }
      }
    }
    ctx.restore();
  }

  drawTopology() {
    const ctx = this.ctx; ctx.save(); ctx.strokeStyle = "rgba(125,196,255,.4)"; ctx.lineWidth = 2 / this.view.scale;
    ctx.setLineDash([12 / this.view.scale, 8 / this.view.scale]);
    for (const edge of this.world.edges) {
      const a = this.world.regions[edge.a]; const b = this.world.regions[edge.b];
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    ctx.setLineDash([]); ctx.fillStyle = "rgba(125,196,255,.85)";
    for (const r of this.world.regions) { ctx.beginPath(); ctx.arc(r.x, r.y, 5 / this.view.scale, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }

  drawBounds() {
    const ctx = this.ctx; ctx.save(); ctx.setLineDash([8 / this.view.scale, 5 / this.view.scale]);
    ctx.strokeStyle = "rgba(255,255,255,.22)"; ctx.lineWidth = 1 / this.view.scale;
    for (const r of this.world.regions) { const b = r.bounds; ctx.strokeRect(b.x - 10, b.y - 10, b.w + 20, b.h + 20); }
    ctx.restore();
  }

  drawLabels() {
    const ctx = this.ctx; const inv = 1 / this.view.scale; const size = Math.max(9 * inv, Math.min(14 * inv, 13));
    ctx.save(); ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.font = "600 " + size + "px ui-sans-serif,system-ui,sans-serif";
    for (const r of this.world.regions) {
      if (this.view.scale < 0.14 && r.id % 3 !== 0) continue;
      const prefix = r.label || ("R" + String(r.id).padStart(2, "0"));
      const label = prefix + " · " + r.dna.name; const y = r.bounds.y - 16 * inv;
      ctx.lineWidth = 4 * inv; ctx.strokeStyle = "rgba(12,14,16,.9)"; ctx.strokeText(label, r.x, y);
      ctx.fillStyle = "rgba(236,232,221,.86)"; ctx.fillText(label, r.x, y);
    }
    ctx.restore();
  }

  exportPng(filename) {
    const link = document.createElement("a"); link.download = filename || "procedural-map.png";
    link.href = this.canvas.toDataURL("image/png"); link.click();
  }
}

function svgRect(r, fill) {
  return '<rect x="' + r.x + '" y="' + r.y + '" width="' + r.w + '" height="' + r.h + '" fill="' + fill + '" stroke="#1a1a18" stroke-width="1.5"/>';
}

export function worldToSvg(world, options = {}) {
  const p = 40; const b = world.bounds;
  const out = ['<?xml version="1.0" encoding="UTF-8"?>', '<svg xmlns="http://www.w3.org/2000/svg" viewBox="' + (b.x - p) + ' ' + (b.y - p) + ' ' + (b.w + p * 2) + ' ' + (b.h + p * 2) + '" width="1600" height="1100">'];
  out.push('<rect x="' + (b.x - p) + '" y="' + (b.y - p) + '" width="' + (b.w + p * 2) + '" height="' + (b.h + p * 2) + '" fill="#0c0e10"/>');
  for (const c of world.macroCorridors) out.push(svgRect(c, "#b7aa8c"));
  for (const region of world.regions) {
    for (const c of region.corridors) out.push(svgRect(c, region.dna.color));
    for (const r of region.rooms) out.push(svgRect(r, region.dna.color));
    if (options.labels !== false) out.push('<text x="' + region.x + '" y="' + (region.bounds.y - 12) + '" text-anchor="middle" font-family="system-ui,sans-serif" font-size="11" fill="#ede8dc">' + (region.label || ("R" + String(region.id).padStart(2, "0"))) + ' · ' + region.dna.name + '</text>');
  }
  out.push('</svg>'); return out.join("\n");
}

export function architectureLegend() {
  return ARCHITECTURE_DNA.map((dna) => ({ id: dna.id, name: dna.name, color: dna.color }));
}
