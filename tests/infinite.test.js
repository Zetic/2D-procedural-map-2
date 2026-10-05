import test from "node:test";
import assert from "node:assert/strict";
import { generateInfiniteWorld } from "../src/infinite.js";
import { intersects } from "../src/geometry.js";

function sectorSnapshot(region) {
  return {
    key: region.key,
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
  assert.deepEqual(
    a.regions.map(sectorSnapshot),
    b.regions.map(sectorSnapshot),
  );
});

test("the same sector is invariant to viewport load order", () => {
  const a = generateInfiniteWorld("viewport-invariance", { centerX: 0, centerY: 0, radius: 2 });
  const b = generateInfiniteWorld("viewport-invariance", { centerX: 2, centerY: 1, radius: 2 });
  const mapA = new Map(a.regions.map((region) => [region.key, sectorSnapshot(region)]));
  for (const region of b.regions) {
    if (!mapA.has(region.key)) continue;
    assert.deepEqual(sectorSnapshot(region), mapA.get(region.key), region.key);
  }
});

test("far coordinates generate valid deterministic architecture", () => {
  const a = generateInfiniteWorld("far-field", { centerX: 173, centerY: -241, radius: 1 });
  const b = generateInfiniteWorld("far-field", { centerX: 173, centerY: -241, radius: 1 });
  assert.equal(a.signature, b.signature);
  assert.equal(a.regions.length, 9);
  assert.ok(a.stats.rooms > 30);
});

test("streamed sectors do not overlap each other", () => {
  const world = generateInfiniteWorld("sector-clearance", { centerX: -2, centerY: 3, radius: 2, density: 1.2 });
  const rooms = world.regions.flatMap((region) => region.rooms);
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      if (rooms[i].regionId === rooms[j].regionId) continue;
      assert.equal(intersects(rooms[i], rooms[j]), false, rooms[i].id + " overlaps " + rooms[j].id);
    }
  }
});

test("cross-sector halls stay short", () => {
  const world = generateInfiniteWorld("short-halls", { centerX: 0, centerY: 0, radius: 3, density: 1.05 });
  for (const corridor of world.macroCorridors) {
    assert.ok(Math.max(corridor.w, corridor.h) <= 32, "macro corridor span was " + Math.max(corridor.w, corridor.h));
  }
});

test("loaded window contains no failed structural edge", () => {
  const world = generateInfiniteWorld("loaded-connectors", { centerX: 4, centerY: -5, radius: 3, loopChance: 0.25 });
  assert.equal(world.edges.filter((edge) => edge.type === "tree" && !edge.routed).length, 0);
  assert.ok(world.edges.length > 0);
});
