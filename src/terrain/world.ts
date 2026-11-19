// Chunk streaming, player edits, worker pool and physics colliders for the terrain.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK, PAD, MIN_CY, MAX_CY, VIEW_RADIUS, COLLIDER_RADIUS, chunkKey } from '../config';
import type { MeshRequest, MeshResponse } from './mesher.worker';

interface Chunk {
  key: string;
  cx: number; cy: number; cz: number;
  mesh: THREE.Mesh | null;
  collider: RAPIER.Collider | null;
  /** Bumped on every edit; a mesh is current when meshedVersion === version. */
  version: number;
  meshedVersion: number;
  inFlight: boolean;
  wantsCollider: boolean;
}

const EDIT_CELLS = CHUNK * CHUNK * CHUNK;
const EDIT_LIMIT = 40;
const floorDiv = (a: number, b: number) => Math.floor(a / b);

export class World {
  readonly group = new THREE.Group();
  readonly material = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  /** Edit offsets per owner chunk: grid point p belongs to chunk floor(p / CHUNK). */
  readonly edits = new Map<string, Float32Array>();
  readonly dirtyEdits = new Set<string>();

  private chunks = new Map<string, Chunk>();
  private workers: Worker[] = [];
  private idle: Worker[] = [];
  private nextId = 1;
  private center = new THREE.Vector3();
  private centerChunk = { x: Number.NaN, z: Number.NaN };
  private rapier: typeof RAPIER;
  private physics: RAPIER.World;

  stats = { meshMs: 0, meshed: 0, loaded: 0, queued: 0 };
  /** Called when a chunk gets (or loses) its mesh, and when it unloads. */
  onChunkMesh: (key: string, mesh: THREE.Mesh | null, cx: number, cy: number, cz: number) => void = () => {};
  onChunkUnload: (key: string) => void = () => {};

  constructor(readonly seed: string, rapier: typeof RAPIER, physics: RAPIER.World) {
    this.rapier = rapier;
    this.physics = physics;
    const n = Math.max(2, Math.min(6, (navigator.hardwareConcurrency || 4) - 1));
    for (let i = 0; i < n; i++) {
      const w = new Worker(new URL('./mesher.worker.ts', import.meta.url), { type: 'module' });
      w.onmessage = (e: MessageEvent<MeshResponse>) => this.onMeshed(w, e.data);
      this.workers.push(w);
      this.idle.push(w);
    }
  }

  dispose() {
    for (const w of this.workers) w.terminate();
    for (const c of this.chunks.values()) this.unload(c);
    this.chunks.clear();
  }

  /** Call every frame with the player's position. */
  update(playerPos: THREE.Vector3) {
    this.center.copy(playerPos);
    const pcx = floorDiv(playerPos.x, CHUNK), pcz = floorDiv(playerPos.z, CHUNK);
    if (pcx !== this.centerChunk.x || pcz !== this.centerChunk.z) {
      this.centerChunk = { x: pcx, z: pcz };
      this.refreshSet(pcx, pcz);
    }
    this.dispatch();
  }

  private refreshSet(pcx: number, pcz: number) {
    const keep = new Set<string>();
    for (let dz = -VIEW_RADIUS; dz <= VIEW_RADIUS; dz++)
      for (let dx = -VIEW_RADIUS; dx <= VIEW_RADIUS; dx++) {
        if (dx * dx + dz * dz > (VIEW_RADIUS + 0.5) ** 2) continue;
        for (let cy = MIN_CY; cy <= MAX_CY; cy++) {
          const cx = pcx + dx, cz = pcz + dz, key = chunkKey(cx, cy, cz);
          keep.add(key);
          let c = this.chunks.get(key);
          if (!c) {
            c = { key, cx, cy, cz, mesh: null, collider: null, version: 1, meshedVersion: 0, inFlight: false, wantsCollider: false };
            this.chunks.set(key, c);
          }
          c.wantsCollider = Math.abs(dx) <= COLLIDER_RADIUS && Math.abs(dz) <= COLLIDER_RADIUS;
          this.syncCollider(c);
        }
      }
    for (const c of [...this.chunks.values()]) {
      const far = Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > VIEW_RADIUS + 1;
      if (!keep.has(c.key) && far) { this.unload(c); this.chunks.delete(c.key); }
    }
    this.stats.loaded = this.chunks.size;
  }

  private priority(c: Chunk) {
    const mx = (c.cx + 0.5) * CHUNK - this.center.x;
    const my = (c.cy + 0.5) * CHUNK - this.center.y;
    const mz = (c.cz + 0.5) * CHUNK - this.center.z;
    // Edited chunks jump the queue so digging feels instant.
    return mx * mx + my * my * 0.5 + mz * mz - (c.meshedVersion > 0 ? 1e9 : 0);
  }

  private dispatch() {
    if (this.idle.length === 0) return;
    const todo: Chunk[] = [];
    for (const c of this.chunks.values()) if (!c.inFlight && c.meshedVersion !== c.version) todo.push(c);
    this.stats.queued = todo.length;
    if (todo.length === 0) return;
    todo.sort((a, b) => this.priority(a) - this.priority(b));
    for (const c of todo) {
      const w = this.idle.pop();
      if (!w) break;
      c.inFlight = true;
      const edits = this.paddedEdits(c.cx, c.cy, c.cz);
      const req: MeshRequest & { version: number } = {
        id: this.nextId++, seed: this.seed, cx: c.cx, cy: c.cy, cz: c.cz, edits, version: c.version,
      };
      (w as Worker & { pendingVersion?: number }).pendingVersion = c.version;
      w.postMessage(req, edits ? [edits.buffer] : []);
    }
  }

  private onMeshed(w: Worker, r: MeshResponse) {
    const version = (w as Worker & { pendingVersion?: number }).pendingVersion ?? 0;
    this.idle.push(w);
    this.stats.meshMs = this.stats.meshMs * 0.9 + r.ms * 0.1;
    this.stats.meshed++;
    const c = this.chunks.get(chunkKey(r.cx, r.cy, r.cz));
    if (!c) return; // unloaded while meshing
    c.inFlight = false;
    c.meshedVersion = version;

    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    if (r.indices.length > 0) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(r.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(r.normals, 3));
      g.setAttribute('color', new THREE.BufferAttribute(r.colors, 3));
      g.setIndex(new THREE.BufferAttribute(r.indices, 1));
      g.computeBoundingSphere();
      g.computeBoundingBox();
      const m = new THREE.Mesh(g, this.material);
      m.position.set(c.cx * CHUNK, c.cy * CHUNK, c.cz * CHUNK);
      m.matrixAutoUpdate = false;
      m.updateMatrix();
      m.userData.chunk = c.key;
      this.group.add(m);
      c.mesh = m;
    }
    this.removeCollider(c);
    this.syncCollider(c);
    this.onChunkMesh(c.key, c.mesh, c.cx, c.cy, c.cz);
    this.dispatch();
  }

  private syncCollider(c: Chunk) {
    if (!c.wantsCollider) { this.removeCollider(c); return; }
    if (c.collider || !c.mesh) return;
    const g = c.mesh.geometry;
    const pos = g.getAttribute('position').array as Float32Array;
    const ind = g.getIndex()!.array as Uint32Array;
    const desc = this.rapier.ColliderDesc.trimesh(pos, ind)
      .setTranslation(c.cx * CHUNK, c.cy * CHUNK, c.cz * CHUNK);
    c.collider = this.physics.createCollider(desc);
  }

  private removeCollider(c: Chunk) {
    if (c.collider) { this.physics.removeCollider(c.collider, false); c.collider = null; }
  }

  private unload(c: Chunk) {
    if (c.mesh) { this.group.remove(c.mesh); c.mesh.geometry.dispose(); c.mesh = null; }
    this.removeCollider(c);
    this.onChunkUnload(c.key);
  }

  /** True once the chunk under this point is meshed and has physics (or is empty air). */
  isReadyAt(p: THREE.Vector3) {
    const c = this.chunks.get(chunkKey(floorDiv(p.x, CHUNK), floorDiv(p.y, CHUNK), floorDiv(p.z, CHUNK)));
    const below = this.chunks.get(chunkKey(floorDiv(p.x, CHUNK), floorDiv(p.y, CHUNK) - 1, floorDiv(p.z, CHUNK)));
    const ok = (ch?: Chunk) => !!ch && ch.meshedVersion > 0 && (!ch.mesh || !!ch.collider);
    return ok(c) && (floorDiv(p.y, CHUNK) <= MIN_CY || ok(below));
  }

  meshes() {
    return this.group.children as THREE.Mesh[];
  }

  /** Change density in a sphere. sign -1 digs, +1 fills. */
  brush(center: THREE.Vector3, radius: number, strength: number, sign: number) {
    const r = Math.ceil(radius);
    const touched = new Set<string>();
    const x0 = Math.floor(center.x) - r, y0 = Math.floor(center.y) - r, z0 = Math.floor(center.z) - r;
    for (let z = z0; z <= z0 + 2 * r + 1; z++)
      for (let y = y0; y <= y0 + 2 * r + 1; y++)
        for (let x = x0; x <= x0 + 2 * r + 1; x++) {
          const dist = Math.hypot(x - center.x, y - center.y, z - center.z);
          if (dist > radius) continue;
          const fall = 1 - dist / radius;
          const amount = sign * strength * fall * fall * (3 - 2 * fall); // smooth falloff = round craters
          const ocx = floorDiv(x, CHUNK), ocy = floorDiv(y, CHUNK), ocz = floorDiv(z, CHUNK);
          if (ocy < MIN_CY || ocy > MAX_CY) continue;
          const key = chunkKey(ocx, ocy, ocz);
          let e = this.edits.get(key);
          if (!e) { e = new Float32Array(EDIT_CELLS); this.edits.set(key, e); }
          const li = (x - ocx * CHUNK) + (y - ocy * CHUNK) * CHUNK + (z - ocz * CHUNK) * CHUNK * CHUNK;
          e[li] = Math.max(-EDIT_LIMIT, Math.min(EDIT_LIMIT, e[li] + amount));
          this.dirtyEdits.add(key);
          // Every chunk whose padded grid contains this point must remesh.
          for (const cz of this.span(z)) for (const cy of this.span(y)) for (const cx of this.span(x))
            touched.add(chunkKey(cx, cy, cz));
        }
    for (const key of touched) {
      const c = this.chunks.get(key);
      if (c) c.version++;
    }
    this.dispatch();
  }

  /** Chunks c whose padded range [c*CHUNK - 1, c*CHUNK + CHUNK] contains p. */
  private span(p: number) {
    const lo = Math.ceil((p - CHUNK) / CHUNK), hi = floorDiv(p + 1, CHUNK);
    const out: number[] = [];
    for (let c = lo; c <= hi; c++) out.push(c);
    return out;
  }

  /** Gather edits from the up-to-27 owner chunks overlapping this chunk's padded grid. */
  private paddedEdits(cx: number, cy: number, cz: number): Float32Array | null {
    let any = false;
    for (let dz = -1; dz <= 1 && !any; dz++)
      for (let dy = -1; dy <= 1 && !any; dy++)
        for (let dx = -1; dx <= 1 && !any; dx++)
          if (this.edits.has(chunkKey(cx + dx, cy + dy, cz + dz))) any = true;
    if (!any) return null;
    const out = new Float32Array(PAD * PAD * PAD);
    let idx = 0;
    for (let k = 0; k < PAD; k++) {
      const z = cz * CHUNK + k - 1, ocz = floorDiv(z, CHUNK), lz = z - ocz * CHUNK;
      for (let j = 0; j < PAD; j++) {
        const y = cy * CHUNK + j - 1, ocy = floorDiv(y, CHUNK), ly = y - ocy * CHUNK;
        for (let i = 0; i < PAD; i++, idx++) {
          const x = cx * CHUNK + i - 1, ocx = floorDiv(x, CHUNK), lx = x - ocx * CHUNK;
          const e = this.edits.get(chunkKey(ocx, ocy, ocz));
          if (e) out[idx] = e[lx + ly * CHUNK + lz * CHUNK * CHUNK];
        }
      }
    }
    return out;
  }
}
