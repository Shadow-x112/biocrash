// World generator: a seeded 3D density field. Positive = solid, negative = air, 0 = surface.
// Frozen per GEN_VERSION: changing this changes unedited land in existing saves.
import { createNoise2D, createNoise3D } from 'simplex-noise';
import alea from 'alea';
import { CHUNK, PAD } from '../config';

export interface Generator {
  /** Fill a PAD^3 array (x fastest, then y, then z) for the chunk at (cx, cy, cz). */
  fillChunk(cx: number, cy: number, cz: number, out: Float32Array): void;
  /** Ground height at a column (ignores caves). */
  surfaceHeight(x: number, z: number): number;
}

const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const smooth = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

export function createGenerator(seed: string): Generator {
  const n2a = createNoise2D(alea(seed + ':h'));
  const n2b = createNoise2D(alea(seed + ':r'));
  const n2c = createNoise2D(alea(seed + ':d'));
  const n3a = createNoise3D(alea(seed + ':ca'));
  const n3b = createNoise3D(alea(seed + ':cb'));
  const n3w = createNoise3D(alea(seed + ':w'));

  const fbm2 = (x: number, z: number, oct: number) => {
    let sum = 0, amp = 1, freq = 1, norm = 0;
    for (let i = 0; i < oct; i++) {
      sum += n2a(x * freq, z * freq) * amp;
      norm += amp; amp *= 0.5; freq *= 2.03;
    }
    return sum / norm;
  };

  const surfaceHeight = (x: number, z: number) => {
    // Domain warp keeps hills from looking like round blobs.
    const wx = x + n2c(x * 0.002, z * 0.002) * 60;
    const wz = z + n2c(z * 0.002 + 31.7, x * 0.002 - 12.1) * 60;
    const rolling = fbm2(wx * 0.0035, wz * 0.0035, 5) * 22;
    const ridge = (1 - Math.abs(n2b(wx * 0.006, wz * 0.006))) ** 3 * 26;
    const mask = smooth(-0.2, 0.5, n2c(x * 0.0012 + 7, z * 0.0012 - 3));
    return 14 + rolling + ridge * mask;
  };

  const fillChunk = (cx: number, cy: number, cz: number, out: Float32Array) => {
    const ox = cx * CHUNK - 1, oy = cy * CHUNK - 1, oz = cz * CHUNK - 1;
    const heights = new Float32Array(PAD * PAD);
    for (let k = 0; k < PAD; k++)
      for (let i = 0; i < PAD; i++) heights[i + k * PAD] = surfaceHeight(ox + i, oz + k);

    let idx = 0;
    for (let k = 0; k < PAD; k++) {
      const z = oz + k;
      for (let j = 0; j < PAD; j++) {
        const y = oy + j;
        for (let i = 0; i < PAD; i++, idx++) {
          const x = ox + i;
          const h = heights[i + k * PAD];
          let d = h - y;
          // Surface detail: gentle 3D wobble so cliffs get overhangs.
          if (d > -12 && d < 12) d += n3w(x * 0.045, y * 0.045, z * 0.045) * 3.2;
          // Tunnels: where two noise fields both cross zero, carve a worm-like cave.
          if (y < h - 3) {
            const a = n3a(x * 0.022, y * 0.03, z * 0.022);
            const b = n3b(x * 0.022, y * 0.03, z * 0.022);
            const t = smooth(0.11, 0.0, Math.abs(a)) * smooth(0.11, 0.0, Math.abs(b));
            const depthFade = smooth(h - 3, h - 10, y);
            d -= t * depthFade * 24;
          }
          out[idx] = clamp(d, -16, 16);
        }
      }
    }
  };

  return { fillChunk, surfaceHeight };
}
