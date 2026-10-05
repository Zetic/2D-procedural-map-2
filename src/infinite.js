import { ARCHITECTURE_DNA } from "./dna.js";
import { addressSeed, chance, rand01, randInt, randRange, signed } from "./prng.js";
import { boundsOfRects, centerOf, inflate, intersects, rect, unionBounds } from "./geometry.js";

export const INFINITE_SECTOR_SIZE = 760;

export const DEFAULT_INFINITE_CONFIG = Object.freeze({
  density: 1,
  loopChance: 0.18,
  centerX: 0,
  centerY: 0,
  radius: 2,
});

const OWNER_HALO = 3;
const BUCKET_SIZE = 160;
const NEIGHBOR_OFFSETS = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],            [1, 0],
  [-1, 1],  [0, 1],   [1, 1],
];

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function normalizeConfig(config = {}) {
  return {
    density: clamp(Number(config.density ?? DEFAULT_INFINITE_CONFIG.density), 0.4, 1.7),
    loopChance: clamp(Number(config.loopChance ?? DEFAULT_INFINITE_CONFIG.loopChance), 0, 0.5),
    centerX: Math.trunc(Number(config.centerX ?? DEFAULT_INFINITE_CONFIG.centerX) || 0),
    centerY: Math.trunc(Number(config.centerY ?? DEFAULT_INFINITE_CONFIG.centerY) || 0),
    radius: clamp(Math.round(Number(config.radius ?? DEFAULT_INFINITE_CONFIG.radius) || 2), 1, 5),
  };
}

function cellKey(x, y) {
  return x + "," + y;
}

function pairKey(a, b) {
  return a < b ? a + "|" + b : b + "|" + a;
}

function zoneCoord(value, size) {
  return Math.floor(value / size);
}

function sitePosition(seed, x, y) {
  const jitter = INFINITE_SECTOR_SIZE * 0.42;
  const zoneX = zoneCoord(x, 4);
  const zoneY = zoneCoord(y, 4);
  return {
    x:
      x * INFINITE_SECTOR_SIZE +
      signed(seed, jitter, "owner", x, y, "jitter-x") +
      signed(seed, 110, "macro-warp", zoneX, zoneY, "x"),
    y:
      y * INFINITE_SECTOR_SIZE +
      signed(seed, jitter, "owner", x, y, "jitter-y") +
      signed(seed, 110, "macro-warp", zoneX, zoneY, "y"),
  };
}

function activityProbability(seed, x, y) {
  const zoneX = zoneCoord(x, 4);
  const zoneY = zoneCoord(y, 4);
  const zone = rand01(seed, "activity-zone", zoneX, zoneY);
  if (zone < 0.14) return 0.38;
  if (zone < 0.30) return 0.68;
  if (zone > 0.86) return 0.98;
  return 0.88;
}

function siteIsActive(seed, x, y) {
  if (x === 0 && y === 0) return true;
  return chance(seed, activityProbability(seed, x, y), "owner", x, y, "active");
}

function chooseDna(seed, x, y) {
  const zoneX = zoneCoord(x + 1, 4);
  const zoneY = zoneCoord(y - 1, 4);
  let index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "dna-zone", zoneX, zoneY);
  if (chance(seed, 0.14, "owner", x, y, "dna-mutation")) {
    index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "owner", x, y, "dna");
  }
  return ARCHITECTURE_DNA[index];
}

function chooseMode(seed, x, y) {
  const zoneX = zoneCoord(x, 4);
  const zoneY = zoneCoord(y, 4);
  const zone = rand01(seed, "activity-zone", zoneX, zoneY);
  const roll = rand01(seed, "owner", x, y, "mass-mode");

  if (zone < 0.14) return roll < 0.55 ? "transit" : "medium";
  if (zone > 0.86) return roll < 0.76 ? "dense" : "medium";
  if (roll < 0.58) return "dense";
  if (roll < 0.88) return "medium";
  return "transit";
}

function colonyPriority(seed, x, y) {
  return rand01(seed, "owner", x, y, "priority");
}

class SpatialIndex {
  constructor() {
    this.rooms = new Map();
    this.buckets = new Map();
  }

  bucketKey(x, y) {
    return x + "," + y;
  }

  bucketRange(r) {
    return {
      minX: Math.floor(r.x / BUCKET_SIZE),
      maxX: Math.floor((r.x + r.w) / BUCKET_SIZE),
      minY: Math.floor(r.y / BUCKET_SIZE),
      maxY: Math.floor((r.y + r.h) / BUCKET_SIZE),
    };
  }

  add(r) {
    this.rooms.set(r.id, r);
    const range = this.bucketRange(r);
    for (let by = range.minY; by <= range.maxY; by += 1) {
      for (let bx = range.minX; bx <= range.maxX; bx += 1) {
        const key = this.bucketKey(bx, by);
        if (!this.buckets.has(key)) this.buckets.set(key, new Set());
        this.buckets.get(key).add(r.id);
      }
    }
  }

  candidates(area) {
    const ids = new Set();
    const range = this.bucketRange(area);
    for (let by = range.minY; by <= range.maxY; by += 1) {
      for (let bx = range.minX; bx <= range.maxX; bx += 1) {
        const bucket = this.buckets.get(this.bucketKey(bx, by));
        if (!bucket) continue;
        for (const id of bucket) ids.add(id);
      }
    }
    return [...ids].map((id) => this.rooms.get(id));
  }

  intersects(area, ignored = new Set(), padding = 0) {
    const probe = padding ? inflate(area, padding) : area;
    return this.candidates(probe).some(
      (candidate) => candidate && !ignored.has(candidate.id) && intersects(probe, candidate),
    );
  }
}

function sideVector(side) {
  if (side === 0) return [1, 0];
  if (side === 1) return [0, 1];
  if (side === 2) return [-1, 0];
  return [0, -1];
}

function preferredSide(from, to) {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 0 : 2;
  return dy >= 0 ? 1 : 3;
}

function placeAttached(anchor, side, w, h, gap, offset) {
  const c = centerOf(anchor);
  if (side === 0) return rect(anchor.x + anchor.w + gap, c.y - h / 2 + offset, w, h);
  if (side === 1) return rect(c.x - w / 2 + offset, anchor.y + anchor.h + gap, w, h);
  if (side === 2) return rect(anchor.x - gap - w, c.y - h / 2 + offset, w, h);
  return rect(c.x - w / 2 + offset, anchor.y - gap - h, w, h);
}

function makeConnector(anchor, room, side, width, meta) {
  const ac = centerOf(anchor);
  const rc = centerOf(room);

  if (side === 0 || side === 2) {
    const left = side === 0 ? anchor : room;
    const right = side === 0 ? room : anchor;
    const overlapTop = Math.max(anchor.y, room.y);
    const overlapBottom = Math.min(anchor.y + anchor.h, room.y + room.h);
    const usable = Math.max(6, overlapBottom - overlapTop);
    const actualWidth = Math.min(width, usable);
    const y = clamp(
      (ac.y + rc.y) / 2,
      overlapTop + actualWidth / 2,
      overlapBottom - actualWidth / 2,
    );
    return rect(
      left.x + left.w,
      y - actualWidth / 2,
      Math.max(1, right.x - left.x - left.w),
      actualWidth,
      meta,
    );
  }

  const top = side === 1 ? anchor : room;
  const bottom = side === 1 ? room : anchor;
  const overlapLeft = Math.max(anchor.x, room.x);
  const overlapRight = Math.min(anchor.x + anchor.w, room.x + room.w);
  const usable = Math.max(6, overlapRight - overlapLeft);
  const actualWidth = Math.min(width, usable);
  const x = clamp(
    (ac.x + rc.x) / 2,
    overlapLeft + actualWidth / 2,
    overlapRight - actualWidth / 2,
  );
  return rect(
    x - actualWidth / 2,
    top.y + top.h,
    actualWidth,
    Math.max(1, bottom.y - top.y - top.h),
    meta,
  );
}

function roomDimensions(seed, owner, dna, index, hall) {
  const scale =
    owner.mode === "dense"
      ? randRange(seed, 0.94, 1.24, "owner", owner.key, "room-scale")
      : owner.mode === "medium"
        ? randRange(seed, 0.88, 1.14, "owner", owner.key, "room-scale")
        : randRange(seed, 0.76, 1.02, "owner", owner.key, "room-scale");
  const hallScale = hall
    ? randRange(seed, 1.25, 1.75, "room", owner.key, index, "hall-scale")
    : 1;

  return {
    w: Math.round(
      clamp(
        randRange(seed, dna.roomW[0], dna.roomW[1], "room", owner.key, index, "w") *
          scale *
          hallScale,
        30,
        owner.mode === "dense" ? 190 : 152,
      ),
    ),
    h: Math.round(
      clamp(
        randRange(seed, dna.roomH[0], dna.roomH[1], "room", owner.key, index, "h") *
          scale *
          hallScale,
        28,
        owner.mode === "dense" ? 170 : 140,
      ),
    ),
  };
}

function makeLobes(seed, owner) {
  const mode = owner.mode;
  const baseRadius =
    mode === "dense"
      ? randRange(seed, 360, 535, "owner", owner.key, "radius")
      : mode === "medium"
        ? randRange(seed, 285, 430, "owner", owner.key, "radius")
        : randRange(seed, 210, 335, "owner", owner.key, "radius");

  const elongated = chance(seed, mode === "transit" ? 0.86 : 0.48, "owner", owner.key, "elongated");
  const horizontal = chance(seed, 0.5, "owner", owner.key, "major-axis");
  const rx = elongated ? baseRadius * (horizontal ? 1.18 : 0.62) : baseRadius;
  const ry = elongated ? baseRadius * (horizontal ? 0.62 : 1.18) : baseRadius;

  const lobeCount =
    mode === "dense"
      ? randInt(seed, 2, 4, "owner", owner.key, "lobe-count")
      : mode === "medium"
        ? randInt(seed, 1, 3, "owner", owner.key, "lobe-count")
        : randInt(seed, 1, 2, "owner", owner.key, "lobe-count");

  const lobes = [{ x: owner.x, y: owner.y, rx, ry }];
  for (let i = 1; i < lobeCount; i += 1) {
    const side = randInt(seed, 0, 3, "owner", owner.key, "lobe-side", i);
    const [sx, sy] = sideVector(side);
    const reach = randRange(seed, 0.28, 0.58, "owner", owner.key, "lobe-reach", i);
    lobes.push({
      x: owner.x + sx * rx * reach + signed(seed, 70, "owner", owner.key, "lobe-jx", i),
      y: owner.y + sy * ry * reach + signed(seed, 70, "owner", owner.key, "lobe-jy", i),
      rx: rx * randRange(seed, 0.54, 0.82, "owner", owner.key, "lobe-rx", i),
      ry: ry * randRange(seed, 0.54, 0.82, "owner", owner.key, "lobe-ry", i),
    });
  }
  return lobes;
}

function pointInsideLobes(point, lobes) {
  return lobes.some((lobe) => {
    const dx = (point.x - lobe.x) / Math.max(1, lobe.rx);
    const dy = (point.y - lobe.y) / Math.max(1, lobe.ry);
    return dx * dx + dy * dy <= 1;
  });
}

function targetRoomCount(seed, owner, dna, density) {
  const factor =
    owner.mode === "dense"
      ? randRange(seed, 2.6, 4.4, "owner", owner.key, "count-factor")
      : owner.mode === "medium"
        ? randRange(seed, 1.65, 2.8, "owner", owner.key, "count-factor")
        : randRange(seed, 0.72, 1.28, "owner", owner.key, "count-factor");

  const midpoint = (dna.roomCount[0] + dna.roomCount[1]) / 2;
  return Math.round(clamp(midpoint * factor * density, owner.mode === "transit" ? 12 : 28, 125));
}

function rootCandidate(seed, owner, dna, attempt) {
  const hall =
    owner.mode === "dense" &&
    chance(seed, Math.min(0.42, dna.hallChance * 1.8 + 0.08), "owner", owner.key, "root-hall");
  const dims = roomDimensions(seed, owner, dna, 0, hall);
  const offset = attempt === 0
    ? { x: 0, y: 0 }
    : {
        x: signed(seed, 130, "owner", owner.key, "root-shift-x", attempt),
        y: signed(seed, 130, "owner", owner.key, "root-shift-y", attempt),
      };

  return {
    ...rect(
      Math.round(owner.x + offset.x - dims.w / 2),
      Math.round(owner.y + offset.y - dims.h / 2),
      dims.w,
      dims.h,
    ),
    id: owner.key + ":0",
    ownerKey: owner.key,
    regionKey: owner.key,
    kind: hall ? "hall" : "room",
    variant: rand01(seed, "owner", owner.key, "root-variant"),
    growthSide: randInt(seed, 0, 3, "owner", owner.key, "root-side"),
    depth: 0,
    childCount: 0,
  };
}

function chooseAnchor(seed, owner, rooms, index, attempt) {
  const frontier = rooms.filter((room) => room.childCount < (owner.mode === "dense" ? 4 : 3));
  const pool = frontier.length ? frontier : rooms;
  const recentBias = owner.mode === "dense" ? 0.58 : owner.mode === "medium" ? 0.67 : 0.78;

  if (chance(seed, recentBias, "room", owner.key, index, "recent-anchor", attempt)) {
    const start = Math.max(0, pool.length - Math.max(8, Math.floor(pool.length * 0.45)));
    return pool[randInt(seed, start, pool.length - 1, "room", owner.key, index, "anchor-recent", attempt)];
  }

  return pool[randInt(seed, 0, pool.length - 1, "room", owner.key, index, "anchor-any", attempt)];
}

function chooseGrowthSide(seed, owner, anchor, lobe, index, attempt) {
  const ac = centerOf(anchor);
  const towardLobe = preferredSide(ac, lobe);

  const continueChance = owner.mode === "transit" ? 0.52 : owner.mode === "medium" ? 0.28 : 0.18;
  const lobeChance = owner.mode === "dense" ? 0.56 : owner.mode === "medium" ? 0.48 : 0.34;
  const roll = rand01(seed, "room", owner.key, index, "side-roll", attempt);

  if (roll < continueChance) return anchor.growthSide ?? towardLobe;
  if (roll < continueChance + lobeChance) return towardLobe;
  return randInt(seed, 0, 3, "room", owner.key, index, "side", attempt);
}

function gapFor(seed, owner, dna, index, attempt) {
  const flushChance =
    owner.mode === "dense"
      ? Math.min(0.72, 0.46 + dna.flushChance * 0.65)
      : owner.mode === "medium"
        ? Math.min(0.56, 0.30 + dna.flushChance * 0.55)
        : Math.min(0.34, 0.14 + dna.flushChance * 0.42);

  if (chance(seed, flushChance, "room", owner.key, index, "flush", attempt)) {
    return randInt(seed, 0, 3, "room", owner.key, index, "flush-gap", attempt);
  }

  const tendrilChance = owner.mode === "transit" ? 0.20 : owner.mode === "medium" ? 0.10 : 0.055;
  if (chance(seed, tendrilChance, "room", owner.key, index, "tendril-gap", attempt)) {
    return randInt(seed, 24, 58, "room", owner.key, index, "long-gap", attempt);
  }

  return randInt(
    seed,
    5,
    Math.min(24, Math.max(10, Math.round(dna.gap[1] * 0.42))),
    "room",
    owner.key,
    index,
    "gap",
    attempt,
  );
}

function tryAddRoom(seed, owner, dna, rooms, corridors, lobes, index, spatial) {
  for (let attempt = 0; attempt < 46; attempt += 1) {
    const anchor = chooseAnchor(seed, owner, rooms, index, attempt);
    const lobe = lobes[randInt(seed, 0, lobes.length - 1, "room", owner.key, index, "lobe", attempt)];
    const side = chooseGrowthSide(seed, owner, anchor, lobe, index, attempt);
    const hall = chance(
      seed,
      owner.mode === "dense" ? dna.hallChance * 0.86 : dna.hallChance * 0.48,
      "room",
      owner.key,
      index,
      "hall",
    );
    const dims = roomDimensions(seed, owner, dna, index, hall);
    const gap = gapFor(seed, owner, dna, index, attempt);
    const offsetLimit = Math.min(26, (side === 0 || side === 2 ? dims.h : dims.w) * 0.24);
    const offset = signed(seed, offsetLimit, "room", owner.key, index, "offset", attempt);

    const candidate = {
      ...placeAttached(anchor, side, dims.w, dims.h, gap, offset),
      id: owner.key + ":" + index,
      ownerKey: owner.key,
      regionKey: owner.key,
      kind: hall ? "hall" : "room",
      variant: rand01(seed, "room", owner.key, index, "variant"),
      growthSide: side,
      depth: (anchor.depth ?? 0) + 1,
      childCount: 0,
    };

    if (!pointInsideLobes(centerOf(candidate), lobes)) continue;
    if (spatial.intersects(candidate, new Set([anchor.id]), 5)) continue;

    const width = Math.round(
      clamp(
        randRange(seed, dna.corridor[0], dna.corridor[1], "room", owner.key, index, "corridor-width"),
        10,
        24,
      ),
    );
    const connector = makeConnector(anchor, candidate, side, width, {
      id: owner.key + ":corridor:" + index,
      ownerKey: owner.key,
      regionKey: owner.key,
      kind: gap <= 3 ? "doorway" : "corridor",
      sourceRoomId: anchor.id,
      targetRoomId: candidate.id,
    });

    if (spatial.intersects(connector, new Set([anchor.id]), 1)) continue;

    anchor.childCount += 1;
    rooms.push(candidate);
    corridors.push(connector);
    spatial.add(candidate);
    return true;
  }

  return false;
}

function tryAddLocalLoops(seed, owner, dna, rooms, corridors, spatial, loopChance) {
  const pairs = [];
  for (let i = 0; i < rooms.length; i += 1) {
    const ac = centerOf(rooms[i]);
    for (let j = i + 1; j < rooms.length; j += 1) {
      const bc = centerOf(rooms[j]);
      const distance = Math.hypot(bc.x - ac.x, bc.y - ac.y);
      if (distance < 62 || distance > 155) continue;
      pairs.push({ a: rooms[i], b: rooms[j], distance });
    }
  }

  pairs.sort((left, right) => left.distance - right.distance || left.a.id.localeCompare(right.a.id));
  const maxLoops = Math.round(rooms.length * (0.025 + loopChance * 0.12));
  let made = 0;

  for (let i = 0; i < pairs.length && made < maxLoops; i += 1) {
    const pair = pairs[i];
    if (!chance(seed, 0.22 + loopChance * 0.35, "owner", owner.key, "loop", i)) continue;
    const ac = centerOf(pair.a);
    const bc = centerOf(pair.b);
    const side = preferredSide(ac, bc);
    const width = Math.round(clamp((dna.corridor[0] + dna.corridor[1]) / 2, 10, 20));
    const connector = makeConnector(pair.a, pair.b, side, width, {
      id: owner.key + ":loop:" + made,
      ownerKey: owner.key,
      regionKey: owner.key,
      kind: "loop-corridor",
      sourceRoomId: pair.a.id,
      targetRoomId: pair.b.id,
    });

    if (Math.max(connector.w, connector.h) > 120) continue;
    if (spatial.intersects(connector, new Set([pair.a.id, pair.b.id]), 1)) continue;
    corridors.push(connector);
    made += 1;
  }
}

function generateColony(seed, x, y, config, spatial) {
  if (!siteIsActive(seed, x, y)) return null;

  const position = sitePosition(seed, x, y);
  const key = cellKey(x, y);
  const dna = chooseDna(seed, x, y);
  const mode = chooseMode(seed, x, y);
  const owner = {
    key,
    cellX: x,
    cellY: y,
    x: position.x,
    y: position.y,
    mode,
  };
  const lobes = makeLobes(seed, owner);

  let root = null;
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const candidate = rootCandidate(seed, owner, dna, attempt);
    if (!pointInsideLobes(centerOf(candidate), lobes)) continue;
    if (spatial.intersects(candidate, new Set(), 8)) continue;
    root = candidate;
    break;
  }
  if (!root) return null;

  const rooms = [root];
  const corridors = [];
  spatial.add(root);

  const target = targetRoomCount(seed, owner, dna, config.density);
  let misses = 0;
  for (let index = 1; rooms.length < target && index < target * 2.6; index += 1) {
    const added = tryAddRoom(seed, owner, dna, rooms, corridors, lobes, index, spatial);
    misses = added ? 0 : misses + 1;
    if (misses > 24) break;
  }

  tryAddLocalLoops(seed, owner, dna, rooms, corridors, spatial, config.loopChance);

  const bounds = boundsOfRects([...rooms, ...corridors]);
  return {
    id: -1,
    key,
    label: "A " + x + "," + y,
    cellX: x,
    cellY: y,
    x: centerOf(root).x,
    y: centerOf(root).y,
    dna,
    mode,
    rooms,
    corridors,
    doors: [],
    bounds,
    lobes,
  };
}

function nearestRoomPair(regionA, regionB) {
  let best = null;
  let bestDistance = Infinity;
  for (const a of regionA.rooms) {
    const ac = centerOf(a);
    for (const b of regionB.rooms) {
      const bc = centerOf(b);
      const distance = Math.hypot(bc.x - ac.x, bc.y - ac.y);
      if (distance < bestDistance) {
        bestDistance = distance;
        best = { a, b, distance };
      }
    }
  }
  return best;
}

function candidateRoute(a, b, width, horizontalFirst, meta) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const half = width / 2;
  const segments = [];

  if (horizontalFirst) {
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    segments.push(rect(minX, ac.y - half, Math.max(width, maxX - minX), width, meta));
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    segments.push(rect(bc.x - half, minY, width, Math.max(width, maxY - minY), meta));
  } else {
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    segments.push(rect(ac.x - half, minY, width, Math.max(width, maxY - minY), meta));
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    segments.push(rect(minX, bc.y - half, Math.max(width, maxX - minX), width, meta));
  }

  return segments;
}

function routeClear(segments, spatial, sourceId, targetId, maxSpan = 165) {
  const ignored = new Set([sourceId, targetId]);
  return segments.every(
    (segment) =>
      Math.max(segment.w, segment.h) <= maxSpan &&
      !spatial.intersects(segment, ignored, 1),
  );
}

function shortRoute(seed, key, a, b, width, spatial, meta, maxSpan = 165) {
  const first = chance(seed, 0.5, "bridge", key, "axis");
  for (const horizontalFirst of [first, !first]) {
    const route = candidateRoute(a, b, width, horizontalFirst, meta);
    if (routeClear(route, spatial, a.id, b.id, maxSpan)) return route;
  }
  return [];
}

function midpointHall(seed, key, a, b, spatial, dnaA, dnaB) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const px = -dy / length;
  const py = dx / length;
  const w = randInt(seed, 70, 126, "bridge", key, "hall-w");
  const h = randInt(seed, 62, 118, "bridge", key, "hall-h");
  const baseLateral = signed(seed, 70, "bridge", key, "lateral");

  for (const factor of [0, 1, -1, 0.5, -0.5]) {
    const cx = (ac.x + bc.x) / 2 + px * baseLateral * factor;
    const cy = (ac.y + bc.y) / 2 + py * baseLateral * factor;
    const candidate = {
      ...rect(Math.round(cx - w / 2), Math.round(cy - h / 2), w, h),
      id: "bridge:" + key + ":hall",
      regionId: -1,
      regionKey: "bridge:" + key,
      kind: "transition",
      variant: rand01(seed, "bridge", key, "variant"),
      edgeKey: key,
      bridgeColor: dnaA.color,
      bridgeColorB: dnaB.color,
    };
    if (!spatial.intersects(candidate, new Set([a.id, b.id]), 7)) return candidate;
  }
  return null;
}

function connectRegions(seed, regions, spatial, config) {
  const edges = [];
  const macroRooms = [];
  const macroCorridors = [];
  const attempted = new Set();

  for (let i = 0; i < regions.length; i += 1) {
    for (let j = i + 1; j < regions.length; j += 1) {
      const a = regions[i];
      const b = regions[j];
      const ownerDistance = Math.hypot(b.x - a.x, b.y - a.y);
      if (ownerDistance > 1120) continue;

      const key = pairKey(a.key, b.key);
      if (attempted.has(key)) continue;
      attempted.add(key);

      const pair = nearestRoomPair(a, b);
      if (!pair || pair.distance > 330) continue;

      const sameDna = a.dna.id === b.dna.id;
      const probability = pair.distance < 85
        ? 0.92
        : pair.distance < 170
          ? (sameDna ? 0.80 : 0.60)
          : (sameDna ? 0.50 : 0.28) + config.loopChance * 0.35;

      if (!chance(seed, clamp(probability, 0, 0.96), "bridge", key, "enabled")) continue;

      const width = Math.round(
        clamp(
          (a.dna.corridor[0] + a.dna.corridor[1] + b.dna.corridor[0] + b.dna.corridor[1]) / 4,
          10,
          22,
        ),
      );
      const meta = {
        regionId: -1,
        regionKey: "bridge:" + key,
        kind: "macro-corridor",
        edgeKey: key,
        sourceRoomId: pair.a.id,
        targetRoomId: pair.b.id,
      };

      let route = [];
      let hall = null;

      if (pair.distance <= 165) {
        route = shortRoute(seed, key, pair.a, pair.b, width, spatial, meta, 165);
      } else {
        hall = midpointHall(seed, key, pair.a, pair.b, spatial, a.dna, b.dna);
        if (hall) {
          spatial.add(hall);
          const routeA = shortRoute(seed, key + ":a", pair.a, hall, width, spatial, {
            ...meta,
            targetRoomId: hall.id,
          }, 150);
          const routeB = shortRoute(seed, key + ":b", hall, pair.b, width, spatial, {
            ...meta,
            sourceRoomId: hall.id,
          }, 150);

          if (routeA.length && routeB.length) {
            route = [...routeA, ...routeB];
          } else {
            // Remove visually by not emitting the hall. It remains in the collision index,
            // which is harmless and prevents later bridges from occupying the failed slot.
            hall = null;
            route = [];
          }
        }
      }

      if (!route.length) continue;

      route.forEach((segment, segmentIndex) => {
        segment.id = "bridge:" + key + ":corridor:" + segmentIndex;
      });
      if (hall) macroRooms.push(hall);
      macroCorridors.push(...route);
      edges.push({
        a: a.id,
        b: b.id,
        type: sameDna ? "wing" : "transition",
        routed: true,
        edgeKey: key,
      });
    }
  }

  return { edges, macroRooms, macroCorridors };
}

function intersectsOwnerWindow(region, config, extraCells = 1) {
  return (
    region.cellX >= config.centerX - config.radius - extraCells &&
    region.cellX <= config.centerX + config.radius + extraCells &&
    region.cellY >= config.centerY - config.radius - extraCells &&
    region.cellY <= config.centerY + config.radius + extraCells
  );
}

function stableSignature(world) {
  let h = 0x811c9dc5;
  const mix = (value) => {
    const text = String(value);
    for (let i = 0; i < text.length; i += 1) {
      h ^= text.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  };

  mix(world.seed);
  mix(world.config.density.toFixed(3));
  mix(world.config.loopChance.toFixed(3));

  for (const region of [...world.regions].sort((a, b) => a.key.localeCompare(b.key))) {
    mix(region.key + ":" + region.mode + ":" + region.dna.id + ";");
    for (const room of region.rooms) {
      mix(room.id + ":" + room.x + "," + room.y + "," + room.w + "," + room.h + ";");
    }
    for (const corridor of region.corridors) {
      mix(corridor.id + ":" + corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
    }
  }
  for (const room of world.macroRooms) {
    mix(room.id + ":" + room.x + "," + room.y + "," + room.w + "," + room.h + ";");
  }
  for (const corridor of world.macroCorridors) {
    mix(corridor.id + ":" + corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  }

  return (h >>> 0).toString(16).padStart(8, "0");
}

export function generateInfiniteWorld(seedInput, userConfig = {}) {
  const seed = String(seedInput ?? "").trim() || "default-seed";
  const config = normalizeConfig(userConfig);
  const spatial = new SpatialIndex();
  const owners = [];

  const minX = config.centerX - config.radius - OWNER_HALO;
  const maxX = config.centerX + config.radius + OWNER_HALO;
  const minY = config.centerY - config.radius - OWNER_HALO;
  const maxY = config.centerY + config.radius + OWNER_HALO;

  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      if (!siteIsActive(seed, x, y)) continue;
      owners.push({
        x,
        y,
        priority: colonyPriority(seed, x, y),
      });
    }
  }

  owners.sort(
    (a, b) =>
      a.priority - b.priority ||
      a.y - b.y ||
      a.x - b.x,
  );

  const generated = [];
  for (const owner of owners) {
    const colony = generateColony(seed, owner.x, owner.y, config, spatial);
    if (colony) generated.push(colony);
  }

  const regions = generated.filter((region) => intersectsOwnerWindow(region, config, 1));
  regions.sort((a, b) => a.cellY - b.cellY || a.cellX - b.cellX);

  for (let i = 0; i < regions.length; i += 1) {
    regions[i].id = i;
    for (const room of regions[i].rooms) room.regionId = i;
    for (const corridor of regions[i].corridors) corridor.regionId = i;
  }

  const visibleIndex = new SpatialIndex();
  for (const region of regions) {
    for (const room of region.rooms) visibleIndex.add(room);
  }

  const connected = connectRegions(seed, regions, visibleIndex, config);

  const allRects = [
    ...regions.flatMap((region) => region.rooms),
    ...regions.flatMap((region) => region.corridors),
    ...connected.macroRooms,
    ...connected.macroCorridors,
  ];
  const bounds = unionBounds(allRects);

  const roomArea = [
    ...regions.flatMap((region) => region.rooms),
    ...connected.macroRooms,
  ].reduce((sum, room) => sum + room.w * room.h, 0);

  const world = {
    infinite: true,
    seed,
    seedHash: addressSeed(seed, "infinite-frontier-v3").toString(16).padStart(8, "0"),
    config,
    regions,
    edges: connected.edges,
    macroRooms: connected.macroRooms,
    macroCorridors: connected.macroCorridors,
    bounds,
    stats: {
      regions: regions.length,
      rooms: regions.reduce((sum, region) => sum + region.rooms.length, 0) + connected.macroRooms.length,
      localCorridors: regions.reduce((sum, region) => sum + region.corridors.length, 0),
      macroEdges: connected.edges.length,
      denseRegions: regions.filter((region) => region.mode === "dense").length,
      mediumRegions: regions.filter((region) => region.mode === "medium").length,
      transitRegions: regions.filter((region) => region.mode === "transit").length,
      roomAreaRatio: roomArea / Math.max(1, bounds.w * bounds.h),
      maxMacroCorridorSpan: connected.macroCorridors.reduce(
        (max, corridor) => Math.max(max, corridor.w, corridor.h),
        0,
      ),
      centerX: config.centerX,
      centerY: config.centerY,
      radius: config.radius,
    },
  };

  world.signature = stableSignature(world);
  return world;
}

export function summarizeInfiniteDna(world) {
  const counts = new Map(ARCHITECTURE_DNA.map((dna) => [dna.id, 0]));
  for (const region of world.regions) {
    counts.set(region.dna.id, (counts.get(region.dna.id) ?? 0) + 1);
  }
  return counts;
}
