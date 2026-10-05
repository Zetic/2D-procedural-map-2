import { centerOf, inflate, intersects, rect } from "./geometry.js";
import { chance } from "./prng.js";

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function key(x, y) {
  return x + "," + y;
}

function parseKey(value) {
  const comma = value.indexOf(",");
  return [Number(value.slice(0, comma)), Number(value.slice(comma + 1))];
}

function snap(value, cellSize) {
  return Math.round(value / cellSize);
}

function gatewayPoint(room, target, width) {
  const c = centerOf(room);
  const dx = target.x - c.x;
  const dy = target.y - c.y;
  const half = width / 2;
  if (Math.abs(dx) >= Math.abs(dy)) {
    const right = dx >= 0;
    return {
      x: right ? room.x + room.w + half : room.x - half,
      y: clamp(target.y, room.y + half, room.y + room.h - half),
    };
  }
  const down = dy >= 0;
  return {
    x: clamp(target.x, room.x + half, room.x + room.w - half),
    y: down ? room.y + room.h + half : room.y - half,
  };
}

function rectForSegment(a, b, width, meta) {
  const half = width / 2;
  if (a.x === b.x) {
    const y = Math.min(a.y, b.y);
    return rect(a.x - half, y - half, width, Math.abs(b.y - a.y) + width, meta);
  }
  const x = Math.min(a.x, b.x);
  return rect(x - half, a.y - half, Math.abs(b.x - a.x) + width, width, meta);
}

function pointsToRects(points, width, meta) {
  const rects = [];
  for (let i = 1; i < points.length; i += 1) {
    const a = points[i - 1];
    const b = points[i];
    if (a.x === b.x && a.y === b.y) continue;
    if (a.x !== b.x && a.y !== b.y) {
      const elbow = { x: b.x, y: a.y };
      rects.push(rectForSegment(a, elbow, width, meta));
      rects.push(rectForSegment(elbow, b, width, meta));
    } else {
      rects.push(rectForSegment(a, b, width, meta));
    }
  }
  return rects;
}

function simplifyGridPath(points) {
  if (points.length <= 2) return points;
  const result = [points[0]];
  let lastDx = Math.sign(points[1].x - points[0].x);
  let lastDy = Math.sign(points[1].y - points[0].y);
  for (let i = 2; i < points.length; i += 1) {
    const dx = Math.sign(points[i].x - points[i - 1].x);
    const dy = Math.sign(points[i].y - points[i - 1].y);
    if (dx !== lastDx || dy !== lastDy) result.push(points[i - 1]);
    lastDx = dx;
    lastDy = dy;
  }
  result.push(points[points.length - 1]);
  return result;
}

class MinHeap {
  constructor() {
    this.items = [];
  }

  push(item) {
    const a = this.items;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (compareNode(a[p], item) <= 0) break;
      a[i] = a[p];
      i = p;
    }
    a[i] = item;
  }

  pop() {
    const a = this.items;
    if (!a.length) return null;
    const root = a[0];
    const last = a.pop();
    if (a.length) {
      let i = 0;
      while (true) {
        const left = i * 2 + 1;
        const right = left + 1;
        if (left >= a.length) break;
        let child = left;
        if (right < a.length && compareNode(a[right], a[left]) < 0) child = right;
        if (compareNode(last, a[child]) <= 0) break;
        a[i] = a[child];
        i = child;
      }
      a[i] = last;
    }
    return root;
  }

  get size() {
    return this.items.length;
  }
}

function compareNode(a, b) {
  return a.f - b.f || a.h - b.h || a.order - b.order || a.x - b.x || a.y - b.y;
}

export function buildRoomSpatialIndex(rooms, bucketSize = 128) {
  const buckets = new Map();
  for (let i = 0; i < rooms.length; i += 1) {
    const r = rooms[i];
    const minX = Math.floor(r.x / bucketSize);
    const maxX = Math.floor((r.x + r.w) / bucketSize);
    const minY = Math.floor(r.y / bucketSize);
    const maxY = Math.floor((r.y + r.h) / bucketSize);
    for (let by = minY; by <= maxY; by += 1) {
      for (let bx = minX; bx <= maxX; bx += 1) {
        const k = key(bx, by);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push(i);
      }
    }
  }
  return { rooms, buckets, bucketSize };
}

function nearbyRoomIndices(index, area) {
  const { bucketSize, buckets } = index;
  const minX = Math.floor(area.x / bucketSize);
  const maxX = Math.floor((area.x + area.w) / bucketSize);
  const minY = Math.floor(area.y / bucketSize);
  const maxY = Math.floor((area.y + area.h) / bucketSize);
  const found = new Set();
  for (let by = minY; by <= maxY; by += 1) {
    for (let bx = minX; bx <= maxX; bx += 1) {
      const bucket = buckets.get(key(bx, by));
      if (!bucket) continue;
      for (const roomIndex of bucket) found.add(roomIndex);
    }
  }
  return found;
}

function areaHitsRoom(area, index, ignoredRoomIds) {
  for (const roomIndex of nearbyRoomIndices(index, area)) {
    const room = index.rooms[roomIndex];
    if (ignoredRoomIds.has(room.id)) continue;
    if (intersects(area, room)) return true;
  }
  return false;
}

export function routeIntersectsRooms(route, index, ignoredRoomIds = new Set(), padding = 0) {
  return route.some((segment) => areaHitsRoom(inflate(segment, padding), index, ignoredRoomIds));
}

function simpleRouteCandidates(start, end, width, meta, seed, routeKey) {
  const firstHorizontal = chance(seed, 0.5, "route", routeKey, "first-axis");
  const horizontalElbow = { x: end.x, y: start.y };
  const verticalElbow = { x: start.x, y: end.y };
  const a = firstHorizontal
    ? pointsToRects([start, horizontalElbow, end], width, meta)
    : pointsToRects([start, verticalElbow, end], width, meta);
  const b = firstHorizontal
    ? pointsToRects([start, verticalElbow, end], width, meta)
    : pointsToRects([start, horizontalElbow, end], width, meta);
  return [a, b];
}

function reconstruct(cameFrom, currentKey, cellSize) {
  const cells = [];
  let cursor = currentKey;
  while (cursor) {
    const [x, y] = parseKey(cursor);
    cells.push({ x: x * cellSize, y: y * cellSize });
    cursor = cameFrom.get(cursor) ?? null;
  }
  cells.reverse();
  return simplifyGridPath(cells);
}

function aStar(start, end, width, index, ignoredRoomIds, bounds, seed, routeKey, cellSize) {
  const sx = snap(start.x, cellSize);
  const sy = snap(start.y, cellSize);
  const ex = snap(end.x, cellSize);
  const ey = snap(end.y, cellSize);
  const minGX = Math.floor(bounds.minX / cellSize);
  const maxGX = Math.ceil(bounds.maxX / cellSize);
  const minGY = Math.floor(bounds.minY / cellSize);
  const maxGY = Math.ceil(bounds.maxY / cellSize);
  const startKey = key(sx, sy);
  const endKey = key(ex, ey);
  const open = new MinHeap();
  const cameFrom = new Map();
  const gScore = new Map([[startKey, 0]]);
  const closed = new Set();
  let order = 0;
  const h0 = Math.abs(ex - sx) + Math.abs(ey - sy);
  open.push({ x: sx, y: sy, g: 0, h: h0, f: h0, order: order++ });

  const baseDirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
  const rotate = chance(seed, 0.5, "route", routeKey, "neighbor-order") ? 1 : 0;
  const dirs = baseDirs.slice(rotate).concat(baseDirs.slice(0, rotate));
  const clearance = Math.max(width + 8, cellSize * 0.72);

  while (open.size) {
    const current = open.pop();
    const currentKey = key(current.x, current.y);
    if (closed.has(currentKey)) continue;
    if (currentKey === endKey) return reconstruct(cameFrom, currentKey, cellSize);
    closed.add(currentKey);

    for (const [dx, dy] of dirs) {
      const nx = current.x + dx;
      const ny = current.y + dy;
      if (nx < minGX || nx > maxGX || ny < minGY || ny > maxGY) continue;
      const nextKey = key(nx, ny);
      if (closed.has(nextKey)) continue;
      if (nextKey !== endKey && nextKey !== startKey) {
        const probe = rect(nx * cellSize - clearance / 2, ny * cellSize - clearance / 2, clearance, clearance);
        if (areaHitsRoom(probe, index, ignoredRoomIds)) continue;
      }
      const tentative = current.g + 1;
      if (tentative >= (gScore.get(nextKey) ?? Infinity)) continue;
      cameFrom.set(nextKey, currentKey);
      gScore.set(nextKey, tentative);
      const h = Math.abs(ex - nx) + Math.abs(ey - ny);
      open.push({ x: nx, y: ny, g: tentative, h, f: tentative + h, order: order++ });
    }
  }
  return null;
}

export function routeRoomsObstacleAware({
  seed,
  routeKey,
  roomA,
  roomB,
  width,
  spatialIndex,
  meta = {},
}) {
  const ac = centerOf(roomA);
  const bc = centerOf(roomB);
  const start = gatewayPoint(roomA, bc, width);
  const end = gatewayPoint(roomB, ac, width);
  const ignoredRoomIds = new Set([roomA.id, roomB.id]);
  const routeMeta = { ...meta, sourceRoomId: roomA.id, targetRoomId: roomB.id };

  for (const candidate of simpleRouteCandidates(start, end, width, routeMeta, seed, routeKey)) {
    if (!routeIntersectsRooms(candidate, spatialIndex, ignoredRoomIds, 2)) return candidate;
  }

  const cellSize = 18;
  for (const margin of [180, 320, 560, 920, 1400]) {
    const bounds = {
      minX: Math.min(start.x, end.x) - margin,
      maxX: Math.max(start.x, end.x) + margin,
      minY: Math.min(start.y, end.y) - margin,
      maxY: Math.max(start.y, end.y) + margin,
    };
    const gridPath = aStar(start, end, width, spatialIndex, ignoredRoomIds, bounds, seed, routeKey, cellSize);
    if (!gridPath) continue;
    const points = [start, ...gridPath, end];
    const route = pointsToRects(points, width, routeMeta);
    if (!routeIntersectsRooms(route, spatialIndex, ignoredRoomIds, 1)) return route;
  }

  return [];
}
