import { generateWorld, summarizeDna } from "./generator.js";
import { architectureLegend, MapRenderer, worldToSvg } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const renderer = new MapRenderer($("mapCanvas"));
let world = null;
let toastTimer = null;
const controls = {
  seed: $("seedInput"), regions: $("regionCount"), density: $("density"), loops: $("loopChance"),
  labels: $("showLabels"), graph: $("showGraph"), bounds: $("showBounds"), doors: $("showDoors"),
};

function readConfig() { return { regionCount: Number(controls.regions.value), density: Number(controls.density.value), loopChance: Number(controls.loops.value) }; }
function showToast(message) {
  const toast = $("toast"); toast.textContent = message; toast.classList.add("show"); clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}
function updateRangeLabels() {
  $("regionCountValue").value = controls.regions.value;
  $("densityValue").value = Number(controls.density.value).toFixed(2) + "×";
  $("loopChanceValue").value = Math.round(Number(controls.loops.value) * 100) + "%";
}
function updateRendererOptions() {
  renderer.setOptions({ showLabels: controls.labels.checked, showGraph: controls.graph.checked, showBounds: controls.bounds.checked, showDoors: controls.doors.checked });
}
function updateLegend() {
  if (!world) return;
  const counts = summarizeDna(world);
  $("legend").innerHTML = architectureLegend().map((item) => '<div class="legend-item"><span class="legend-swatch" style="background:' + item.color + '"></span><span>' + item.name + '</span><span class="legend-count">' + (counts.get(item.id) || 0) + '</span></div>').join("");
}
function updateBadges() {
  if (!world) return;
  $("seedBadge").textContent = "seed " + world.seed + " · " + world.signature;
  $("statsBadge").textContent = world.stats.regions + " regions · " + world.stats.rooms + " rooms · " + world.stats.macroEdges + " macro links";
}
function writeUrl() {
  if (!world) return;
  const p = new URLSearchParams(); p.set("seed", world.seed); p.set("regions", String(world.config.regionCount));
  p.set("density", world.config.density.toFixed(2)); p.set("loops", world.config.loopChance.toFixed(2));
  history.replaceState(null, "", location.pathname + "?" + p.toString());
}
function generate(options = {}) {
  updateRangeLabels(); world = generateWorld(controls.seed.value, readConfig()); controls.seed.value = world.seed;
  renderer.setWorld(world, options.fit !== false); updateLegend(); updateBadges(); if (options.updateUrl !== false) writeUrl();
}
function loadUrlState() {
  const p = new URLSearchParams(location.search);
  if (p.has("seed")) controls.seed.value = p.get("seed");
  if (p.has("regions")) controls.regions.value = String(Math.max(12, Math.min(72, Number(p.get("regions")) || 44)));
  if (p.has("density")) controls.density.value = String(Math.max(0.55, Math.min(1.55, Number(p.get("density")) || 1)));
  if (p.has("loops")) controls.loops.value = String(Math.max(0, Math.min(0.42, Number(p.get("loops")) || 0.18)));
}
function downloadText(text, filename, type) {
  const blob = new Blob([text], { type }); const url = URL.createObjectURL(blob); const link = document.createElement("a");
  link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 500);
}

$("generateBtn").addEventListener("click", () => generate());
controls.seed.addEventListener("keydown", (e) => { if (e.key === "Enter") generate(); });
$("randomSeedBtn").addEventListener("click", () => {
  const bytes = new Uint32Array(2); crypto.getRandomValues(bytes); controls.seed.value = bytes[0].toString(36) + "-" + bytes[1].toString(36); generate();
});
$("fitBtn").addEventListener("click", () => renderer.fit());
$("copyLinkBtn").addEventListener("click", async () => { writeUrl(); await navigator.clipboard.writeText(location.href); showToast("Permalink copied"); });
$("exportPngBtn").addEventListener("click", () => renderer.exportPng("backrooms-" + world.signature + ".png"));
$("exportSvgBtn").addEventListener("click", () => downloadText(worldToSvg(world, { labels: controls.labels.checked }), "backrooms-" + world.signature + ".svg", "image/svg+xml"));
$("exportJsonBtn").addEventListener("click", () => downloadText(JSON.stringify(world, null, 2), "backrooms-" + world.signature + ".json", "application/json"));
for (const slider of [controls.regions, controls.density, controls.loops]) { slider.addEventListener("input", updateRangeLabels); slider.addEventListener("change", () => generate()); }
for (const toggle of [controls.labels, controls.graph, controls.bounds, controls.doors]) toggle.addEventListener("change", updateRendererOptions);

loadUrlState(); updateRangeLabels(); updateRendererOptions(); generate({ updateUrl: false });
