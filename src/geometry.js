export function rect(x, y, w, h, meta = {}) {
  return { x, y, w, h, ...meta };
}

export function centerOf(r) {
  return { x: r.x + r.w / 2, y: r.y + r.h / 2 };
}

export function inflate(r, pad) {
  return { x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 };
}

export function intersects(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

export function distance(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.hypot(dx, dy);
}

export function boundsOfRects(rects) {
  if (!rects.length) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const r of rects) {
    minX = Math.min(minX, r.x);
    minY = Math.min(minY, r.y);
    maxX = Math.max(maxX, r.x + r.w);
    maxY = Math.max(maxY, r.y + r.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function unionBounds(items) {
  if (!items.length) return { x: 0, y: 0, w: 1, h: 1 };
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const item of items) {
    minX = Math.min(minX, item.x);
    minY = Math.min(minY, item.y);
    maxX = Math.max(maxX, item.x + item.w);
    maxY = Math.max(maxY, item.y + item.h);
  }
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

export function nearestRectPair(aRects, bRects) {
  let best = null;
  let bestDistance = Infinity;
  for (const a of aRects) {
    const ac = centerOf(a);
    for (const b of bRects) {
      const bc = centerOf(b);
      const d = distance(ac, bc);
      if (d < bestDistance) {
        bestDistance = d;
        best = [a, b];
      }
    }
  }
  return best;
}
