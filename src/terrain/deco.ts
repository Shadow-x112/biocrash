// Decoration placement, computed in the mesher worker from the UNEDITED terrain, so digging a tunnel
// or filling a hole never spawns new props, and the same world always gets the same layout.
// After edits are applied, each candidate gets a `valid` flag: false when its ground was dug away or buried.
import alea from 'alea';
import { CHUNK, PAD } from '../config';

export type DecoKind = 'stone' | 'stalkwood' | 'fiber' | 'giant' | 'small' | 'sprout';
export const DECO_KINDS: DecoKind[] = ['stone', 'stalkwood', 'fiber', 'giant', 'small', 'sprout'];

/** Floats per candidate: x, y, z (world), ny (surface normal y), r0..r3 (seeded randoms), valid (0/1). */
export const STRIDE = 9;
export type DecoData = Record<DecoKind, Float32Array>;

interface KindRule { minNy: number; openSky: boolean; count: (grove: number) => number; cluster?: number; }
const RULES: Record<DecoKind, KindRule> = {
  stone: { minNy: 0.65, openSky: true, count: () => 14 },
  stalkwood: { minNy: 0.65, openSky: true, count: () => 10 },
  fiber: { minNy: 0.65, openSky: true, count: () => 16 },
  giant: { minNy: 0.78, openSky: true, count: (g) => Math.round(1 + g * 5) },
  small: { minNy: 0.78, openSky: true, count: (g) => Math.round(4 + g * 10) },
  sprout: { minNy: 0.7, openSky: false, count: (g) => Math.round(3 + g * 6), cluster: 7 }, // glow sprouts also grow in caves
};

/** Forest density by chunk: groves and clearings. */
export const groveAt = (cx: number, cz: number) => 0.5 + 0.5 * Math.sin(cx * 1.7 + cz * 0.9) * Math.cos(cz * 1.3 - cx * 0.4);

const S = (i: number, j: number, k: number) => i + j * PAD + k * PAD * PAD;

/** Trilinear density at chunk-local coordinates (sample index = local + 1). */
export function sampleDensity(d: Float32Array, lx: number, ly: number, lz: number) {
  const x = Math.min(PAD - 1.001, Math.max(0, lx + 1)), y = Math.min(PAD - 1.001, Math.max(0, ly + 1)), z = Math.min(PAD - 1.001, Math.max(0, lz + 1));
  const i = Math.floor(x), j = Math.floor(y), k = Math.floor(z), fx = x - i, fy = y - j, fz = z - k;
  const c = (a: number, b: number, e: number) => d[S(i + a, j + b, k + e)];
  const x00 = c(0, 0, 0) + (c(1, 0, 0) - c(0, 0, 0)) * fx, x10 = c(0, 1, 0) + (c(1, 1, 0) - c(0, 1, 0)) * fx;
  const x01 = c(0, 0, 1) + (c(1, 0, 1) - c(0, 0, 1)) * fx, x11 = c(0, 1, 1) + (c(1, 1, 1) - c(0, 1, 1)) * fx;
  const y0 = x00 + (x10 - x00) * fy, y1 = x01 + (x11 - x01) * fy;
  return y0 + (y1 - y0) * fz;
}

/** Highest air-over-solid crossing in a grid column (local coords), or NaN. */
function columnTop(d: Float32Array, i: number, k: number) {
  for (let j = PAD - 1; j >= 1; j--) {
    const above = d[S(i, j, k)], below = d[S(i, j - 1, k)];
    if (above <= 0 && below > 0) return j - 1 + below / (below - above) - 1;
  }
  return Number.NaN;
}

/** Surface height at a continuous local (x, z), bilinear over the four grid columns. */
function surfaceAt(d: Float32Array, lx: number, lz: number) {
  const i = Math.floor(lx) + 1, k = Math.floor(lz) + 1, fx = lx - Math.floor(lx), fz = lz - Math.floor(lz);
  const h00 = columnTop(d, i, k), h10 = columnTop(d, i + 1, k), h01 = columnTop(d, i, k + 1), h11 = columnTop(d, i + 1, k + 1);
  if ([h00, h10, h01, h11].some(Number.isNaN)) return null;
  // Steep or broken columns (cliffs, overhang edges) are rejected by the slope test below.
  const y = (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz;
  const dx = ((h10 - h00) * (1 - fz) + (h11 - h01) * fz), dz = ((h01 - h00) * (1 - fx) + (h11 - h10) * fx);
  const ny = 1 / Math.hypot(dx, 1, dz);
  return { y, ny };
}

export function computeDeco(
  seed: string, cx: number, cy: number, cz: number,
  base: Float32Array, edited: Float32Array | null,
  openSkyHeight: (x: number, z: number) => number,
): DecoData {
  const grove = groveAt(cx, cz);
  const out = {} as DecoData;
  for (const kind of DECO_KINDS) {
    const rule = RULES[kind];
    const rng = alea(`${seed}:deco:${cx},${cy},${cz}:${kind}`);
    const n = rule.count(grove);
    const per = rule.cluster ?? 1;
    const buf: number[] = [];
    for (let c = 0; c < n; c++) {
      const ax = rng() * CHUNK, az = rng() * CHUNK;
      for (let m = 0; m < per; m++) {
        // Clustered kinds jitter around the cluster centre; the rng is always consumed the same way.
        const jx = per > 1 ? (rng() - 0.5) * 2.2 : 0, jz = per > 1 ? (rng() - 0.5) * 2.2 : 0;
        const r0 = rng(), r1 = rng(), r2 = rng(), r3 = rng();
        const lx = ax + jx, lz = az + jz;
        if (lx < 0 || lz < 0 || lx >= CHUNK - 0.001 || lz >= CHUNK - 0.001) continue;
        const s = surfaceAt(base, lx, lz);
        if (!s || s.y < 0 || s.y >= CHUNK || s.ny < rule.minNy) continue;
        const wx = cx * CHUNK + lx, wy = cy * CHUNK + s.y, wz = cz * CHUNK + lz;
        if (rule.openSky && wy < openSkyHeight(wx, wz) - 3.5) continue; // no forests in caves
        let valid = 1;
        if (edited) valid = sampleDensity(edited, lx, s.y - 0.45, lz) > 0 && sampleDensity(edited, lx, s.y + 0.7, lz) <= 0 ? 1 : 0;
        buf.push(wx, wy, wz, s.ny, r0, r1, r2, r3, valid);
      }
    }
    out[kind] = new Float32Array(buf);
  }
  return out;
}

/** Top-surface heights (edited terrain) on the chunk's 33x33 x/z grid, NaN where this chunk has no top surface. */
export function computeHeights(d: Float32Array) {
  const n = CHUNK + 1;
  const h = new Float32Array(n * n);
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const y = columnTop(d, i + 1, k + 1);
    h[i + k * n] = y >= -0.5 && y < CHUNK + 0.5 ? y : Number.NaN;
  }
  return h;
}
