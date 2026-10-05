import { ARCHITECTURE_DNA } from "./dna.js";
import { addressSeed, chance, rand01, randInt, randRange, signed } from "./prng.js";
import { boundsOfRects, centerOf, inflate, intersects, rect, unionBounds } from "./geometry.js";

export const INFINITE_SECTOR_SIZE = 780;

export const DEFAULT_INFINITE_CONFIG = Object.freeze({
  density: 1,
  loopChance: 0.18,
  centerX: 0,
  centerY: 0,
  radius: 2,
});

const NEIGHBORS = [
  { dx: 1, dy: 0 },
  { dx: 0, dy: 1 },
  { dx: -1, dy: 0 },
  { dx: 0, dy: -1 },
  { dx: 1, dy: 1 },
  { dx: -1, dy: 1 },
  { dx: -1, dy: -1 },
  { dx: 1, dy: -1 },
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
    radius: clamp(Math.round(Number(config.radius ?? DEFAULT_INFINITE_CONFIG.radius) || 2), 1, 6),
  };
}

function cellKey(x, y) {
  return x + "," + y;
}

function canonicalEdge(ax, ay, bx, by) {
  const a = cellKey(ax, ay);
  const b = cellKey(bx, by);
  return a < b ? a + "|" + b : b + "|" + a;
}

function parseEdge(edgeKey) {
  const [a, b] = edgeKey.split("|");
  const [ax, ay] = a.split(",").map(Number);
  const [bx, by] = b.split(",").map(Number);
  return { ax, ay, bx, by };
}

function sitePosition(seed, x, y) {
  const jitter = INFINITE_SECTOR_SIZE * 0.22;
  const warpX = signed(seed, jitter, "site", x, y, "jitter-x");
  const warpY = signed(seed, jitter, "site", x, y, "jitter-y");
  const lowX = signed(seed, 72, "zone-warp", Math.floor(x / 3), Math.floor(y / 3), "x");
  const lowY = signed(seed, 72, "zone-warp", Math.floor(x / 3), Math.floor(y / 3), "y");
  return {
    x: x * INFINITE_SECTOR_SIZE + warpX + lowX,
    y: y * INFINITE_SECTOR_SIZE + warpY + lowY,
  };
}

function chooseDna(seed, x, y) {
  // Large DNA neighborhoods make several adjacent sites read as one architectural wing.
  const zx = Math.floor((x + 1) / 3);
  const zy = Math.floor((y - 1) / 3);
  let index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "dna-zone", zx, zy);
  if (chance(seed, 0.18, "site", x, y, "dna-mutation")) {
    index = randInt(seed, 0, ARCHITECTURE_DNA.length - 1, "site", x, y, "dna");
  }
  return ARCHITECTURE_DNA[index];
}

function safeSiteRadius(seed, x, y, position) {
  let nearest = Infinity;
  for (const { dx, dy } of NEIGHBORS) {
    const other = sitePosition(seed, x + dx, y + dy);
    nearest = Math.min(nearest, Math.hypot(other.x - position.x, other.y - position.y));
  }
  // Candidate room centers stay inside this radius. The subtraction reserves
  // room half-size so neighboring site envelopes cannot claim the same floor.
  return clamp(nearest * 0.41 - 92, 138, 286);
}

function parentCell(seed, x, y) {
  if (x === 0 && y === 0) return null;
  const sx = Math.sign(x);
  const sy = Math.sign(y);

  if (x !== 0 && y !== 0 && chance(seed, 0.56, "site", x, y, "diagonal-parent")) {
    return { x: x - sx, y: y - sy };
  }

  const ax = Math.abs(x);
  const ay = Math.abs(y);
  if (ax > ay) return { x: x - sx, y };
  if (ay > ax) return { x, y: y - sy };
  if (chance(seed, 0.5, "site", x, y, "parent-axis")) return { x: x - sx, y };
  return { x, y: y - sy };
}

function isParentLink(seed, ax, ay, bx, by) {
  const pa = parentCell(seed, ax, ay);
  if (pa && pa.x === bx && pa.y === by) return true;
  const pb = parentCell(seed, bx, by);
  return Boolean(pb && pb.x === ax && pb.y === ay);
}

function edgeIsActive(seed, ax, ay, bx, by, loopChance) {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  if (dx > 1 || dy > 1 || (dx === 0 && dy === 0)) return false;
  if (isParentLink(seed, ax, ay, bx, by)) return true;

  const diagonal = dx === 1 && dy === 1;
  const probability = diagonal
    ? clamp(0.025 + loopChance * 0.22, 0.025, 0.13)
    : clamp(0.05 + loopChance * 0.52, 0.05, 0.30);
  return chance(seed, probability, "edge", canonicalEdge(ax, ay, bx, by), "loop");
}

function edgeType(seed, ax, ay, bx, by) {
  return isParentLink(seed, ax, ay, bx, by) ? "tree" : "loop";
}

function activeNeighbors(seed, x, y, loopChance) {
  return NEIGHBORS
    .map(({ dx, dy }) => ({ x: x + dx, y: y + dy }))
    .filter((n) => edgeIsActive(seed, x, y, n.x, n.y, loopChance));
}

function hitsAny(candidate, rectangles, ignoredIds = new Set(), padding = 0) {
  const probe = padding ? inflate(candidate, padding) : candidate;
  return rectangles.some((other) => !ignoredIds.has(other.id) && intersects(probe, other));
}

function roomDimensions(seed, x, y, dna, index, hall = false, siteScale = 1) {
  const hallScale = hall ? randRange(seed, 1.22, 1.72, "room", x, y, index, "hall-scale") : 1;
  return {
    w: Math.round(randRange(seed, dna.roomW[0], dna.roomW[1], "room", x, y, index, "w") * hallScale * siteScale),
    h: Math.round(randRange(seed, dna.roomH[0], dna.roomH[1], "room", x, y, index, "h") * hallScale * siteScale),
  };
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
    const usable = Math.max(7, bottom - top);
    const actualWidth = Math.min(width, usable);
    const y = top <= bottom
      ? clamp((ac.y + rc.y) / 2, top + actualWidth / 2, bottom - actualWidth / 2)
      : (ac.y + rc.y) / 2;
    return rect(left.x + left.w, y - actualWidth / 2, Math.max(1, right.x - left.x - left.w), actualWidth, meta);
  }

  const top = side === 1 ? anchor : room;
  const bottom = side === 1 ? room : anchor;
  const left = Math.max(anchor.x, room.x);
  const right = Math.min(anchor.x + anchor.w, room.x + room.w);
  const usable = Math.max(7, right - left);
  const actualWidth = Math.min(width, usable);
  const x = left <= right
    ? clamp((ac.x + rc.x) / 2, left + actualWidth / 2, right - actualWidth / 2)
    : (ac.x + rc.x) / 2;
  return rect(x - actualWidth / 2, top.y + top.h, actualWidth, Math.max(1, bottom.y - top.y - top.h), meta);
}

function orthogonalConnect(a, b, width, meta, seed, key) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const horizontalFirst = chance(seed, 0.5, "short-route", key, "axis");
  const result = [];
  const half = width / 2;

  if (horizontalFirst) {
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    result.push(rect(minX, ac.y - half, Math.max(width, maxX - minX), width, meta));
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    result.push(rect(bc.x - half, minY, width, Math.max(width, maxY - minY), meta));
  } else {
    const minY = Math.min(ac.y, bc.y);
    const maxY = Math.max(ac.y, bc.y);
    result.push(rect(ac.x - half, minY, width, Math.max(width, maxY - minY), meta));
    const minX = Math.min(ac.x, bc.x);
    const maxX = Math.max(ac.x, bc.x);
    result.push(rect(minX, bc.y - half, Math.max(width, maxX - minX), width, meta));
  }

  return result.filter((segment) => segment.w > 0 && segment.h > 0);
}

function createPortal(seed, site, neighbor, edgeKey, index) {
  const target = sitePosition(seed, neighbor.x, neighbor.y);
  const dx = target.x - site.x;
  const dy = target.y - site.y;
  const length = Math.max(1, Math.hypot(dx, dy));
  const nx = dx / length;
  const ny = dy / length;
  const px = -ny;
  const py = nx;
  const radius = clamp(
    length * randRange(seed, 0.255, 0.315, "edge", edgeKey, site.key, "portal-radius-factor"),
    138,
    258,
  );
  const lateral = signed(seed, 52, "edge", edgeKey, site.key, "portal-lateral");
  const w = randInt(seed, 42, 76, "edge", edgeKey, site.key, "portal-w");
  const h = randInt(seed, 36, 70, "edge", edgeKey, site.key, "portal-h");
  const cx = site.x + nx * radius + px * lateral;
  const cy = site.y + ny * radius + py * lateral;
  return {
    ...rect(Math.round(cx - w / 2), Math.round(cy - h / 2), w, h),
    id: site.key + ":portal:" + index,
    siteKey: site.key,
    regionKey: site.key,
    kind: "portal",
    variant: rand01(seed, "edge", edgeKey, site.key, "portal-variant"),
    edgeKey,
    neighborKey: cellKey(neighbor.x, neighbor.y),
  };
}

function createRoot(seed, site, dna, siteScale) {
  const hall = site.mode !== "transit" && chance(seed, Math.min(0.36, dna.hallChance * 1.6 + 0.05), "site", site.cellX, site.cellY, "root-hall");
  const dims = roomDimensions(seed, site.cellX, site.cellY, dna, 0, hall, siteScale);
  const rootMaxW = site.mode === "transit" ? 96 : 188;
  const rootMaxH = site.mode === "transit" ? 86 : 166;
  const rootMinW = site.mode === "transit" ? 42 : 64;
  const rootMinH = site.mode === "transit" ? 38 : 54;
  const w = clamp(dims.w, rootMinW, rootMaxW);
  const h = clamp(dims.h, rootMinH, rootMaxH);
  return {
    ...rect(Math.round(site.x - w / 2), Math.round(site.y - h / 2), Math.round(w), Math.round(h)),
    id: site.key + ":0",
    siteKey: site.key,
    regionKey: site.key,
    kind: hall ? "hall" : "room",
    variant: rand01(seed, "site", site.cellX, site.cellY, "root-variant"),
  };
}

function safeWaypoint(seed, site, from, to, ordinal, occupied) {
  const a = centerOf(from);
  const b = centerOf(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const distance = Math.hypot(dx, dy);
  if (distance < 126) return null;

  const len = Math.max(1, distance);
  const px = -dy / len;
  const py = dx / len;
  const size = randInt(seed, 30, 48, "site", site.cellX, site.cellY, "waypoint-size", ordinal, to.id);
  const base = signed(seed, 30, "site", site.cellX, site.cellY, "waypoint-offset", ordinal, to.id);
  for (const lateral of [base, -base, 0, base * 0.45, -base * 0.45]) {
    const t = randRange(seed, 0.42, 0.58, "site", site.cellX, site.cellY, "waypoint-t", ordinal, to.id);
    const cx = a.x + dx * t + px * lateral;
    const cy = a.y + dy * t + py * lateral;
    const candidate = {
      ...rect(Math.round(cx - size / 2), Math.round(cy - size / 2), size, size),
      id: site.key + ":junction:" + ordinal,
      siteKey: site.key,
      regionKey: site.key,
      kind: "junction",
      variant: rand01(seed, "site", site.cellX, site.cellY, "waypoint-variant", ordinal),
    };
    if (!hitsAny(candidate, occupied, new Set([from.id, to.id]), 6)) return candidate;
  }
  return null;
}

function routeSiteSkeleton(seed, site, dna, root, portals, rooms) {
  const corridors = [];
  const width = Math.round(clamp((dna.corridor[0] + dna.corridor[1]) / 2, 11, 22));
  let junctionOrdinal = 0;

  for (let i = 0; i < portals.length; i += 1) {
    const portal = portals[i];
    const chain = [root];
    const waypoint = safeWaypoint(seed, site, root, portal, junctionOrdinal, rooms);
    if (waypoint) {
      rooms.push(waypoint);
      chain.push(waypoint);
      junctionOrdinal += 1;
    }
    chain.push(portal);

    for (let step = 1; step < chain.length; step += 1) {
      const segments = orthogonalConnect(
        chain[step - 1],
        chain[step],
        width,
        {
          id: site.key + ":spine:" + i + ":" + step,
          regionKey: site.key,
          siteKey: site.key,
          kind: "corridor",
          sourceRoomId: chain[step - 1].id,
          targetRoomId: chain[step].id,
        },
        seed,
        site.key + ":spine:" + i + ":" + step,
      );
      segments.forEach((segment, segmentIndex) => {
        segment.id += ":" + segmentIndex;
      });
      corridors.push(...segments);
    }
  }

  return corridors;
}

function growSiteRooms(seed, site, dna, config, siteScale, fixedRooms, reservedCorridors) {
  const rooms = [...fixedRooms];
  const component = rooms.filter((room) => room.kind !== "portal");
  const corridors = [...reservedCorridors];
  const modeFactor = site.mode === "dense" ? 1.08 : site.mode === "transit" ? 0.24 : 0.68;
  const minCount = Math.max(site.mode === "transit" ? 2 : 5, Math.round(dna.roomCount[0] * 0.74 * config.density * modeFactor));
  const maxCount = Math.max(minCount, Math.round(dna.roomCount[1] * 0.92 * config.density * modeFactor));
  const target = randInt(seed, minCount, maxCount, "site", site.cellX, site.cellY, "room-count");
  const maxRadius = site.safeRadius * (site.mode === "dense" ? 1 : site.mode === "transit" ? 0.58 : 0.82);

  for (let index = 1; component.length < target; index += 1) {
    let placed = false;
    for (let attempt = 0; attempt < 44; attempt += 1) {
      const anchorPoolStart = Math.max(0, component.length - Math.max(5, Math.floor(component.length * 0.72)));
      const anchor = component[randInt(seed, anchorPoolStart, component.length - 1, "room", site.cellX, site.cellY, index, "anchor", attempt)];
      const side = randInt(seed, 0, 3, "room", site.cellX, site.cellY, index, "side", attempt);
      const hall = chance(seed, dna.hallChance * 0.88, "room", site.cellX, site.cellY, index, "hall");
      const dims = roomDimensions(seed, site.cellX, site.cellY, dna, index, hall, siteScale);
      const w = clamp(dims.w, 34, 154);
      const h = clamp(dims.h, 30, 138);
      const flush = chance(seed, Math.min(0.48, dna.flushChance * 1.18), "room", site.cellX, site.cellY, index, "flush", attempt);
      const gap = flush
        ? 2
        : Math.round(randRange(seed, 7, Math.min(28, Math.max(12, dna.gap[1] * 0.48)), "room", site.cellX, site.cellY, index, "gap", attempt));
      const offset = signed(seed, Math.min(22, (side === 0 || side === 2 ? h : w) * 0.22), "room", site.cellX, site.cellY, index, "offset", attempt);
      const candidate = {
        ...placeAttached(anchor, side, Math.round(w), Math.round(h), gap, offset),
        id: site.key + ":" + index,
        siteKey: site.key,
        regionKey: site.key,
        kind: hall ? "hall" : "room",
        variant: rand01(seed, "room", site.cellX, site.cellY, index, "variant"),
      };

      const cc = centerOf(candidate);
      if (Math.hypot(cc.x - site.x, cc.y - site.y) > maxRadius) continue;
      if (hitsAny(candidate, rooms, new Set([anchor.id]), 5)) continue;
      if (hitsAny(candidate, reservedCorridors, new Set(), 3)) continue;

      const width = Math.round(clamp(randRange(seed, dna.corridor[0], dna.corridor[1], "room", site.cellX, site.cellY, index, "corridor-width"), 10, 23));
      const connector = attachmentConnector(anchor, candidate, side, width, {
        id: site.key + ":local:" + index,
        regionKey: site.key,
        siteKey: site.key,
        kind: gap <= 3 ? "doorway" : "corridor",
        sourceRoomId: anchor.id,
        targetRoomId: candidate.id,
      });
      if (hitsAny(connector, rooms, new Set([anchor.id]), 1)) continue;

      rooms.push(candidate);
      component.push(candidate);
      corridors.push(connector);
      placed = true;
      break;
    }
    if (!placed && index > target + 18) break;
  }

  return { rooms, corridors };
}

function generateSite(seed, x, y, config) {
  const key = cellKey(x, y);
  const position = sitePosition(seed, x, y);
  const dna = chooseDna(seed, x, y);
  const modeRoll = rand01(seed, "site", x, y, "mass-mode");
  const mode = modeRoll < 0.48 ? "dense" : modeRoll < 0.84 ? "medium" : "transit";
  const siteScale = randRange(seed, mode === "dense" ? 0.92 : 0.78, mode === "dense" ? 1.24 : 1.08, "site", x, y, "scale");
  const site = {
    key,
    cellX: x,
    cellY: y,
    x: position.x,
    y: position.y,
    mode,
    safeRadius: safeSiteRadius(seed, x, y, position),
  };

  const neighbors = activeNeighbors(seed, x, y, config.loopChance);
  const root = createRoot(seed, site, dna, siteScale);
  const portals = neighbors.map((neighbor, index) => {
    const edgeKey = canonicalEdge(x, y, neighbor.x, neighbor.y);
    return createPortal(seed, site, neighbor, edgeKey, index);
  });

  const fixedRooms = [root, ...portals];

  // Portals may collide around highly connected sites. Pull only the colliding portal
  // slightly toward the site center; this is radial and does not expose the hidden lattice.
  for (let i = 1; i < fixedRooms.length; i += 1) {
    const portal = fixedRooms[i];
    for (let attempt = 0; attempt < 7 && hitsAny(portal, fixedRooms.slice(0, i), new Set(), 5); attempt += 1) {
      const pc = centerOf(portal);
      const dx = site.x - pc.x;
      const dy = site.y - pc.y;
      const len = Math.max(1, Math.hypot(dx, dy));
      portal.x += (dx / len) * 18;
      portal.y += (dy / len) * 18;
    }
  }

  const skeletonRooms = [...fixedRooms];
  const skeleton = routeSiteSkeleton(seed, site, dna, root, portals, skeletonRooms);
  const grown = growSiteRooms(seed, site, dna, config, siteScale, skeletonRooms, skeleton);
  const b = boundsOfRects([...grown.rooms, ...grown.corridors]);

  return {
    id: -1,
    key,
    label: "W " + x + "," + y,
    cellX: x,
    cellY: y,
    x: site.x,
    y: site.y,
    dna,
    mode,
    rooms: grown.rooms,
    corridors: grown.corridors,
    doors: [],
    bounds: b,
    portals: new Map(portals.map((portal) => [portal.edgeKey, portal])),
  };
}

function edgeRoom(seed, edgeKey, index, count, a, b, blockers) {
  const ac = centerOf(a);
  const bc = centerOf(b);
  const t = (index + 1) / (count + 1);
  const dx = bc.x - ac.x;
  const dy = bc.y - ac.y;
  const len = Math.max(1, Math.hypot(dx, dy));
  const px = -dy / len;
  const py = dx / len;
  const baseLateral = signed(seed, 58, "edge", edgeKey, "waypoint", index, "lateral");
  const sizeW = randInt(seed, 34, 74, "edge", edgeKey, "waypoint", index, "w");
  const sizeH = randInt(seed, 32, 68, "edge", edgeKey, "waypoint", index, "h");

  for (const factor of [1, -1, 0.45, -0.45, 0]) {
    const lateral = baseLateral * factor;
    const cx = ac.x + dx * t + px * lateral;
    const cy = ac.y + dy * t + py * lateral;
    const candidate = {
      ...rect(Math.round(cx - sizeW / 2), Math.round(cy - sizeH / 2), sizeW, sizeH),
      id: "edge:" + edgeKey + ":room:" + index,
      regionId: -1,
      regionKey: "edge:" + edgeKey,
      kind: "transition",
      variant: rand01(seed, "edge", edgeKey, "waypoint", index, "variant"),
      edgeKey,
    };
    if (!hitsAny(candidate, blockers, new Set([a.id, b.id]), 7)) return candidate;
  }

  const cx = ac.x + dx * t;
  const cy = ac.y + dy * t;
  return {
    ...rect(Math.round(cx - sizeW / 2), Math.round(cy - sizeH / 2), sizeW, sizeH),
    id: "edge:" + edgeKey + ":room:" + index,
    regionId: -1,
    regionKey: "edge:" + edgeKey,
    kind: "transition",
    variant: rand01(seed, "edge", edgeKey, "waypoint", index, "variant"),
    edgeKey,
  };
}

function addEdgeSideRoom(seed, edgeKey, waypoint, index, blockers) {
  if (!chance(seed, 0.34, "edge", edgeKey, "side-room", index, "enabled")) return null;
  const side = randInt(seed, 0, 3, "edge", edgeKey, "side-room", index, "side");
  const w = randInt(seed, 28, 62, "edge", edgeKey, "side-room", index, "w");
  const h = randInt(seed, 28, 58, "edge", edgeKey, "side-room", index, "h");
  const gap = randInt(seed, 3, 14, "edge", edgeKey, "side-room", index, "gap");
  const candidate = {
    ...placeAttached(waypoint, side, w, h, gap, 0),
    id: "edge:" + edgeKey + ":side:" + index,
    regionId: -1,
    regionKey: "edge:" + edgeKey,
    kind: "transition",
    variant: rand01(seed, "edge", edgeKey, "side-room", index, "variant"),
    edgeKey,
  };
  return hitsAny(candidate, blockers, new Set([waypoint.id]), 5) ? null : candidate;
}

function buildEdgeArchitecture(seed, edgeKey, siteA, siteB, blockers) {
  const portalA = siteA.portals.get(edgeKey);
  const portalB = siteB.portals.get(edgeKey);
  if (!portalA || !portalB) return { rooms: [], corridors: [] };

  const ac = centerOf(portalA);
  const bc = centerOf(portalB);
  const distance = Math.hypot(bc.x - ac.x, bc.y - ac.y);
  const segmentTarget = randRange(seed, 105, 145, "edge", edgeKey, "segment-target");
  const waypointCount = clamp(Math.ceil(distance / segmentTarget) - 1, 1, 7);
  const rooms = [];
  const localBlockers = [...blockers];

  for (let i = 0; i < waypointCount; i += 1) {
    const waypoint = edgeRoom(seed, edgeKey, i, waypointCount, portalA, portalB, localBlockers);
    rooms.push(waypoint);
    localBlockers.push(waypoint);
  }

  const sideRooms = [];
  for (let i = 0; i < rooms.length; i += 1) {
    const side = addEdgeSideRoom(seed, edgeKey, rooms[i], i, [...localBlockers, ...sideRooms]);
    if (side) sideRooms.push(side);
  }

  const chain = [portalA, ...rooms, portalB];
  const corridors = [];
  const width = randInt(seed, 10, 19, "edge", edgeKey, "width");

  for (let i = 1; i < chain.length; i += 1) {
    const segments = orthogonalConnect(
      chain[i - 1],
      chain[i],
      width,
      {
        id: "edge:" + edgeKey + ":corridor:" + i,
        regionId: -1,
        regionKey: "edge:" + edgeKey,
        kind: "macro-corridor",
        edgeKey,
        sourceRoomId: chain[i - 1].id,
        targetRoomId: chain[i].id,
      },
      seed,
      edgeKey + ":corridor:" + i,
    );
    segments.forEach((segment, segmentIndex) => {
      segment.id += ":" + segmentIndex;
    });
    corridors.push(...segments);
  }

  return { rooms: [...rooms, ...sideRooms], corridors };
}

function siteNeighborhoodCells(ax, ay, bx, by) {
  const cells = [];
  const minX = Math.min(ax, bx) - 1;
  const maxX = Math.max(ax, bx) + 1;
  const minY = Math.min(ay, by) - 1;
  const maxY = Math.max(ay, by) + 1;
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) cells.push({ x, y });
  }
  return cells;
}

function maxBareCorridorSpan(world) {
  let max = 0;
  for (const corridor of world.macroCorridors) {
    max = Math.max(max, corridor.w, corridor.h);
  }
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
  for (const room of world.macroRooms) mix(room.id + ":" + room.x + "," + room.y + "," + room.w + "," + room.h + ";");
  for (const corridor of world.macroCorridors) mix(corridor.id + ":" + corridor.x + "," + corridor.y + "," + corridor.w + "," + corridor.h + ";");
  return (h >>> 0).toString(16).padStart(8, "0");
}

export function generateInfiniteWorld(seedInput, userConfig = {}) {
  const seed = String(seedInput ?? "").trim() || "default-seed";
  const config = normalizeConfig(userConfig);
  const cache = new Map();

  const getSite = (x, y) => {
    const key = cellKey(x, y);
    if (!cache.has(key)) cache.set(key, generateSite(seed, x, y, config));
    return cache.get(key);
  };

  // The visible working set is independent of the hidden generation lattice.
  // Site geometry may cross any cell boundary.
  const regions = [];
  const visibleKeys = new Set();
  for (let y = config.centerY - config.radius; y <= config.centerY + config.radius; y += 1) {
    for (let x = config.centerX - config.radius; x <= config.centerX + config.radius; x += 1) {
      const region = getSite(x, y);
      region.id = regions.length;
      visibleKeys.add(region.key);
      regions.push(region);
    }
  }

  const byKey = new Map(regions.map((region) => [region.key, region]));
  const edges = [];
  const macroRooms = [];
  const macroCorridors = [];
  const emittedEdges = new Set();

  for (const region of regions) {
    for (const neighborCoord of activeNeighbors(seed, region.cellX, region.cellY, config.loopChance)) {
      const neighborKey = cellKey(neighborCoord.x, neighborCoord.y);
      if (!visibleKeys.has(neighborKey)) continue;
      const edgeKey = canonicalEdge(region.cellX, region.cellY, neighborCoord.x, neighborCoord.y);
      if (emittedEdges.has(edgeKey)) continue;
      emittedEdges.add(edgeKey);

      const neighbor = byKey.get(neighborKey);
      const type = edgeType(seed, region.cellX, region.cellY, neighborCoord.x, neighborCoord.y);
      const edge = { a: region.id, b: neighbor.id, type, routed: true, edgeKey };
      edges.push(edge);

      const parsed = parseEdge(edgeKey);
      const blockers = [];
      for (const cell of siteNeighborhoodCells(parsed.ax, parsed.ay, parsed.bx, parsed.by)) {
        blockers.push(...getSite(cell.x, cell.y).rooms);
      }

      const built = buildEdgeArchitecture(seed, edgeKey, region, neighbor, blockers);
      macroRooms.push(...built.rooms);
      macroCorridors.push(...built.corridors);
    }
  }

  // Assign stable display ids only after all sites are collected.
  for (let regionId = 0; regionId < regions.length; regionId += 1) {
    regions[regionId].id = regionId;
    for (const room of regions[regionId].rooms) room.regionId = regionId;
    for (const corridor of regions[regionId].corridors) corridor.regionId = regionId;
  }

  const allRects = [
    ...regions.flatMap((region) => region.rooms),
    ...regions.flatMap((region) => region.corridors),
    ...macroRooms,
    ...macroCorridors,
  ];
  const bounds = unionBounds(allRects);

  const world = {
    infinite: true,
    seed,
    seedHash: addressSeed(seed, "infinite-world-v2").toString(16).padStart(8, "0"),
    config,
    regions,
    edges,
    macroRooms,
    macroCorridors,
    bounds,
    stats: {
      regions: regions.length,
      rooms: regions.reduce((sum, region) => sum + region.rooms.length, 0) + macroRooms.length,
      localCorridors: regions.reduce((sum, region) => sum + region.corridors.length, 0),
      macroEdges: edges.length,
      maxBareCorridorSpan: 0,
      centerX: config.centerX,
      centerY: config.centerY,
      radius: config.radius,
    },
  };

  world.stats.maxBareCorridorSpan = maxBareCorridorSpan(world);
  world.signature = stableSignature(world);
  return world;
}

export function summarizeInfiniteDna(world) {
  const counts = new Map(ARCHITECTURE_DNA.map((dna) => [dna.id, 0]));
  for (const region of world.regions) counts.set(region.dna.id, (counts.get(region.dna.id) ?? 0) + 1);
  return counts;
}
