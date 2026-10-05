import test from "node:test";
import assert from "node:assert/strict";
import { generateWorld } from "../src/generator.js";
import { intersects } from "../src/geometry.js";

const config = { regionCount: 36, density: 1, loopChance: 0.18 };

test("same seed and config produce byte-stable structural signatures", () => {
  const a = generateWorld("determinism-check", config);
  const b = generateWorld("determinism-check", config);
  assert.equal(a.signature, b.signature);
  assert.deepEqual(a.edges, b.edges);
  assert.deepEqual(
    a.regions.map((r) => r.rooms.map(({ x, y, w, h }) => [x, y, w, h])),
    b.regions.map((r) => r.rooms.map(({ x, y, w, h }) => [x, y, w, h])),
  );
});

test("different seeds normally produce different structures", () => {
  const a = generateWorld("seed-a", config);
  const b = generateWorld("seed-b", config);
  assert.notEqual(a.signature, b.signature);
});

test("macro topology remains connected", () => {
  const world = generateWorld("connected-world", { ...config, regionCount: 52 });
  const adjacency = Array.from({ length: world.regions.length }, () => []);
  for (const edge of world.edges.filter((edge) => edge.routed)) {
    adjacency[edge.a].push(edge.b);
    adjacency[edge.b].push(edge.a);
  }
  const seen = new Set([0]);
  const queue = [0];
  while (queue.length) {
    const node = queue.shift();
    for (const next of adjacency[node]) {
      if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
  }
  assert.equal(seen.size, world.regions.length);
  assert.equal(world.stats.failedRoutes, 0);
});

test("all generated geometry is finite and non-empty", () => {
  const world = generateWorld("finite-geometry", { regionCount: 60, density: 1.35, loopChance: 0.3 });
  const rects = [
    ...world.regions.flatMap((r) => r.rooms),
    ...world.regions.flatMap((r) => r.corridors),
    ...world.macroCorridors,
  ];
  assert.ok(rects.length > 100);
  for (const r of rects) {
    assert.ok(Number.isFinite(r.x) && Number.isFinite(r.y));
    assert.ok(Number.isFinite(r.w) && Number.isFinite(r.h));
    assert.ok(r.w > 0 && r.h > 0);
  }
});

test("region IDs and room IDs remain unique", () => {
  const world = generateWorld("identity-check", config);
  assert.equal(new Set(world.regions.map((r) => r.id)).size, world.regions.length);
  const roomIds = world.regions.flatMap((r) => r.rooms.map((room) => room.id));
  assert.equal(new Set(roomIds).size, roomIds.length);
});

test("rooms never overlap globally across regions", () => {
  for (const seed of ["overlap-a", "overlap-b", "overlap-c", "71-days-after-arrival"]) {
    const world = generateWorld(seed, { regionCount: 56, density: 1.2, loopChance: 0.24 });
    const rooms = world.regions.flatMap((region) => region.rooms);
    for (let i = 0; i < rooms.length; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        assert.equal(intersects(rooms[i], rooms[j]), false, seed + ": " + rooms[i].id + " overlaps " + rooms[j].id);
      }
    }
    assert.equal(world.stats.roomOverlaps, 0);
  }
});

test("macro corridors do not cut through unrelated rooms", () => {
  const world = generateWorld("route-clearance", { regionCount: 58, density: 1.15, loopChance: 0.34 });
  const rooms = world.regions.flatMap((region) => region.rooms);
  for (const corridor of world.macroCorridors) {
    for (const room of rooms) {
      if (room.id === corridor.sourceRoomId || room.id === corridor.targetRoomId) continue;
      assert.equal(intersects(corridor, room), false, corridor.id + " intrudes " + room.id);
    }
  }
  assert.equal(world.stats.macroRoomIntrusions, 0);
});

test("region packing stays architectural rather than becoming separated islands", () => {
  const world = generateWorld("reference-shape-check", { regionCount: 44, density: 1, loopChance: 0.18 });
  assert.ok(world.stats.meanTreeCorridorLength < 120, "mean tree corridor length was " + world.stats.meanTreeCorridorLength);
  assert.ok(world.stats.roomAreaRatio > 0.025, "room area ratio was " + world.stats.roomAreaRatio);
  assert.ok(world.stats.roomAreaRatio < 0.55, "room area ratio was " + world.stats.roomAreaRatio);
  assert.ok(new Set(world.regions.map((region) => region.dna.id)).size >= 4);
});
