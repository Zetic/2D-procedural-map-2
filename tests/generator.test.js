import test from "node:test";
import assert from "node:assert/strict";
import { generateWorld } from "../src/generator.js";

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
  for (const edge of world.edges) {
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
