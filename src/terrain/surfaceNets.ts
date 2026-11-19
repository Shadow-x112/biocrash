// Surface nets mesher. Input: a PAD^3 density grid (x fastest). Output: a smooth, seam-free mesh
// in chunk-local coordinates. Each chunk owns the grid edges whose start point lies in [0, CHUNK),
// so neighbouring chunks never duplicate or miss a face.
import { CHUNK, PAD } from '../config';

export interface MeshData {
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
}

const CELLS = PAD - 1; // cells per axis (sample c .. c+1)
const S = (i: number, j: number, k: number) => i + j * PAD + k * PAD * PAD;

// The 12 cube edges as pairs of corner indices; corner bit 0 = +x, bit 1 = +y, bit 2 = +z.
const EDGES: [number, number][] = [
  [0, 1], [2, 3], [4, 5], [6, 7],
  [0, 2], [1, 3], [4, 6], [5, 7],
  [0, 4], [1, 5], [2, 6], [3, 7],
];

export function meshSurfaceNets(d: Float32Array, worldX0: number, worldY0: number, worldZ0: number): MeshData {
  const cellVert = new Int32Array(CELLS * CELLS * CELLS).fill(-1);
  const pos: number[] = [];
  const nrm: number[] = [];
  const col: number[] = [];
  const idx: number[] = [];
  const corner = new Float32Array(8);

  // 1. One vertex per cell that the surface crosses.
  for (let k = 0; k < CELLS; k++)
    for (let j = 0; j < CELLS; j++)
      for (let i = 0; i < CELLS; i++) {
        let mask = 0;
        for (let c = 0; c < 8; c++) {
          const v = d[S(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))];
          corner[c] = v;
          if (v > 0) mask |= 1 << c;
        }
        if (mask === 0 || mask === 255) continue;

        let sx = 0, sy = 0, sz = 0, n = 0;
        for (const [a, b] of EDGES) {
          const va = corner[a], vb = corner[b];
          if ((va > 0) === (vb > 0)) continue;
          const t = va / (va - vb);
          sx += (a & 1) + (((b & 1) - (a & 1)) * t);
          sy += ((a >> 1) & 1) + ((((b >> 1) & 1) - ((a >> 1) & 1)) * t);
          sz += ((a >> 2) & 1) + ((((b >> 2) & 1) - ((a >> 2) & 1)) * t);
          n++;
        }
        const fx = sx / n, fy = sy / n, fz = sz / n;

        // Normal: minus the gradient of the trilinear field at the vertex (density rises into rock).
        const gx =
          (corner[1] - corner[0]) * (1 - fy) * (1 - fz) + (corner[3] - corner[2]) * fy * (1 - fz) +
          (corner[5] - corner[4]) * (1 - fy) * fz + (corner[7] - corner[6]) * fy * fz;
        const gy =
          (corner[2] - corner[0]) * (1 - fx) * (1 - fz) + (corner[3] - corner[1]) * fx * (1 - fz) +
          (corner[6] - corner[4]) * (1 - fx) * fz + (corner[7] - corner[5]) * fx * fz;
        const gz =
          (corner[4] - corner[0]) * (1 - fx) * (1 - fy) + (corner[5] - corner[1]) * fx * (1 - fy) +
          (corner[6] - corner[2]) * (1 - fx) * fy + (corner[7] - corner[3]) * fx * fy;
        let nx = -gx, ny = -gy, nz = -gz;
        const len = Math.hypot(nx, ny, nz) || 1;
        nx /= len; ny /= len; nz /= len;

        // Sample index s sits at local coordinate s - 1.
        const lx = i + fx - 1, ly = j + fy - 1, lz = k + fz - 1;
        cellVert[i + j * CELLS + k * CELLS * CELLS] = pos.length / 3;
        pos.push(lx, ly, lz);
        nrm.push(nx, ny, nz);

        // Fungal forest palette: teal moss on flats with violet and lichen patches, mauve rock on slopes.
        const wx = worldX0 + lx, wy = worldY0 + ly, wz = worldZ0 + lz;
        const patch = Math.sin(wx * 0.11 + Math.sin(wz * 0.07) * 2.0) * Math.cos(wz * 0.09 - Math.sin(wx * 0.05) * 1.7);
        const fleck = Math.sin(wx * 0.9 + wz * 1.3) * Math.sin(wz * 0.8 - wx * 0.6);
        const flat = Math.max(0, Math.min(1, (ny - 0.62) / 0.25));
        const deep = Math.max(0, Math.min(1, (-wy + 2) / 36));
        // Moss base, shifted toward violet or lichen by the patch pattern.
        let mr = 0.25, mg = 0.44, mb = 0.38;
        if (patch > 0.25) { const t = Math.min(1, (patch - 0.25) * 2.2); mr += (0.36 - mr) * t; mg += (0.33 - mg) * t; mb += (0.47 - mb) * t; }
        else if (patch < -0.45) { const t = Math.min(1, (-patch - 0.45) * 2.5); mr += (0.52 - mr) * t; mg += (0.47 - mg) * t; mb += (0.28 - mb) * t; }
        mr *= 1 + fleck * 0.06; mg *= 1 + fleck * 0.06; mb *= 1 + fleck * 0.06;
        // Rock: soft mauve-grey.
        const rr = 0.44, rg = 0.39, rb = 0.43;
        let r = rr + (mr - rr) * flat, g = rg + (mg - rg) * flat, b = rb + (mb - rb) * flat;
        r *= 1 - deep * 0.6; g *= 1 - deep * 0.6; b *= 1 - deep * 0.5;
        col.push(r, g, b);
      }

  // 2. One quad per owned grid edge that changes sign.
  const vert = (i: number, j: number, k: number) => cellVert[i + j * CELLS + k * CELLS * CELLS];
  const quad = (a: number, b: number, c: number, e: number) => {
    if (a < 0 || b < 0 || c < 0 || e < 0) return;
    // Pick the winding whose face normal agrees with the vertex normals.
    const ax = pos[a * 3], ay = pos[a * 3 + 1], az = pos[a * 3 + 2];
    const ux = pos[b * 3] - ax, uy = pos[b * 3 + 1] - ay, uz = pos[b * 3 + 2] - az;
    const vx = pos[c * 3] - ax, vy = pos[c * 3 + 1] - ay, vz = pos[c * 3 + 2] - az;
    const fx = uy * vz - uz * vy, fy = uz * vx - ux * vz, fz = ux * vy - uy * vx;
    const nx = nrm[a * 3] + nrm[b * 3] + nrm[c * 3] + nrm[e * 3];
    const ny = nrm[a * 3 + 1] + nrm[b * 3 + 1] + nrm[c * 3 + 1] + nrm[e * 3 + 1];
    const nz = nrm[a * 3 + 2] + nrm[b * 3 + 2] + nrm[c * 3 + 2] + nrm[e * 3 + 2];
    if (fx * nx + fy * ny + fz * nz >= 0) idx.push(a, b, c, a, c, e);
    else idx.push(a, c, b, a, e, c);
  };

  for (let k = 1; k <= CHUNK; k++)
    for (let j = 1; j <= CHUNK; j++)
      for (let i = 1; i <= CHUNK; i++) {
        const v0 = d[S(i, j, k)] > 0;
        if (v0 !== d[S(i + 1, j, k)] > 0) quad(vert(i, j - 1, k - 1), vert(i, j, k - 1), vert(i, j, k), vert(i, j - 1, k));
        if (v0 !== d[S(i, j + 1, k)] > 0) quad(vert(i - 1, j, k - 1), vert(i, j, k - 1), vert(i, j, k), vert(i - 1, j, k));
        if (v0 !== d[S(i, j, k + 1)] > 0) quad(vert(i - 1, j - 1, k), vert(i, j - 1, k), vert(i, j, k), vert(i - 1, j, k));
      }

  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nrm),
    colors: new Float32Array(col),
    indices: new Uint32Array(idx),
  };
}
