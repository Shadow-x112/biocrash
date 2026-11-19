/// <reference lib="webworker" />
// Builds chunk meshes off the main thread: generate density, apply player edits, mesh.
import { createGenerator, type Generator } from './density';
import { meshSurfaceNets } from './surfaceNets';
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
  ms: number;
}

let gen: Generator | null = null;
let genSeed = '';
const density = new Float32Array(PAD * PAD * PAD);

self.onmessage = (e: MessageEvent<MeshRequest>) => {
  const t0 = performance.now();
  const { id, seed, cx, cy, cz, edits } = e.data;
  if (!gen || genSeed !== seed) { gen = createGenerator(seed); genSeed = seed; }
  gen.fillChunk(cx, cy, cz, density);
  if (edits) for (let i = 0; i < density.length; i++) density[i] += edits[i];
  const mesh = meshSurfaceNets(density, cx * CHUNK, cy * CHUNK, cz * CHUNK);
  const res: MeshResponse = { id, cx, cy, cz, ...mesh, ms: performance.now() - t0 };
  (self as unknown as DedicatedWorkerGlobalScope).postMessage(res, [
    mesh.positions.buffer, mesh.normals.buffer, mesh.colors.buffer, mesh.indices.buffer,
  ]);
};
