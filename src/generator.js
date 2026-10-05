import { ARCHITECTURE_DNA } from "./dna.js";
import { addressSeed, chance, pick, rand01, randInt, randRange, signed } from "./prng.js";
import { boundsOfRects, centerOf, inflate, intersects, nearestRectPair, rect, unionBounds } from "./geometry.js";

export const DEFAULT_CONFIG = Object.freeze({
  regionCount: 44,
  density: 1,
  loopChance: 0.18,
  regionSpacing: 520,
});

const REGION_DIRECTIONS = [
  [1, 0], [0, 1], [-1, 0], [0, -1],
  [1, 1], [-1, 1], [-1, -1], [1, -1],
];

function normalizeConfig(config = {}) {
  return {
    regionCount: Math.max(2, Math.round(config.regionCount ?? DEFAULT_CONFIG.regionCount)),
    density: Math.max(0.25, Number(config.density ?? DEFAULT_CONFIG.density)),
    loopChance: Math.max(0, Math.min(0.8, Number(config.loopChance ?? DEFAULT_CONFIG.loopChance))),
    regionSpacing: Math.max(280, Number(config.regionSpacing ?? DEFAULT_CONFIG.regionSpacing)),
  };
}

function chooseRegionDna(seed, id) {
  const index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "region", id, "dna");
  return ARCHITECTURE_DNA[index];
}

function regionCandidatePosition(seed, id, parent, attempt, spacing) {
  const direction = pick(seed, REGION_DIRECTIONS, "region", id, "direction", attempt);
  const diagonal = direction[0] !== 0 && direction[1] !== 0;
  const step = spacing * randRange(seed, 0.80, 1.24, "region", id, "distance", attempt) * (diagonal ? 0.82 : 1);
  const jitter = spacing * 0.12;
  return {
    x: parent.x + direction[0] * step + signed(seed, jitter, "region", id, "jx", attempt),
    y: parent.y + direction[1] * step + signed(seed, jitter, "region", id, "jy", attempt),
  };
}

function tooCloseToExisting(candidate, regions, minDistance) {
  return regions.some((r) => Math.hypot(candidate.x - r.x, candidate.y - r.y) < minDistance);
}

function edgeKey(a, b) {
  return Math.min(a, b) + ":" + Math.max(a, b);
}

function buildRegionTopology(seed, config) {
  const regions = [];
  const edges = [];
  const rootDna = chooseRegionDna(seed, 0);
  regions.push({ id: 0, x: 0, y: 0, parentId: null, dna: rootDna, depth: 0 });

  for (let id = 1; id < config.regionCount; id += 1) {
    const recentWindow = Math.max(3, Math.floor(Math.sqrt(id) * 2.4));
    const oldest = Math.max(0, id - recentWindow);
    let parentId = randInt(seed, oldest, id - 1, "region", id, "parent");
    if (chance(seed, 0.18, "region", id, "long-branch")) {
      parentId = randInt(seed, 0, id - 1, "region", id, "parent-any");
    }
    const parent = regions[parentId];
    let candidate = null;
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const current = regionCandidatePosition(seed, id, parent, attempt, config.regionSpacing);
      if (!tooCloseToExisting(current, regions, config.regionSpacing * 0.54) || attempt === 19) {
        candidate = current;
        break;
      }
    }
    const region = {
      id,
      x: candidate.x,
      y: candidate.y,
      parentId,
      depth: parent.depth + 1,
      dna: chooseRegionDna(seed, id),
    };
    regions.push(region);
    edges.push({ a: parentId, b: id, type: "tree" });
  }

  const edgeKeys = new Set(edges.map((e) => edgeKey(e.a, e.b)));
  for (const region of regions) {
    if (region.id === 0 || !chance(seed, config.loopChance, "region", region.id, "macro-loop")) continue;
    const candidates = regions
      .filter((other) => other.id !== region.id && other.id !== region.parentId)
      .map((other) => ({ other, d: Math.hypot(other.x - region.x, other.y - region.y) }))
      .sort((a, b) => a.d - b.d || a.other.id - b.other.id)
      .slice(0, 6);
    if (!candidates.length) continue;
    const chosen = candidates[randInt(seed, 0, candidates.length - 1, "region", region.id, "macro-loop-target")].other;
    const key = edgeKey(region.id, chosen.id);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ a: region.id, b: chosen.id, type: "loop" });
    }
  }

  return { regions, edges };
}

function roomDimensions(seed, region, dna, roomIndex, hall) {
  const scale = hall ? randRange(seed, 1.35, 1.9, "room", region.id, roomIndex, "hall-scale") : 1;
  return {
    w: Math.round(randRange(seed, dna.roomW[0], dna.roomW[1], "room", region.id, roomIndex, "w") * scale),
    h: Math.round(randRange(seed, dna.roomH[0], dna.roomH[1], "room", region.id, roomIndex, "h") * scale),
  };
}

function candidateAttachedRoom(seed, region, dna, rooms, roomIndex, attempt) {
  const recentCount = Math.min(rooms.length, Math.max(3, Math.floor(rooms.length * dna.branchBias)));
  const start = rooms.length - recentCount;
  let anchorIndex = randInt(seed, start, rooms.length - 1, "room", region.id, roomIndex, "anchor", attempt);
  if (chance(seed, 1 - dna.branchBias, "room", region.id, roomIndex, "old-anchor", attempt)) {
    anchorIndex = randInt(seed, 0, rooms.length - 1, "room", region.id, roomIndex, "anchor-any", attempt);
  }
  const anchor = rooms[anchorIndex];
  const side = randInt(seed, 0, 3, "room", region.id, roomIndex, "side", attempt);
  const hall = chance(seed, dna.hallChance, "room", region.id, roomIndex, "hall");
  const { w, h } = roomDimensions(seed, region, dna, roomIndex, hall);
  const flush = chance(seed, dna.flushChance, "room", region.id, roomIndex, "flush", attempt);
  const gap = flush ? 2 : Math.round(randRange(seed, dna.gap[0], dna.gap[1], "room", region.id, roomIndex, "gap", attempt));
  const ac = centerOf(anchor);
  let x;
  let y;
  if (side === 0) {
    x = anchor.x + anchor.w + gap;
    y = ac.y - h / 2 + signed(seed, Math.min(22, h * 0.18), "room", region.id, roomIndex, "offset", attempt);
  } else if (side === 1) {
    x = ac.x - w / 2 + signed(seed, Math.min(22, w * 0.18), "room", region.id, roomIndex, "offset", attempt);
    y = anchor.y + anchor.h + gap;
  } else if (side === 2) {
    x = anchor.x - gap - w;
    y = ac.y - h / 2 + signed(seed, Math.min(22, h * 0.18), "room", region.id, roomIndex, "offset", attempt);
  } else {
    x = ac.x - w / 2 + signed(seed, Math.min(22, w * 0.18), "room", region.id, roomIndex, "offset", attempt);
    y = anchor.y - gap - h;
  }
  return {
    anchor,
    room: rect(Math.round(x), Math.round(y), w, h, {
      id: region.id + ":" + roomIndex,
      regionId: region.id,
      kind: hall ? "hall" : "room",
      variant: rand01(seed, "room", region.id, roomIndex, "variant"),
    }),
    side,
    gap,
  };
}

function makeConnectorBetweenRects(a, b, width, id, regionId, kind = "corridor") {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const left = dx >= 0 ? a : b;
    const right = dx >= 0 ? b : a;
    const x1 = left.x + left.w;
    const x2 = right.x;
    const y = Math.max(Math.min(ac.y, bc.y), Math.max(left.y, right.y) + width / 2);
    return [rect(Math.min(x1, x2), y - width / 2, Math.max(width, Math.abs(x2 - x1)), width, { id, regionId, kind })];
  }
  const top = dy >= 0 ? a : b;
  const bottom = dy >= 0 ? b : a;
  const y1 = top.y + top.h;
  const y2 = bottom.y;
  const x = Math.max(Math.min(ac.x, bc.x), Math.max(top.x, bottom.x) + width / 2);
  return [rect(x - width / 2, Math.min(y1, y2), width, Math.max(width, Math.abs(y2 - y1)), { id, regionId, kind })];
}

function growRegion(seed, region, config) {
  const dna = region.dna;
  const minCount = Math.max(4, Math.round(dna.roomCount[0] * config.density));
  const maxCount = Math.max(minCount, Math.round(dna.roomCount[1] * config.density));
  const target = randInt(seed, minCount, maxCount, "region", region.id, "room-count");
  const rootHall = chance(seed, dna.hallChance * 1.8 + 0.08, "region", region.id, "root-hall");
  const rootDims = roomDimensions(seed, region, dna, 0, rootHall);
  const rooms = [rect(
    Math.round(region.x - rootDims.w / 2),
    Math.round(region.y - rootDims.h / 2),
    rootDims.w,
    rootDims.h,
    { id: region.id + ":0", regionId: region.id, kind: rootHall ? "hall" : "room", variant: rand01(seed, "room", region.id, 0, "variant") },
  )];
  const corridors = [];
  const doors = [];

  for (let roomIndex = 1; roomIndex < target; roomIndex += 1) {
    let placed = null;
    for (let attempt = 0; attempt < 28; attempt += 1) {
      const candidate = candidateAttachedRoom(seed, region, dna, rooms, roomIndex, attempt);
      const padded = inflate(candidate.room, 5);
      if (!rooms.some((existing) => intersects(padded, existing))) {
        placed = candidate;
        break;
      }
    }
    if (!placed) continue;
    rooms.push(placed.room);
    const width = Math.round(randRange(seed, dna.corridor[0], dna.corridor[1], "room", region.id, roomIndex, "corridor-width"));
    const connector = makeConnectorBetweenRects(
      placed.anchor,
      placed.room,
      width,
      "local:" + region.id + ":" + roomIndex,
      region.id,
      placed.gap <= 3 ? "doorway" : "corridor",
    );
    corridors.push(...connector);
    doors.push({ a: placed.anchor.id, b: placed.room.id, regionId: region.id, side: placed.side });
  }

  const connected = new Set(doors.map((d) => [d.a, d.b].sort().join("|")));
  for (let i = 0; i < rooms.length; i += 1) {
    if (!chance(seed, dna.loopChance + config.loopChance * 0.35, "region", region.id, "local-loop", i)) continue;
    const a = rooms[i];
    const ac = centerOf(a);
    const candidates = rooms
      .filter((b) => b !== a && !connected.has([a.id, b.id].sort().join("|")))
      .map((b) => ({ b, d: Math.hypot(centerOf(b).x - ac.x, centerOf(b).y - ac.y) }))
      .filter((x) => x.d < 190)
      .sort((x, y) => x.d - y.d || x.b.id.localeCompare(y.b.id));
    if (!candidates.length) continue;
    const b = candidates[0].b;
    connected.add([a.id, b.id].sort().join("|"));
    const width = Math.round((dna.corridor[0] + dna.corridor[1]) / 2);
    corridors.push(...makeConnectorBetweenRects(a, b, width, "loop:" + region.id + ":" + i, region.id, "loop-corridor"));
    doors.push({ a: a.id, b: b.id, regionId: region.id, side: -1 });
  }

  const bounds = boundsOfRects([...rooms, ...corridors]);
  return { ...region, rooms, corridors, doors, bounds };
}

function orthogonalRoute(a, b, width, seed, edge) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const horizontalFirst = chance(seed, 0.5, "macro-edge", Math.min(edge.a, edge.b), Math.max(edge.a, edge.b), "orientation");
  const half = width / 2;
  const parts = [];
  const meta = { regionId: -1, kind: "macro-corridor", edge: edge.a + ":" + edge.b };
  if (horizontalFirst) {
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    parts.push(rect(minX, ac.y - half, Math.max(width, maxX - minX), width, meta));
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    parts.push(rect(bc.x - half, minY, width, Math.max(width, maxY - minY), meta));
  } else {
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    parts.push(rect(ac.x - half, minY, width, Math.max(width, maxY - minY), meta));
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    parts.push(rect(minX, bc.y - half, Math.max(width, maxX - minX), width, meta));
  }
  return parts;
}

function connectRegions(seed, grownRegions, edges) {
  const macroCorridors = [];
  for (const edge of edges) {
    const regionA = grownRegions[edge.a];
    const regionB = grownRegions[edge.b];
    const pair = nearestRectPair(regionA.rooms, regionB.rooms);
    if (!pair) continue;
    const widthA = (regionA.dna.corridor[0] + regionA.dna.corridor[1]) / 2;
    const widthB = (regionB.dna.corridor[0] + regionB.dna.corridor[1]) / 2;
    const width = Math.round(Math.max(14, Math.min(28, (widthA + widthB) / 2)));
    const route = orthogonalRoute(pair[0], pair[1], width, seed, edge);
    route.forEach((segment, index) => {
      segment.id = "macro:" + Math.min(edge.a, edge.b) + ":" + Math.max(edge.a, edge.b) + ":" + index;
      segment.edgeType = edge.type;
    });
    macroCorridors.push(...route);
  }
  return macroCorridors;
}

function stableSignature(world) {
  let h = 0x811c9dc5;
  const mix = (text) => {
    const s = String(text);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(world.seed);
  for (const region of world.regions) {
    mix(region.id + ":" + region.dna.id + ":" + Math.round(region.x) + ":" + Math.round(region.y) + ";");
    for (const room of region.rooms) mix(room.x + "," + room.y + "," + room.w + "," + room.h + ";");
  }
  for (const edge of world.edges) mix(edge.a + "-" + edge.b + "-" + edge.type + ";");
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function generateWorld(seedInput, userConfig = {}) {
  const seed = String(seedInput ?? "").trim() || "default-seed";
  const config = normalizeConfig(userConfig);
  const topology = buildRegionTopology(seed, config);
  const regions = topology.regions.map((region) => growRegion(seed, region, config));
  const macroCorridors = connectRegions(seed, regions, topology.edges);
  const allRects = [
    ...regions.flatMap((r) => r.rooms),
    ...regions.flatMap((r) => r.corridors),
    ...macroCorridors,
  ];
  const bounds = unionBounds(allRects);
  const world = {
    seed,
    seedHash: addressSeed(seed, "world").toString(16).padStart(8, "0"),
    config,
    regions,
    edges: topology.edges,
    macroCorridors,
    bounds,
    stats: {
      regions: regions.length,
      rooms: regions.reduce((sum, r) => sum + r.rooms.length, 0),
      localCorridors: regions.reduce((sum, r) => sum + r.corridors.length, 0),
      macroEdges: topology.edges.length,
    },
  };
  world.signature = stableSignature(world);
  return world;
}

export function summarizeDna(world) {
  const counts = new Map(ARCHITECTURE_DNA.map((dna) => [dna.id, 0]));
  for (const region of world.regions) counts.set(region.dna.id, (counts.get(region.dna.id) ?? 0) + 1);
  return counts;
}
