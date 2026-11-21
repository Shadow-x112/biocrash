import { describe, it, expect } from 'vitest';
import { createGenerator } from '../src/terrain/density';
import { meshSurfaceNets } from '../src/terrain/surfaceNets';
import { CHUNK, PAD } from '../src/config';

// Faces must point into the air: their geometric normal should agree with the field's normal almost everywhere,
// including after a crater is dug through the chunk (the case that used to leave holes).
function agreement(d: Float32Array, cx: number, cy: number, cz: number) {
  const m = meshSurfaceNets(d, cx * CHUNK, cy * CHUNK, cz * CHUNK);
  let ok = 0, n = 0;
  for (let t = 0; t < m.indices.length; t += 3) {
    const [a, b, c] = [m.indices[t], m.indices[t + 1], m.indices[t + 2]];
    const p = (i: number) => [m.positions[i * 3], m.positions[i * 3 + 1], m.positions[i * 3 + 2]];
    const A = p(a), B = p(b), C = p(c);
    const u = [B[0] - A[0], B[1] - A[1], B[2] - A[2]], v = [C[0] - A[0], C[1] - A[1], C[2] - A[2]];
    const f = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
    const nn = [0, 1, 2].map((k) => m.normals[a * 3 + k] + m.normals[b * 3 + k] + m.normals[c * 3 + k]);
    if (Math.hypot(...f) < 1e-6) continue;
    n++; if (f[0] * nn[0] + f[1] * nn[1] + f[2] * nn[2] > 0) ok++;
  }
  return { ratio: ok / n, n };
}

describe('surface nets winding', () => {
  const g = createGenerator('testseed');
  const d = new Float32Array(PAD * PAD * PAD);
  it('faces point into the air on untouched terrain', () => {
    g.fillChunk(0, 0, 0, d);
    const r = agreement(d, 0, 0, 0);
    expect(r.n).toBeGreaterThan(100);
    expect(r.ratio).toBeGreaterThan(0.98);
  });
  it('and after digging a deep crater', () => {
    g.fillChunk(0, 0, 0, d);
    for (let k = 0; k < PAD; k++) for (let j = 0; j < PAD; j++) for (let i = 0; i < PAD; i++) {
      const dist = Math.hypot(i - 16, j - 12, k - 16);
      if (dist < 7) d[i + j * PAD + k * PAD * PAD] -= 3 * (1 - dist / 7);
    }
    const r = agreement(d, 0, 0, 0);
    expect(r.ratio).toBeGreaterThan(0.97);
  });
});
