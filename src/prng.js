// Deterministic, addressable pseudo-random helpers.
// No global RNG state is used by the generator.

export function hash32(value) {
  const text = String(value);
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  return h >>> 0;
}

export function addressSeed(worldSeed, ...parts) {
  return hash32([String(worldSeed), ...parts.map(String)].join("\u241f"));
}

export function rand01(worldSeed, ...parts) {
  let a = addressSeed(worldSeed, ...parts) >>> 0;
  a += 0x6d2b79f5;
  let t = a;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

export function randRange(worldSeed, min, max, ...parts) {
  return min + (max - min) * rand01(worldSeed, ...parts);
}

export function randInt(worldSeed, min, maxInclusive, ...parts) {
  return Math.floor(randRange(worldSeed, min, maxInclusive + 1, ...parts));
}

export function chance(worldSeed, probability, ...parts) {
  return rand01(worldSeed, ...parts) < probability;
}

export function pick(worldSeed, items, ...parts) {
  if (!items.length) throw new Error("pick() requires at least one item");
  return items[randInt(worldSeed, 0, items.length - 1, ...parts)];
}

export function signed(worldSeed, magnitude, ...parts) {
  return randRange(worldSeed, -magnitude, magnitude, ...parts);
}
