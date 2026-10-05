import test from "node:test";
import assert from "node:assert/strict";
import { generateInfiniteWorld, INFINITE_SECTOR_SIZE } from "../src/infinite.js";
import { intersects } from "../src/geometry.js";

function regionSnapshot(region) {
  return {
    key: region.key,
    x: region.x,
    y: region.y,
    mode: region.mode,
    dna: region.dna.id,
    rooms: region.rooms.map((room) => [
      room.id,
      room.x,
      room.y,
      room.w,
      room.h,
      room.kind,
    ]),
    corridors: region.corridors.map((corridor) => [
      corridor.id,
      corridor.x,
      corridor.y,
      corridor.w,
      corridor.h,
      corridor.kind,
    ]),
  };
}

test("infinite frontier generation is deterministic", () => {
  const config = { centerX: 0, centerY: 0, radius: 2, density: 1, loopChance: 0.18 };
  const a = generateInfiniteWorld("frontier-determinism", config);
  const b = generateInfiniteWorld("frontier-determinism", config);

  assert.equal(a.signature, b.signature);
  assert.deepEqual(a.regions.map(regionSnapshot), b.regions.map(regionSnapshot));
  assert.deepEqual(
    a.macroRooms.map((room) => [room.id, room.x, room.y, room.w, room.h]),
    b.macroRooms.map((room) => [room.id, room.x, room.y, room.w, room.h]),
  );
});

test("shared architectural masses are invariant to viewport load order", () => {
  const a = generateInfiniteWorld("viewport-invariance-v3", {
    centerX: 0,
    centerY: 0,
    radius: 2,
  });
  const b = generateInfiniteWorld("viewport-invariance-v3", {
    centerX: 2,
    centerY: 1,
    radius: 2,
  });

  const aByKey = new Map(a.regions.map((region) => [region.key, regionSnapshot(region)]));
  let compared = 0;
  for (const region of b.regions) {
    if (!aByKey.has(region.key)) continue;
    assert.deepEqual(regionSnapshot(region), aByKey.get(region.key), region.key);
    compared += 1;
  }
  assert.ok(compared > 0);
});

test("far coordinates reproduce stable architecture", () => {
  const config = { centerX: 173, centerY: -241, radius: 1, density: 1.05 };
  const a = generateInfiniteWorld("far-frontier", config);
  const b = generateInfiniteWorld("far-frontier", config);

  assert.equal(a.signature, b.signature);
  assert.ok(a.regions.length > 0);
  assert.ok(a.stats.rooms > 20);
});

test("different architectural masses do not claim the same room area", () => {
  const world = generateInfiniteWorld("global-clearance-v3", {
    centerX: -2,
    centerY: 3,
    radius: 2,
    density: 1.15,
  });
  const rooms = world.regions.flatMap((region) => region.rooms);

  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      if (rooms[i].regionId === rooms[j].regionId) continue;
      assert.equal(
        intersects(rooms[i], rooms[j]),
        false,
        rooms[i].id + " overlaps " + rooms[j].id,
      );
    }
  }
});

test("architecture crosses hidden owner-cell boundaries", () => {
  const world = generateInfiniteWorld("boundaryless-frontier", {
    centerX: 0,
    centerY: 0,
    radius: 3,
    density: 1.12,
  });

  let crossingRegions = 0;
  for (const region of world.regions) {
    const minX = region.cellX * INFINITE_SECTOR_SIZE - INFINITE_SECTOR_SIZE / 2;
    const maxX = minX + INFINITE_SECTOR_SIZE;
    const minY = region.cellY * INFINITE_SECTOR_SIZE - INFINITE_SECTOR_SIZE / 2;
    const maxY = minY + INFINITE_SECTOR_SIZE;

    if (
      region.rooms.some(
        (room) =>
          room.x < minX ||
          room.y < minY ||
          room.x + room.w > maxX ||
          room.y + room.h > maxY,
      )
    ) {
      crossingRegions += 1;
    }
  }

  assert.ok(crossingRegions > 0, "all masses stayed inside hidden owner cells");
});

test("owner positions are strongly jittered instead of revealing a square lattice", () => {
  const world = generateInfiniteWorld("jittered-owners-v3", {
    centerX: 0,
    centerY: 0,
    radius: 3,
  });

  const visiblyOffset = world.regions.filter((region) => {
    const dx = Math.abs(region.x - region.cellX * INFINITE_SECTOR_SIZE);
    const dy = Math.abs(region.y - region.cellY * INFINITE_SECTOR_SIZE);
    return dx > 70 || dy > 70;
  }).length;

  assert.ok(visiblyOffset > world.regions.length * 0.62);
});

test("large compound wings dominate over transit tendrils", () => {
  const world = generateInfiniteWorld("reference-mass-balance", {
    centerX: 0,
    centerY: 0,
    radius: 3,
    density: 1.08,
    loopChance: 0.18,
  });

  const roomCounts = world.regions.map((region) => region.rooms.length);
  assert.ok(roomCounts.length > 8);
  assert.ok(Math.max(...roomCounts) >= 38, "no substantial architectural mass formed");
  assert.ok(
    world.stats.denseRegions + world.stats.mediumRegions > world.stats.transitRegions,
    "transit/tendril regions dominate the working set",
  );
  assert.ok(world.stats.roomAreaRatio > 0.02, "silhouette is too sparse");
  assert.ok(world.stats.roomAreaRatio < 0.62, "silhouette has no meaningful voids");
});

test("macro connections never become long bead chains", () => {
  const world = generateInfiniteWorld("no-bead-chains", {
    centerX: 0,
    centerY: 0,
    radius: 3,
    density: 1.05,
    loopChance: 0.2,
  });

  assert.ok(world.stats.maxMacroCorridorSpan <= 165);
  assert.ok(
    world.macroRooms.length <= world.edges.length,
    "an inter-mass edge created multiple waypoint rooms",
  );
});

test("room count varies enough to avoid repeated equal-sized clusters", () => {
  const world = generateInfiniteWorld("mass-variation", {
    centerX: 1,
    centerY: -1,
    radius: 3,
    density: 1,
  });

  const counts = world.regions.map((region) => region.rooms.length).sort((a, b) => a - b);
  assert.ok(counts.length > 6);
  const low = counts[Math.floor(counts.length * 0.2)];
  const high = counts[Math.floor(counts.length * 0.8)];
  assert.ok(high >= low * 1.6, "architectural masses are too uniform");
});
