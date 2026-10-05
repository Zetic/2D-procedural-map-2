import test from "node:test";
import assert from "node:assert/strict";
import { generateInfiniteWorld, INFINITE_SECTOR_SIZE } from "../src/infinite.js";
import { intersects } from "../src/geometry.js";

function siteSnapshot(region) {
  return {
    key: region.key,
    x: region.x,
    y: region.y,
    dna: region.dna.id,
    rooms: region.rooms.map((room) => [room.id, room.x, room.y, room.w, room.h, room.kind]),
    corridors: region.corridors.map((c) => [c.x, c.y, c.w, c.h, c.kind]),
  };
}

test("infinite windows are deterministic", () => {
  const config = { centerX: 0, centerY: 0, radius: 2, density: 1, loopChance: 0.18 };
  const a = generateInfiniteWorld("infinite-determinism", config);
  const b = generateInfiniteWorld("infinite-determinism", config);
  assert.equal(a.signature, b.signature);
  assert.deepEqual(a.regions.map(siteSnapshot), b.regions.map(siteSnapshot));
  assert.deepEqual(
    a.macroRooms.map((room) => [room.id, room.x, room.y, room.w, room.h]),
    b.macroRooms.map((room) => [room.id, room.x, room.y, room.w, room.h]),
  );
});

test("the same architectural site is invariant to viewport load order", () => {
  const a = generateInfiniteWorld("viewport-invariance", { centerX: 0, centerY: 0, radius: 2 });
  const b = generateInfiniteWorld("viewport-invariance", { centerX: 2, centerY: 1, radius: 2 });
  const mapA = new Map(a.regions.map((region) => [region.key, siteSnapshot(region)]));
  for (const region of b.regions) {
    if (!mapA.has(region.key)) continue;
    assert.deepEqual(siteSnapshot(region), mapA.get(region.key), region.key);
  }
});

test("far coordinates generate valid deterministic architecture", () => {
  const a = generateInfiniteWorld("far-field", { centerX: 173, centerY: -241, radius: 1 });
  const b = generateInfiniteWorld("far-field", { centerX: 173, centerY: -241, radius: 1 });
  assert.equal(a.signature, b.signature);
  assert.equal(a.regions.length, 9);
  assert.ok(a.stats.rooms > 30);
});

test("architecture is not confined to the hidden streaming lattice", () => {
  const world = generateInfiniteWorld("boundary-crossing", { centerX: 0, centerY: 0, radius: 3, density: 1.1 });
  let crosses = 0;
  for (const region of world.regions) {
    const minX = region.cellX * INFINITE_SECTOR_SIZE - INFINITE_SECTOR_SIZE / 2;
    const maxX = minX + INFINITE_SECTOR_SIZE;
    const minY = region.cellY * INFINITE_SECTOR_SIZE - INFINITE_SECTOR_SIZE / 2;
    const maxY = minY + INFINITE_SECTOR_SIZE;
    if (region.rooms.some((room) =>
      room.x < minX ||
      room.y < minY ||
      room.x + room.w > maxX ||
      room.y + room.h > maxY
    )) crosses += 1;
  }
  assert.ok(crosses > 0, "no architecture crossed a hidden streaming-cell boundary");
});

test("architectural sites are spatially jittered rather than rendered as a grid", () => {
  const world = generateInfiniteWorld("no-visible-grid", { centerX: 0, centerY: 0, radius: 3 });
  const offsets = world.regions.map((region) => [
    Math.abs(region.x - region.cellX * INFINITE_SECTOR_SIZE),
    Math.abs(region.y - region.cellY * INFINITE_SECTOR_SIZE),
  ]);
  assert.ok(offsets.filter(([x, y]) => x > 40 || y > 40).length > world.regions.length * 0.65);
});

test("rooms owned by different architectural sites do not overlap", () => {
  const world = generateInfiniteWorld("site-clearance", { centerX: -2, centerY: 3, radius: 2, density: 1.15 });
  const rooms = world.regions.flatMap((region) => region.rooms);
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      if (rooms[i].regionId === rooms[j].regionId) continue;
      assert.equal(intersects(rooms[i], rooms[j]), false, rooms[i].id + " overlaps " + rooms[j].id);
    }
  }
});

test("long inter-site distances are filled with transition architecture instead of bare halls", () => {
  const world = generateInfiniteWorld("short-halls", { centerX: 0, centerY: 0, radius: 3, density: 1.05 });
  assert.ok(world.macroRooms.length > 0, "expected edge-owned transition rooms");
  for (const corridor of world.macroCorridors) {
    assert.ok(
      Math.max(corridor.w, corridor.h) <= 215,
      "bare macro corridor span was " + Math.max(corridor.w, corridor.h),
    );
  }
});

test("loaded window contains no failed structural edge", () => {
  const world = generateInfiniteWorld("loaded-connectors", { centerX: 4, centerY: -5, radius: 3, loopChance: 0.25 });
  assert.equal(world.edges.filter((edge) => edge.type === "tree" && !edge.routed).length, 0);
  assert.ok(world.edges.length > 0);
});
