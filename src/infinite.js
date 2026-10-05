import { ARCHITECTURE_DNA } from "./dna.js";
import { addressSeed, chance, rand01, randInt, randRange, signed } from "./prng.js";
import { boundsOfRects, centerOf, inflate, intersects, rect, unionBounds } from "./geometry.js";
import { buildRoomSpatialIndex, routeRoomsObstacleAware } from "./routing.js";

export const INFINITE_SECTOR_SIZE = 360;

export const DEFAULT_INFINITE_CONFIG = Object.freeze({
  density: 1,
  loopChance: 0.18,
  centerX: 0,
  centerY: 0,
  radius: 3,
});

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfig(config = {}) {
  return {
    density: clamp(Number(config.density ?? DEFAULT_INFINITE_CONFIG.density), 0.4, 1.7),
    loopChance: clamp(Number(config.loopChance ?? DEFAULT_INFINITE_CONFIG.loopChance), 0, 0.5),
    centerX: Math.trunc(Number(config.centerX ?? DEFAULT_INFINITE_CONFIG.centerX) || 0),
    centerY: Math.trunc(Number(config.centerY ?? DEFAULT_INFINITE_CONFIG.centerY) || 0),
    radius: clamp(Math.round(Number(config.radius ?? DEFAULT_INFINITE_CONFIG.radius) || 3), 1, 7),
  };
}

function cellKey(x, y) {
  return x + "," + y;
}

function chooseDna(seed, x, y) {
  return ARCHITECTURE_DNA[randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "sector", x, y, "dna")];
}

function parentCell(seed, x, y) {
  if (x === 0 && y === 0) return null;
  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > ay) return { x: x - Math.sign(x), y };
  if (ay > ax) return { x, y: y - Math.sign(y) };
  if (chance(seed, 0.5, "sector", x, y, "parent-axis")) return { x: x - Math.sign(x), y };
  return { x, y: y - Math.sign(y) };
}

function canonicalEdge(ax, ay, bx, by) {
  const a = cellKey(ax, ay);
  const b = cellKey(bx, by);
  return a < b ? a + "|" + b : b + "|" + a;
}

function isParentLink(seed, ax, ay, bx, by) {
  const pa = parentCell(seed, ax, ay);
  if (pa && pa.x === bx && pa.y === by) return true;
  const pb = parentCell(seed, bx, by);
  return Boolean(pb && pb.x === ax && pb.y === ay);
}

function edgeIsActive(seed, ax, ay, bx, by, loopChance) {
  if (Math.abs(ax - bx) + Math.abs(ay - by) !== 1) return false;
  if (isParentLink(seed, ax, ay, bx, by)) return true;
  const p = clamp(0.10 + loopChance * 1.1, 0.10, 0.58);
  return chance(seed, p, "edge", canonicalEdge(ax, ay, bx, by), "loop");
}

function edgeType(seed, ax, ay, bx, by) {
  return isParentLink(seed, ax, ay, bx, by) ? "tree" : "loop";
}

function activeSides(seed, x, y, loopChance) {
  const neighbors = [
    { side: 0, x: x + 1, y },
    { side: 1, x, y: y + 1 },
    { side: 2, x: x - 1, y },
    { side: 3, x, y: y - 1 },
  ];
  return neighbors.filter((n) => edgeIsActive(seed, x, y, n.x, n.y, loopChance));
}

function roomDimensions(seed, x, y, dna, index, hall = false) {
  const scale = hall ? randRange(seed, 1.20, 1.62, "sector-room", x, y, index, "hall-scale") : 1;
  return {
    w: Math.round(randRange(seed, dna.roomW[0], dna.roomW[1], "sector-room", x, y, index, "w") * scale),
    h: Math.round(randRange(seed, dna.roomH[0], dna.roomH[1], "sector-room", x, y, index, "h") * scale),
  };
}

function within(rectangle, bounds, padding = 0) {
  return rectangle.x >= bounds.x + padding &&
    rectangle.y >= bounds.y + padding &&
    rectangle.x + rectangle.w <= bounds.x + bounds.w - padding &&
    rectangle.y + rectangle.h <= bounds.y + bounds.h - padding;
}

function hitsAny(rectangle, rectangles, ignoredId = null, padding = 0) {
  const probe = padding ? inflate(rectangle, padding) : rectangle;
  return rectangles.some((other) => other.id !== ignoredId && intersects(probe, other));
}

function hitsCorridors(rectangle, corridors, padding = 0) {
  const probe = padding ? inflate(rectangle, padding) : rectangle;
  return corridors.some((other) => intersects(probe, other));
}

function sideVector(side) {
  if (side === 0) return [1, 0];
  if (side === 1) return [0, 1];
  if (side === 2) return [-1, 0];
  return [0, -1];
}

function placeAttached(anchor, side, w, h, gap, offset) {
  const c = centerOf(anchor);
  if (side === 0) return rect(anchor.x + anchor.w + gap, c.y - h / 2 + offset, w, h);
  if (side === 1) return rect(c.x - w / 2 + offset, anchor.y + anchor.h + gap, w, h);
  if (side === 2) return rect(anchor.x - gap - w, c.y - h / 2 + offset, w, h);
  return rect(c.x - w / 2 + offset, anchor.y - gap - h, w, h);
}

function attachmentConnector(anchor, room, side, width, meta = {}) {
  const ac = centerOf(anchor);
  const rc = centerOf(room);
  if (side === 0 || side === 2) {
    const left = side === 0 ? anchor : room;
    const right = side === 0 ? room : anchor;
    const top = Math.max(anchor.y, room.y);
    const bottom = Math.min(anchor.y + anchor.h, room.y + room.h);
    const actualWidth = Math.max(6, Math.min(width, Math.max(6, bottom - top)));
    const y = clamp((ac.y + rc.y) / 2, top + actualWidth / 2, bottom - actualWidth / 2);
    return rect(left.x + left.w, y - actualWidth / 2, Math.max(1, right.x - left.x - left.w), actualWidth, meta);
  }
  const top = side === 1 ? anchor : room;
  const bottom = side === 1 ? room : anchor;
  const left = Math.max(anchor.x, room.x);
  const right = Math.min(anchor.x + anchor.w, room.x + room.w);
  const actualWidth = Math.max(6, Math.min(width, Math.max(6, right - left)));
  const x = clamp((ac.x + rc.x) / 2, left + actualWidth / 2, right - actualWidth / 2);
  return rect(x - actualWidth / 2, top.y + top.h, actualWidth, Math.max(1, bottom.y - top.y - top.h), meta);
}

function portalForSide(seed, x, y, side, sectorBounds, regionKey) {
  const neighbor = side === 0 ? [x + 1, y] : side === 1 ? [x, y + 1] : side === 2 ? [x - 1, y] : [x, y - 1];
  const edge = canonicalEdge(x, y, neighbor[0], neighbor[1]);
  const tangent = randRange(seed, 0.31, 0.69, "edge", edge, "portal-offset");
  const normal = 46;
  const tangential = 58;
  const inset = 8;
  let r;
  if (side === 0) {
    r = rect(sectorBounds.x + sectorBounds.w - inset - normal, sectorBounds.y + tangent * sectorBounds.h - tangential / 2, normal, tangential);
  } else if (side === 1) {
    r = rect(sectorBounds.x + tangent * sectorBounds.w - tangential / 2, sectorBounds.y + sectorBounds.h - inset - normal, tangential, normal);
  } else if (side === 2) {
    r = rect(sectorBounds.x + inset, sectorBounds.y + tangent * sectorBounds.h - tangential / 2, normal, tangential);
  } else {
    r = rect(sectorBounds.x + tangent * sectorBounds.w - tangential / 2, sectorBounds.y + inset, tangential, normal);
  }
  return {
    ...r,
    id: regionKey + ":portal:" + side,
    regionKey,
    regionId: -1,
    kind: "portal",
    variant: rand01(seed, "edge", edge, "portal-variant"),
    portalSide: side,
    edge,
  };
}

function createRoot(seed, x, y, dna, sectorBounds, regionKey) {
  const hall = chance(seed, Math.min(0.32, dna.hallChance * 1.45 + 0.04), "sector", x, y, "root-hall");
  const dims = roomDimensions(seed, x, y, dna, 0, hall);
  const maxW = Math.min(150, sectorBounds.w * 0.42);
  const maxH = Math.min(140, sectorBounds.h * 0.40);
  const w = clamp(dims.w, 62, maxW);
  const h = clamp(dims.h, 54, maxH);
  const cx = sectorBounds.x + sectorBounds.w / 2 + signed(seed, 34, "sector", x, y, "root-x");
  const cy = sectorBounds.y + sectorBounds.h / 2 + signed(seed, 34, "sector", x, y, "root-y");
  return {
    ...rect(Math.round(cx - w / 2), Math.round(cy - h / 2), Math.round(w), Math.round(h)),
    id: regionKey + ":0",
    regionKey,
    kind: hall ? "hall" : "room",
    variant: rand01(seed, "sector", x, y, "root-variant"),
  };
}

function waypointRoom(seed, x, y, regionKey, from, to, ordinal, occupied, sectorBounds) {
  const a = centerOf(from);
  const b = centerOf(to);
  const distance = Math.hypot(b.x - a.x, b.y - a.y);
  if (distance < 118) return null;
  const t = 0.50;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const px = -dy / length;
  const py = dx / length;
  const baseJitter = signed(seed, 24, "sector", x, y, "waypoint-jitter", ordinal, to.id);
  const jitters = [baseJitter, -baseJitter, 0, baseJitter * 0.45, -baseJitter * 0.45];
  for (const jitter of jitters) {
    const size = 34;
    const cx = a.x + dx * t + px * jitter;
    const cy = a.y + dy * t + py * jitter;
    const candidate = {
      ...rect(Math.round(cx - size / 2), Math.round(cy - size / 2), size, size),
      id: regionKey + ":junction:" + ordinal,
      regionKey,
      kind: "junction",
      variant: rand01(seed, "sector", x, y, "junction-variant", ordinal),
    };
    if (!within(candidate, sectorBounds, 12)) continue;
    if (hitsAny(candidate, occupied, null, 8)) continue;
    return candidate;
  }
  return null;
}

function buildReservedRoutes(seed, x, y, regionKey, root, portals, rooms, dna) {
  const routes = [];
  let junctionIndex = 0;
  const chains = [];

  for (const portal of portals) {
    const chain = [root];
    const waypoint = waypointRoom(seed, x, y, regionKey, root, portal, junctionIndex, rooms, {
      x: x * INFINITE_SECTOR_SIZE,
      y: y * INFINITE_SECTOR_SIZE,
      w: INFINITE_SECTOR_SIZE,
      h: INFINITE_SECTOR_SIZE,
    });
    if (waypoint) {
      rooms.push(waypoint);
      chain.push(waypoint);
      junctionIndex += 1;
    }
    chain.push(portal);
    chains.push(chain);
  }

  const width = Math.round(clamp((dna.corridor[0] + dna.corridor[1]) / 2, 12, 22));
  for (let chainIndex = 0; chainIndex < chains.length; chainIndex += 1) {
    const chain = chains[chainIndex];
    for (let i = 1; i < chain.length; i += 1) {
      const spatialIndex = buildRoomSpatialIndex(rooms);
      let route = routeRoomsObstacleAware({
        seed,
        routeKey: regionKey + ":portal-route:" + chainIndex + ":" + i,
        roomA: chain[i - 1],
        roomB: chain[i],
        width,
        spatialIndex,
        aggressive: false,
        meta: {
          regionId: -1,
          regionKey,
          kind: "corridor",
          sourceRoomId: chain[i - 1].id,
          targetRoomId: chain[i].id,
        },
      });
      if (!route.length) {
        route = routeRoomsObstacleAware({
          seed,
          routeKey: regionKey + ":portal-route-narrow:" + chainIndex + ":" + i,
          roomA: chain[i - 1],
          roomB: chain[i],
          width: Math.max(9, width - 5),
          spatialIndex,
          aggressive: true,
          meta: {
            regionId: -1,
            regionKey,
            kind: "corridor",
            sourceRoomId: chain[i - 1].id,
            targetRoomId: chain[i].id,
          },
        });
      }
      route.forEach((segment, segmentIndex) => {
        segment.id = regionKey + ":portal-corridor:" + chainIndex + ":" + i + ":" + segmentIndex;
        segment.regionKey = regionKey;
        segment.kind = "corridor";
      });
      routes.push(...route);
    }
  }
  return routes;
}

function growFillerRooms(seed, x, y, regionKey, dna, config, sectorBounds, root, fixedRooms, reservedCorridors) {
  const rooms = [...fixedRooms];
  const corridors = [...reservedCorridors];
  const component = rooms.filter((room) => room.kind !== "portal");
  const baseMin = Math.max(5, dna.roomCount[0] - 2);
  const baseMax = Math.max(baseMin, dna.roomCount[1] - 1);
  const target = Math.max(5, Math.round(randRange(seed, baseMin, baseMax, "sector", x, y, "room-count") * config.density));

  for (let index = rooms.length; rooms.length < target + fixedRooms.length; index += 1) {
    let accepted = false;
    for (let attempt = 0; attempt < 42; attempt += 1) {
      const anchor = component[randInt(seed, 0, component.length - 1, "sector-room", x, y, index, "anchor", attempt)];
      const side = randInt(seed, 0, 3, "sector-room", x, y, index, "side", attempt);
      const hall = chance(seed, dna.hallChance * 0.72, "sector-room", x, y, index, "hall");
      const dims = roomDimensions(seed, x, y, dna, index, hall);
      const w = clamp(dims.w, 38, 128);
      const h = clamp(dims.h, 34, 118);
      const gap = chance(seed, dna.flushChance * 0.7, "sector-room", x, y, index, "flush", attempt)
        ? 2
        : Math.round(randRange(seed, 7, Math.min(24, Math.max(10, dna.gap[1] * 0.45)), "sector-room", x, y, index, "gap", attempt));
      const offset = signed(seed, Math.min(18, (side === 0 || side === 2 ? h : w) * 0.18), "sector-room", x, y, index, "offset", attempt);
      const candidate = {
        ...placeAttached(anchor, side, Math.round(w), Math.round(h), gap, offset),
        id: regionKey + ":" + index,
        regionKey,
        kind: hall ? "hall" : "room",
        variant: rand01(seed, "sector-room", x, y, index, "variant"),
      };
      if (!within(candidate, sectorBounds, 8)) continue;
      if (hitsAny(candidate, rooms, anchor.id, 5)) continue;
      if (hitsCorridors(candidate, reservedCorridors, 3)) continue;

      const corridorWidth = Math.round(clamp(randRange(seed, dna.corridor[0], dna.corridor[1], "sector-room", x, y, index, "corridor-width"), 10, 22));
      const connector = attachmentConnector(anchor, candidate, side, corridorWidth, {
        id: regionKey + ":local:" + index,
        regionId: -1,
        regionKey,
        kind: gap <= 3 ? "doorway" : "corridor",
        sourceRoomId: anchor.id,
        targetRoomId: candidate.id,
      });
      if (hitsAny(connector, rooms, anchor.id, 1)) continue;
      if (hitsCorridors(connector, reservedCorridors, 1)) continue;

      rooms.push(candidate);
      component.push(candidate);
      corridors.push(connector);
      accepted = true;
      break;
    }
    if (!accepted && index > target + fixedRooms.length + 12) break;
  }

  return { rooms, corridors };
}

function generateSector(seed, x, y, config) {
  const key = cellKey(x, y);
  const dna = chooseDna(seed, x, y);
  const bounds = {
    x: x * INFINITE_SECTOR_SIZE,
    y: y * INFINITE_SECTOR_SIZE,
    w: INFINITE_SECTOR_SIZE,
    h: INFINITE_SECTOR_SIZE,
  };
  const sides = activeSides(seed, x, y, config.loopChance);
  const root = createRoot(seed, x, y, dna, bounds, key);
  const portals = sides.map((entry) => portalForSide(seed, x, y, entry.side, bounds, key));
  const fixedRooms = [root, ...portals];

  // Portal rooms are deterministic shared-edge anchors. Resolve rare local collisions
  // by keeping the higher-priority structural portals and moving loop-only portals inward.
  for (let i = 1; i < fixedRooms.length; i += 1) {
    const room = fixedRooms[i];
    for (let attempt = 0; attempt < 5 && hitsAny(room, fixedRooms.slice(0, i), null, 4); attempt += 1) {
      const [vx, vy] = sideVector((room.portalSide + 2) % 4);
      room.x += vx * 14;
      room.y += vy * 14;
    }
  }

  const reservedRoutes = buildReservedRoutes(seed, x, y, key, root, portals, fixedRooms, dna);
  const grown = growFillerRooms(seed, x, y, key, dna, config, bounds, root, fixedRooms, reservedRoutes);
  const regionBounds = boundsOfRects([...grown.rooms, ...grown.corridors]);
  const c = centerOf(root);

  return {
    id: -1,
    key,
    label: "S " + x + "," + y,
    cellX: x,
    cellY: y,
    x: c.x,
    y: c.y,
    dna,
    rooms: grown.rooms,
    corridors: grown.corridors,
    doors: [],
    bounds: regionBounds,
    sectorBounds: bounds,
    portals: new Map(portals.map((room) => [room.portalSide, room])),
  };
}

function bridgeBetween(a, sideA, b, sideB, width, meta) {
  const roomA = a.portals.get(sideA);
  const roomB = b.portals.get(sideB);
  if (!roomA || !roomB) return null;
  const ac = centerOf(roomA);
  const bc = centerOf(roomB);
  if (sideA === 0 || sideA === 2) {
    const left = ac.x < bc.x ? roomA : roomB;
    const right = left === roomA ? roomB : roomA;
    const y = (centerOf(left).y + centerOf(right).y) / 2;
    return rect(
      left.x + left.w,
      y - width / 2,
      Math.max(1, right.x - (left.x + left.w)),
      width,
      { ...meta, sourceRoomId: roomA.id, targetRoomId: roomB.id },
    );
  }
  const top = ac.y < bc.y ? roomA : roomB;
  const bottom = top === roomA ? roomB : roomA;
  const x = (centerOf(top).x + centerOf(bottom).x) / 2;
  return rect(
    x - width / 2,
    top.y + top.h,
    width,
    Math.max(1, bottom.y - (top.y + top.h)),
    { ...meta, sourceRoomId: roomA.id, targetRoomId: roomB.id },
  );
}

function maxCorridorSpan(world) {
  let max = 0;
  const corridors = [
    ...world.regions.flatMap((region) => region.corridors),
    ...world.macroCorridors,
  ];
  for (const corridor of corridors) max = Math.max(max, corridor.w, corridor.h);
  return max;
}

function stableSignature(world) {
  let h = 0x811c9dc5;
  const mix = (value) => {
    const s = String(value);
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };
  mix(world.seed);
  mix(world.config.density.toFixed(3));
  mix(world.config.loopChance.toFixed(3));
  for (const region of [...world.regions].sort((a, b) => a.key.localeCompare(b.key))) {
    mix(region.key + ":" + region.dna.id + ";");
    for (const room of region.rooms) mix(room.id + ":" + room.x + "," + room.y + "," + room.w + "," + room.h + ";");
    for (const corridor of region.corridors) mix(corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  }
  for (const corridor of world.macroCorridors) mix(corridor.edgeKey + ":" + corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function generateInfiniteWorld(seedInput, userConfig = {}) {
  const seed = String(seedInput ?? "").trim() || "default-seed";
  const config = normalizeConfig(userConfig);
  const regions = [];
  const byKey = new Map();

  for (let y = config.centerY - config.radius; y <= config.centerY + config.radius; y += 1) {
    for (let x = config.centerX - config.radius; x <= config.centerX + config.radius; x += 1) {
      const region = generateSector(seed, x, y, config);
      region.id = regions.length;
      for (const room of region.rooms) room.regionId = region.id;
      for (const corridor of region.corridors) corridor.regionId = region.id;
      regions.push(region);
      byKey.set(region.key, region);
    }
  }

  const edges = [];
  const macroCorridors = [];
  for (const region of regions) {
    for (const direction of [
      { dx: 1, dy: 0, sideA: 0, sideB: 2 },
      { dx: 0, dy: 1, sideA: 1, sideB: 3 },
    ]) {
      const nx = region.cellX + direction.dx;
      const ny = region.cellY + direction.dy;
      const neighbor = byKey.get(cellKey(nx, ny));
      if (!neighbor) continue;
      if (!edgeIsActive(seed, region.cellX, region.cellY, nx, ny, config.loopChance)) continue;
      const type = edgeType(seed, region.cellX, region.cellY, nx, ny);
      const edgeKey = canonicalEdge(region.cellX, region.cellY, nx, ny);
      const edge = { a: region.id, b: neighbor.id, type, routed: true, edgeKey };
      edges.push(edge);
      const width = Math.round(clamp(
        ((region.dna.corridor[0] + region.dna.corridor[1] + neighbor.dna.corridor[0] + neighbor.dna.corridor[1]) / 4),
        10,
        20,
      ));
      const bridge = bridgeBetween(region, direction.sideA, neighbor, direction.sideB, width, {
        id: "macro:" + edgeKey,
        regionId: -1,
        kind: "macro-corridor",
        edge: region.id + ":" + neighbor.id,
        edgeKey,
        edgeType: type,
      });
      if (bridge) macroCorridors.push(bridge);
    }
  }

  const allRects = [
    ...regions.flatMap((region) => region.rooms),
    ...regions.flatMap((region) => region.corridors),
    ...macroCorridors,
  ];
  const bounds = unionBounds(allRects);
  const world = {
    infinite: true,
    seed,
    seedHash: addressSeed(seed, "infinite-world").toString(16).padStart(8, "0"),
    config,
    regions,
    edges,
    macroCorridors,
    bounds,
    stats: {
      regions: regions.length,
      rooms: regions.reduce((sum, region) => sum + region.rooms.length, 0),
      localCorridors: regions.reduce((sum, region) => sum + region.corridors.length, 0),
      macroEdges: edges.length,
      maxCorridorSpan: 0,
      centerX: config.centerX,
      centerY: config.centerY,
      radius: config.radius,
    },
  };
  world.stats.maxCorridorSpan = maxCorridorSpan(world);
  world.signature = stableSignature(world);
  return world;
}

export function summarizeInfiniteDna(world) {
  const counts = new Map(ARCHITECTURE_DNA.map((dna) => [dna.id, 0]));
  for (const region of world.regions) counts.set(region.dna.id, (counts.get(region.dna.id) ?? 0) + 1);
  return counts;
}
