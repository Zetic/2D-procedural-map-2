import { ARCHITECTURE_DNA } from "./dna.js";
import { addressSeed, chance, pick, rand01, randInt, randRange, signed } from "./prng.js";
import { boundsOfRects, centerOf, inflate, intersects, nearestRectPair, rect, unionBounds } from "./geometry.js";
import { buildRoomSpatialIndex, routeRoomsObstacleAware } from "./routing.js";

export const DEFAULT_CONFIG = Object.freeze({
  regionCount: 44,
  density: 1,
  loopChance: 0.18,
  regionSpacing: 440,
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
    regionSpacing: Math.max(260, Number(config.regionSpacing ?? DEFAULT_CONFIG.regionSpacing)),
  };
}

function chooseRegionDna(seed, id) {
  const index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "region", id, "dna");
  return ARCHITECTURE_DNA[index];
}

function regionCandidatePosition(seed, id, parent, attempt, spacing) {
  const direction = pick(seed, REGION_DIRECTIONS, "region", id, "direction", attempt);
  const diagonal = direction[0] !== 0 && direction[1] !== 0;
  const step = spacing * randRange(seed, 0.76, 1.18, "region", id, "distance", attempt) * (diagonal ? 0.84 : 1);
  const jitter = spacing * 0.10;
  return {
    x: parent.targetX + direction[0] * step + signed(seed, jitter, "region", id, "jx", attempt),
    y: parent.targetY + direction[1] * step + signed(seed, jitter, "region", id, "jy", attempt),
  };
}

function tooCloseToExisting(candidate, regions, minDistance) {
  return regions.some((r) => Math.hypot(candidate.x - r.targetX, candidate.y - r.targetY) < minDistance);
}

function edgeKey(a, b) {
  return Math.min(a, b) + ":" + Math.max(a, b);
}

function buildRegionTopology(seed, config) {
  const regions = [];
  const edges = [];
  const rootDna = chooseRegionDna(seed, 0);
  regions.push({ id: 0, x: 0, y: 0, targetX: 0, targetY: 0, parentId: null, dna: rootDna, depth: 0 });

  for (let id = 1; id < config.regionCount; id += 1) {
    const recentWindow = Math.max(3, Math.floor(Math.sqrt(id) * 2.4));
    const oldest = Math.max(0, id - recentWindow);
    let parentId = randInt(seed, oldest, id - 1, "region", id, "parent");
    if (chance(seed, 0.18, "region", id, "long-branch")) {
      parentId = randInt(seed, 0, id - 1, "region", id, "parent-any");
    }
    const parent = regions[parentId];
    let candidate = null;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      const current = regionCandidatePosition(seed, id, parent, attempt, config.regionSpacing);
      if (!tooCloseToExisting(current, regions, config.regionSpacing * 0.50) || attempt === 23) {
        candidate = current;
        break;
      }
    }
    const region = {
      id,
      x: candidate.x,
      y: candidate.y,
      targetX: candidate.x,
      targetY: candidate.y,
      parentId,
      depth: parent.depth + 1,
      dna: chooseRegionDna(seed, id),
    };
    regions.push(region);
    edges.push({ a: parentId, b: id, type: "tree", routed: true });
  }

  const edgeKeys = new Set(edges.map((e) => edgeKey(e.a, e.b)));
  for (const region of regions) {
    if (region.id === 0 || !chance(seed, config.loopChance, "region", region.id, "macro-loop")) continue;
    const candidates = regions
      .filter((other) => other.id !== region.id && other.id !== region.parentId)
      .map((other) => ({ other, d: Math.hypot(other.targetX - region.targetX, other.targetY - region.targetY) }))
      .sort((a, b) => a.d - b.d || a.other.id - b.other.id)
      .slice(0, 6);
    if (!candidates.length) continue;
    const chosen = candidates[randInt(seed, 0, candidates.length - 1, "region", region.id, "macro-loop-target")].other;
    const key = edgeKey(region.id, chosen.id);
    if (!edgeKeys.has(key)) {
      edgeKeys.add(key);
      edges.push({ a: region.id, b: chosen.id, type: "loop", routed: true });
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

function primarySideFromVector(dx, dy) {
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

function sideVector(side) {
  if (side === 0) return [1, 0];
  if (side === 1) return [0, 1];
  if (side === 2) return [-1, 0];
  return [0, -1];
}

function placeRectBySide(anchor, side, w, h, gap, offset = 0) {
  const ac = centerOf(anchor);
  if (side === 0) return rect(anchor.x + anchor.w + gap, ac.y - h / 2 + offset, w, h);
  if (side === 1) return rect(ac.x - w / 2 + offset, anchor.y + anchor.h + gap, w, h);
  if (side === 2) return rect(anchor.x - gap - w, ac.y - h / 2 + offset, w, h);
  return rect(ac.x - w / 2 + offset, anchor.y - gap - h, w, h);
}

function makeAttachmentConnector(anchor, room, side, width, meta = {}) {
  const ac = centerOf(anchor);
  const rc = centerOf(room);
  if (side === 0 || side === 2) {
    const left = side === 0 ? anchor : room;
    const right = side === 0 ? room : anchor;
    const overlapTop = Math.max(anchor.y, room.y);
    const overlapBottom = Math.min(anchor.y + anchor.h, room.y + room.h);
    const usable = Math.max(6, overlapBottom - overlapTop);
    const actualWidth = Math.min(width, usable);
    const desiredY = (ac.y + rc.y) / 2;
    const minY = overlapTop + actualWidth / 2;
    const maxY = overlapBottom - actualWidth / 2;
    const y = minY <= maxY ? Math.max(minY, Math.min(maxY, desiredY)) : (overlapTop + overlapBottom) / 2;
    return rect(left.x + left.w, y - actualWidth / 2, Math.max(1, right.x - (left.x + left.w)), actualWidth, meta);
  }
  const top = side === 1 ? anchor : room;
  const bottom = side === 1 ? room : anchor;
  const overlapLeft = Math.max(anchor.x, room.x);
  const overlapRight = Math.min(anchor.x + anchor.w, room.x + room.w);
  const usable = Math.max(6, overlapRight - overlapLeft);
  const actualWidth = Math.min(width, usable);
  const desiredX = (ac.x + rc.x) / 2;
  const minX = overlapLeft + actualWidth / 2;
  const maxX = overlapRight - actualWidth / 2;
  const x = minX <= maxX ? Math.max(minX, Math.min(maxX, desiredX)) : (overlapLeft + overlapRight) / 2;
  return rect(x - actualWidth / 2, top.y + top.h, actualWidth, Math.max(1, bottom.y - (top.y + top.h)), meta);
}

function roomHitsRooms(candidate, rooms, ignoredRoomId = null, padding = 0) {
  const test = padding ? inflate(candidate, padding) : candidate;
  return rooms.some((room) => room.id !== ignoredRoomId && intersects(test, room));
}

function rectHitsAny(rectangle, rectangles, padding = 0) {
  const test = padding ? inflate(rectangle, padding) : rectangle;
  return rectangles.some((other) => intersects(test, other));
}

function corridorHitsRooms(corridors, rooms, ignoredIds) {
  return corridors.some((corridor) => rooms.some((room) => !ignoredIds.has(room.id) && intersects(inflate(corridor, 1), room)));
}

function candidateAttachedRoom(seed, region, dna, rooms, roomIndex, attempt) {
  const recentCount = Math.min(rooms.length, Math.max(3, Math.floor(rooms.length * dna.branchBias)));
  const start = rooms.length - recentCount;
  let anchorIndex = randInt(seed, start, rooms.length - 1, "room", region.id, roomIndex, "anchor", attempt);
  if (chance(seed, 1 - dna.branchBias, "room", region.id, roomIndex, "old-anchor", attempt)) {
    anchorIndex = randInt(seed, 0, rooms.length - 1, "room", region.id, roomIndex, "anchor-any", attempt);
  }
  const anchor = rooms[anchorIndex];
  const randomSide = randInt(seed, 0, 3, "room", region.id, roomIndex, "side", attempt);
  const side = chance(seed, 0.42, "room", region.id, roomIndex, "outward-side", attempt)
    ? region.growthSide
    : randomSide;
  const hall = chance(seed, dna.hallChance, "room", region.id, roomIndex, "hall");
  const { w, h } = roomDimensions(seed, region, dna, roomIndex, hall);
  const flush = chance(seed, dna.flushChance, "room", region.id, roomIndex, "flush", attempt);
  const gap = flush ? 2 : Math.round(randRange(seed, dna.gap[0], dna.gap[1], "room", region.id, roomIndex, "gap", attempt));
  const offsetLimit = side === 0 || side === 2 ? Math.min(22, h * 0.18) : Math.min(22, w * 0.18);
  const offset = signed(seed, offsetLimit, "room", region.id, roomIndex, "offset", attempt);
  return {
    anchor,
    room: {
      ...placeRectBySide(anchor, side, w, h, gap, offset),
      id: region.id + ":" + roomIndex,
      regionId: region.id,
      kind: hall ? "hall" : "room",
      variant: rand01(seed, "room", region.id, roomIndex, "variant"),
    },
    side,
    gap,
  };
}

function chooseParentBoundaryRooms(parent, dx, dy) {
  const length = Math.hypot(dx, dy) || 1;
  const nx = dx / length;
  const ny = dy / length;
  const pc = { x: parent.x, y: parent.y };
  return parent.rooms
    .map((room) => {
      const c = centerOf(room);
      return { room, score: (c.x - pc.x) * nx + (c.y - pc.y) * ny };
    })
    .sort((a, b) => b.score - a.score || a.room.id.localeCompare(b.room.id))
    .map((entry) => entry.room);
}

function placeRegionRoot(seed, region, parent, occupiedRooms, reservedCorridors) {
  const dna = region.dna;
  const rootHall = chance(seed, dna.hallChance * 1.8 + 0.08, "region", region.id, "root-hall");
  const dims = roomDimensions(seed, region, dna, 0, rootHall);
  const rootMeta = {
    id: region.id + ":0",
    regionId: region.id,
    kind: rootHall ? "hall" : "room",
    variant: rand01(seed, "room", region.id, 0, "variant"),
  };

  if (!parent) {
    return {
      room: rect(Math.round(-dims.w / 2), Math.round(-dims.h / 2), dims.w, dims.h, rootMeta),
      entryCorridor: null,
      parentAnchorId: null,
      growthSide: randInt(seed, 0, 3, "region", region.id, "root-growth-side"),
    };
  }

  const dx = region.targetX - parent.targetX;
  const dy = region.targetY - parent.targetY;
  const primarySide = primarySideFromVector(dx, dy);
  const boundaryRooms = chooseParentBoundaryRooms(parent, dx, dy);
  const topRooms = boundaryRooms.slice(0, Math.min(10, boundaryRooms.length));

  for (let attempt = 0; attempt < 120; attempt += 1) {
    const anchor = topRooms[randInt(seed, 0, topRooms.length - 1, "region", region.id, "entry-anchor", attempt)];
    const side = attempt < 72
      ? (chance(seed, 0.78, "region", region.id, "entry-primary", attempt) ? primarySide : randInt(seed, 0, 3, "region", region.id, "entry-side", attempt))
      : (primarySide + attempt) % 4;
    const flush = chance(seed, Math.min(0.26, dna.flushChance * 0.65), "region", region.id, "entry-flush", attempt);
    const gap = flush
      ? 2
      : Math.round(randRange(seed, Math.max(10, dna.gap[0]), Math.max(34, dna.gap[1] * 0.92), "region", region.id, "entry-gap", attempt));
    const offsetLimit = side === 0 || side === 2 ? Math.min(34, dims.h * 0.24) : Math.min(34, dims.w * 0.24);
    const offset = signed(seed, offsetLimit, "region", region.id, "entry-offset", attempt);
    const candidate = {
      ...placeRectBySide(anchor, side, dims.w, dims.h, gap, offset),
      ...rootMeta,
    };
    if (roomHitsRooms(candidate, occupiedRooms, anchor.id, 5)) continue;
    if (rectHitsAny(candidate, reservedCorridors, 3)) continue;

    const width = Math.round(randRange(seed, dna.corridor[0], dna.corridor[1], "region", region.id, "entry-width"));
    const corridor = makeAttachmentConnector(anchor, candidate, side, width, {
      regionId: -1,
      kind: "macro-corridor",
      edge: parent.id + ":" + region.id,
      edgeType: "tree",
      sourceRoomId: anchor.id,
      targetRoomId: candidate.id,
    });
    if (corridorHitsRooms([corridor], occupiedRooms, new Set([anchor.id]))) continue;

    return {
      room: candidate,
      entryCorridor: corridor,
      parentAnchorId: anchor.id,
      growthSide: side,
    };
  }

  const direction = sideVector(primarySide);
  const parentBounds = parent.bounds;
  for (let ring = 1; ring <= 80; ring += 1) {
    const distance = Math.max(parentBounds.w, parentBounds.h) / 2 + 90 + ring * 34;
    const lateral = signed(seed, 80 + ring * 8, "region", region.id, "fallback-lateral", ring);
    let cx = parent.x + direction[0] * distance;
    let cy = parent.y + direction[1] * distance;
    if (direction[0] !== 0) cy += lateral;
    else cx += lateral;
    const candidate = rect(Math.round(cx - dims.w / 2), Math.round(cy - dims.h / 2), dims.w, dims.h, rootMeta);
    if (roomHitsRooms(candidate, occupiedRooms, null, 8)) continue;
    if (rectHitsAny(candidate, reservedCorridors, 5)) continue;
    return {
      room: candidate,
      entryCorridor: null,
      parentAnchorId: null,
      growthSide: primarySide,
    };
  }

  throw new Error("Unable to place deterministic root room for region " + region.id);
}

function growRegion(seed, region, parent, config, occupiedRooms, reservedCorridors) {
  const dna = region.dna;
  const minCount = Math.max(4, Math.round(dna.roomCount[0] * config.density));
  const maxCount = Math.max(minCount, Math.round(dna.roomCount[1] * config.density));
  const target = randInt(seed, minCount, maxCount, "region", region.id, "room-count");
  const rootPlacement = placeRegionRoot(seed, region, parent, occupiedRooms, reservedCorridors);
  const root = rootPlacement.room;
  const rootCenter = centerOf(root);
  const grown = {
    ...region,
    x: rootCenter.x,
    y: rootCenter.y,
    growthSide: rootPlacement.growthSide,
    parentAnchorId: rootPlacement.parentAnchorId,
    entryCorridor: rootPlacement.entryCorridor,
  };
  const rooms = [root];
  const corridors = [];
  const doors = [];
  occupiedRooms.push(root);
  if (rootPlacement.entryCorridor) reservedCorridors.push(rootPlacement.entryCorridor);

  for (let roomIndex = 1; roomIndex < target; roomIndex += 1) {
    let placed = null;
    let connector = null;
    for (let attempt = 0; attempt < 36; attempt += 1) {
      const candidate = candidateAttachedRoom(seed, grown, dna, rooms, roomIndex, attempt);
      if (roomHitsRooms(candidate.room, occupiedRooms, candidate.anchor.id, 5)) continue;
      if (rectHitsAny(candidate.room, reservedCorridors, 3)) continue;
      const width = Math.round(randRange(seed, dna.corridor[0], dna.corridor[1], "room", region.id, roomIndex, "corridor-width"));
      const currentConnector = makeAttachmentConnector(
        candidate.anchor,
        candidate.room,
        candidate.side,
        width,
        {
          id: "local:" + region.id + ":" + roomIndex,
          regionId: region.id,
          kind: candidate.gap <= 3 ? "doorway" : "corridor",
          sourceRoomId: candidate.anchor.id,
          targetRoomId: candidate.room.id,
        },
      );
      if (corridorHitsRooms([currentConnector], occupiedRooms, new Set([candidate.anchor.id]))) continue;
      placed = candidate;
      connector = currentConnector;
      break;
    }
    if (!placed) continue;
    rooms.push(placed.room);
    occupiedRooms.push(placed.room);
    corridors.push(connector);
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
      .filter((x) => x.d < 175)
      .sort((x, y) => x.d - y.d || x.b.id.localeCompare(y.b.id));
    if (!candidates.length) continue;
    const b = candidates[0].b;
    const width = Math.round((dna.corridor[0] + dna.corridor[1]) / 2);
    const dx = centerOf(b).x - ac.x;
    const dy = centerOf(b).y - ac.y;
    const side = primarySideFromVector(dx, dy);
    const loopConnector = makeAttachmentConnector(a, b, side, width, {
      id: "loop:" + region.id + ":" + i,
      regionId: region.id,
      kind: "loop-corridor",
      sourceRoomId: a.id,
      targetRoomId: b.id,
    });
    if (loopConnector.w <= 1 || loopConnector.h <= 1) continue;
    if (corridorHitsRooms([loopConnector], occupiedRooms, new Set([a.id, b.id]))) continue;
    connected.add([a.id, b.id].sort().join("|"));
    corridors.push(loopConnector);
    doors.push({ a: a.id, b: b.id, regionId: region.id, side: -1 });
  }

  const bounds = boundsOfRects([...rooms, ...corridors]);
  return { ...grown, rooms, corridors, doors, bounds };
}

function findRoomById(regions, id) {
  for (const region of regions) {
    const room = region.rooms.find((candidate) => candidate.id === id);
    if (room) return room;
  }
  return null;
}

function connectRegions(seed, grownRegions, edges) {
  const rooms = grownRegions.flatMap((region) => region.rooms);
  const spatialIndex = buildRoomSpatialIndex(rooms);
  const macroCorridors = [];

  for (const region of grownRegions) {
    if (!region.entryCorridor) continue;
    const corridor = { ...region.entryCorridor };
    corridor.id = "macro:" + region.parentId + ":" + region.id + ":0";
    macroCorridors.push(corridor);
  }

  for (const edge of edges) {
    const regionA = grownRegions[edge.a];
    const regionB = grownRegions[edge.b];
    if (edge.type === "tree" && regionB.parentId === edge.a && regionB.entryCorridor) continue;
    if (edge.type === "tree" && regionA.parentId === edge.b && regionA.entryCorridor) continue;

    let pair = null;
    if (edge.type === "tree") {
      const child = regionB.parentId === edge.a ? regionB : regionA;
      const parent = child === regionB ? regionA : regionB;
      const childRoot = child.rooms[0];
      const parentRoom = child.parentAnchorId ? findRoomById(grownRegions, child.parentAnchorId) : null;
      pair = parentRoom ? [parentRoom, childRoot] : nearestRectPair(parent.rooms, child.rooms);
    } else {
      pair = nearestRectPair(regionA.rooms, regionB.rooms);
    }
    if (!pair) {
      edge.routed = false;
      continue;
    }

    const widthA = (regionA.dna.corridor[0] + regionA.dna.corridor[1]) / 2;
    const widthB = (regionB.dna.corridor[0] + regionB.dna.corridor[1]) / 2;
    const width = Math.round(Math.max(14, Math.min(28, (widthA + widthB) / 2)));
    const routeKey = Math.min(edge.a, edge.b) + ":" + Math.max(edge.a, edge.b) + ":" + edge.type;
    const route = routeRoomsObstacleAware({
      seed,
      routeKey,
      roomA: pair[0],
      roomB: pair[1],
      width,
      spatialIndex,
      meta: {
        regionId: -1,
        kind: "macro-corridor",
        edge: edge.a + ":" + edge.b,
        edgeType: edge.type,
      },
    });
    if (!route.length) {
      edge.routed = false;
      continue;
    }
    route.forEach((segment, index) => {
      segment.id = "macro:" + Math.min(edge.a, edge.b) + ":" + Math.max(edge.a, edge.b) + ":" + index;
    });
    macroCorridors.push(...route);
  }

  return macroCorridors;
}

function countRoomOverlaps(regions) {
  const rooms = regions.flatMap((region) => region.rooms);
  let overlaps = 0;
  for (let i = 0; i < rooms.length; i += 1) {
    for (let j = i + 1; j < rooms.length; j += 1) {
      if (intersects(rooms[i], rooms[j])) overlaps += 1;
    }
  }
  return overlaps;
}

function countMacroRoomIntrusions(regions, macroCorridors) {
  const rooms = regions.flatMap((region) => region.rooms);
  let intrusions = 0;
  for (const corridor of macroCorridors) {
    for (const room of rooms) {
      if (room.id === corridor.sourceRoomId || room.id === corridor.targetRoomId) continue;
      if (intersects(corridor, room)) intrusions += 1;
    }
  }
  return intrusions;
}

function corridorLength(corridor) {
  return corridor.w >= corridor.h ? corridor.w : corridor.h;
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
  mix(JSON.stringify(world.config));
  for (const region of world.regions) {
    mix(region.id + ":" + region.dna.id + ":" + Math.round(region.x) + ":" + Math.round(region.y) + ";");
    for (const room of region.rooms) mix(room.x + "," + room.y + "," + room.w + "," + room.h + ";");
    for (const corridor of region.corridors) mix(corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  }
  for (const edge of world.edges) mix(edge.a + "-" + edge.b + "-" + edge.type + "-" + edge.routed + ";");
  for (const corridor of world.macroCorridors) mix(corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function generateWorld(seedInput, userConfig = {}) {
  const seed = String(seedInput ?? "").trim() || "default-seed";
  const config = normalizeConfig(userConfig);
  const topology = buildRegionTopology(seed, config);
  const occupiedRooms = [];
  const reservedTreeCorridors = [];
  const regions = [];

  for (const region of topology.regions) {
    const parent = region.parentId === null ? null : regions[region.parentId];
    regions.push(growRegion(seed, region, parent, config, occupiedRooms, reservedTreeCorridors));
  }

  const macroCorridors = connectRegions(seed, regions, topology.edges);
  const allRects = [
    ...regions.flatMap((r) => r.rooms),
    ...regions.flatMap((r) => r.corridors),
    ...macroCorridors,
  ];
  const bounds = unionBounds(allRects);
  const totalRoomArea = regions.flatMap((r) => r.rooms).reduce((sum, room) => sum + room.w * room.h, 0);
  const roomOverlaps = countRoomOverlaps(regions);
  const macroRoomIntrusions = countMacroRoomIntrusions(regions, macroCorridors);
  const failedRoutes = topology.edges.filter((edge) => !edge.routed).length;
  const treeCorridors = macroCorridors.filter((corridor) => corridor.edgeType === "tree");
  const meanTreeCorridorLength = treeCorridors.length
    ? treeCorridors.reduce((sum, corridor) => sum + corridorLength(corridor), 0) / treeCorridors.length
    : 0;
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
      roomOverlaps,
      macroRoomIntrusions,
      failedRoutes,
      meanTreeCorridorLength,
      roomAreaRatio: totalRoomArea / Math.max(1, bounds.w * bounds.h),
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
