/// <reference lib="webworker" />
// Builds chunk data off the main thread: generate density, apply player edits, mesh,
// place decorations (from the unedited terrain) and sample a height grid for creatures.
import { createGenerator, type Generator } from './density';
import { meshSurfaceNets } from './surfaceNets';
import { computeDeco, computeHeights, DECO_KINDS, type DecoData } from './deco';
import { CHUNK, PAD } from '../config';

export interface MeshRequest {
  id: number;
  seed: string;
  cx: number; cy: number; cz: number;
  /** PAD^3 density offsets from digging/filling, or null if the chunk was never edited. */
  edits: Float32Array | null;
}

export interface MeshResponse {
  id: number;
  cx: number; cy: number; cz: number;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  indices: Uint32Array;
  deco: DecoData;
  heights: Float32Array;
  ms: number;
}

let gen: Generator | null = null;
let genSeed = '';
const density = new Float32Array(PAD * PAD * PAD);
const baseCopy = new Float32Array(PAD * PAD * PAD);

self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const t0 = performance.now();
  const { id, seed, cx, cy, cz, edits } = e.data;
  if (!gen || genSeed !== seed) { gen = createGenerator(seed); genSeed = seed; }
  gen.fillChunk(cx, cy, cz, density);
  let base = density;
  if (edits) {
    baseCopy.set(density);
    base = baseCopy;
    for (let i = 0; i < density.length; i++) density[i] += edits[i];
  }
  const g = gen;
  const deco = computeDeco(seed, cx, cy, cz, base, edits ? density : null, (x, z) => g.surfaceHeight(x, z));
  const heights = computeHeights(density);
  const mesh = meshSurfaceNets(density, cx * CHUNK, cy * CHUNK, cz * CHUNK);
  const res: MeshResponse = { id, cx, cy, cz, ...mesh, deco, heights, ms: performance.now() - t0 };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, [
    mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer, heights.buffer,
    ...DECO_KINDS.map((k) => deco[k].buffer),
  ]);
};
