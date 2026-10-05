import {
  generateInfiniteWorld,
  summarizeInfiniteDna,
  INFINITE_SECTOR_SIZE,
} from "./infinite.js";
import { architectureLegend, MapRenderer, worldToSvg } from "./renderer.js";

const $ = (id) => document.getElementById(id);
const renderer = new MapRenderer($("mapCanvas"));
let world = null;
let toastTimer = null;
let streaming = false;
let streamState = { centerX: 0, centerY: 0, radius: 2 };

const controls = {
  seed: $("seedInput"),
  density: $("density"),
  loops: $("loopChance"),
  labels: $("showLabels"),
  graph: $("showGraph"),
  bounds: $("showBounds"),
  doors: $("showDoors"),
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readConfig() {
  return {
    density: Number(controls.density.value),
    loopChance: Number(controls.loops.value),
    centerX: streamState.centerX,
    centerY: streamState.centerY,
    radius: streamState.radius,
  };
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove("show"), 1600);
}

function updateRangeLabels() {
  $("densityValue").value = Number(controls.density.value).toFixed(2) + "×";
  $("loopChanceValue").value = Math.round(Number(controls.loops.value) * 100) + "%";
}

function updateRendererOptions() {
  renderer.setOptions({
    showLabels: controls.labels.checked,
    showGraph: controls.graph.checked,
    showBounds: controls.bounds.checked,
    showDoors: controls.doors.checked,
  });
}

function updateLegend() {
  if (!world) return;
  const counts = summarizeInfiniteDna(world);
  $("legend").innerHTML = architectureLegend()
    .map((item) =>
      '<div class="legend-item"><span class="legend-swatch" style="background:' +
      item.color +
      '"></span><span>' +
      item.name +
      '</span><span class="legend-count">' +
      (counts.get(item.id) || 0) +
      "</span></div>"
    )
    .join("");
}

function updateBadges() {
  if (!world) return;
  $("seedBadge").textContent = "seed " + world.seed + " · " + world.signature;
  $("statsBadge").textContent =
    world.stats.regions +
    " architectural sites loaded · " +
    world.stats.rooms +
    " rooms · infinite world";
}

function writeUrl() {
  if (!world) return;
  const p = new URLSearchParams();
  p.set("seed", world.seed);
  p.set("density", world.config.density.toFixed(2));
  p.set("loops", world.config.loopChance.toFixed(2));
  p.set("x", String(streamState.centerX));
  p.set("y", String(streamState.centerY));
  history.replaceState(null, "", location.pathname + "?" + p.toString());
}

function generate(options = {}) {
  updateRangeLabels();
  world = generateInfiniteWorld(controls.seed.value, readConfig());
  controls.seed.value = world.seed;
  renderer.setWorld(world, options.fit === true);
  updateLegend();
  updateBadges();
  if (options.updateUrl !== false) writeUrl();
}

function resetAndGenerate() {
  streamState = { centerX: 0, centerY: 0, radius: 2 };
  generate({ fit: true });
}

function loadUrlState() {
  const p = new URLSearchParams(location.search);
  if (p.has("seed")) controls.seed.value = p.get("seed");
  if (p.has("density")) {
    controls.density.value = String(clamp(Number(p.get("density")) || 1, 0.55, 1.55));
  }
  if (p.has("loops")) {
    controls.loops.value = String(clamp(Number(p.get("loops")) || 0.18, 0, 0.42));
  }
  streamState.centerX = Math.trunc(Number(p.get("x")) || 0);
  streamState.centerY = Math.trunc(Number(p.get("y")) || 0);
}

function desiredRadius(view) {
  const visibleHalfSpan = Math.max(view.worldWidth, view.worldHeight) / 2;
  return clamp(Math.ceil(visibleHalfSpan / INFINITE_SECTOR_SIZE) + 1, 2, 5);
}

function handleViewChange(view) {
  if (!world || streaming) return;
  const nextX = Math.floor(view.center.x / INFINITE_SECTOR_SIZE);
  const nextY = Math.floor(view.center.y / INFINITE_SECTOR_SIZE);
  const nextRadius = desiredRadius(view);
  if (
    nextX === streamState.centerX &&
    nextY === streamState.centerY &&
    nextRadius === streamState.radius
  ) {
    return;
  }

  streaming = true;
  streamState = { centerX: nextX, centerY: nextY, radius: nextRadius };
  generate({ fit: false, updateUrl: false });
  writeUrl();
  streaming = false;
}

function downloadText(text, filename, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 500);
}

$("generateBtn").addEventListener("click", resetAndGenerate);
controls.seed.addEventListener("keydown", (event) => {
  if (event.key === "Enter") resetAndGenerate();
});

$("randomSeedBtn").addEventListener("click", () => {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  controls.seed.value = bytes[0].toString(36) + "-" + bytes[1].toString(36);
  resetAndGenerate();
});

$("fitBtn").addEventListener("click", () => renderer.fit());
$("copyLinkBtn").addEventListener("click", async () => {
  writeUrl();
  await navigator.clipboard.writeText(location.href);
  showToast("Permalink copied");
});

$("exportPngBtn").addEventListener("click", () =>
  renderer.exportPng("backrooms-window-" + world.signature + ".png")
);
$("exportSvgBtn").addEventListener("click", () =>
  downloadText(
    worldToSvg(world, { labels: controls.labels.checked }),
    "backrooms-window-" + world.signature + ".svg",
    "image/svg+xml"
  )
);
$("exportJsonBtn").addEventListener("click", () =>
  downloadText(
    JSON.stringify(world, (key, value) => value instanceof Map ? Object.fromEntries(value) : value, 2),
    "backrooms-window-" + world.signature + ".json",
    "application/json"
  )
);

for (const slider of [controls.density, controls.loops]) {
  slider.addEventListener("input", updateRangeLabels);
  slider.addEventListener("change", () => generate({ fit: false }));
}
for (const toggle of [controls.labels, controls.graph, controls.bounds, controls.doors]) {
  toggle.addEventListener("change", updateRendererOptions);
}

loadUrlState();
updateRangeLabels();
updateRendererOptions();
generate({ fit: true, updateUrl: false });
renderer.setViewChangeHandler(handleViewChange);
