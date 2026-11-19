// Gatherable things lying on the ground: stones, stalkwood and fiber tufts.
// Placement is seeded per chunk, so the same world always has the same props; picked ones are saved.
import * as THREE from 'three';
import alea from 'alea';
import { CHUNK } from './config';
import type { ItemId } from './inventory';

interface PropKind {
  id: ItemId;
  perChunk: number;
  geometry: THREE.BufferGeometry;
  material: THREE.Material;
  scale: [number, number];
  yOffset: number;
  lying: boolean; // rotate to lie flat on the ground
}

interface ChunkProps {
  meshes: THREE.InstancedMesh[];
  /** Per mesh: prop ids by instance index ('' once picked or gone). */
  ids: string[][];
  positions: THREE.Vector3[][];
}

function fiberGeometry() {
  const parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.ConeGeometry(0.035, 0.55 + (i % 3) * 0.12, 4);
    g.translate(0, 0.28, 0);
    g.rotateZ((i - 2) * 0.22);
    g.rotateY(i * 1.3);
    parts.push(g);
  }
  return mergeSimple(parts);
}

/** Minimal merge for non-indexed-compatible primitive geometries (avoids pulling in addons). */
function mergeSimple(parts: THREE.BufferGeometry[]) {
  const pos: number[] = [], nrm: number[] = [];
  for (const p of parts) {
    const g = p.index ? p.toNonIndexed() : p;
    pos.push(...(g.getAttribute('position').array as Float32Array));
    nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

const KINDS: PropKind[] = [
  {
    id: 'stone', perChunk: 14, scale: [0.7, 1.3], yOffset: 0.08, lying: false,
    geometry: new THREE.IcosahedronGeometry(0.22, 0),
    material: new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 1, flatShading: true }),
  },
  {
    id: 'stalkwood', perChunk: 10, scale: [0.8, 1.25], yOffset: 0.06, lying: true,
    geometry: new THREE.CylinderGeometry(0.06, 0.09, 1.2, 6),
    material: new THREE.MeshStandardMaterial({ color: 0xcdbfa3, roughness: 0.9, flatShading: true }),
  },
  {
    id: 'fiber', perChunk: 16, scale: [0.8, 1.4], yOffset: 0, lying: false,
    geometry: fiberGeometry(),
    material: new THREE.MeshStandardMaterial({ color: 0x6f9a63, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  },
];

export class Props {
  readonly group = new THREE.Group();
  readonly picked = new Set<string>();
  private chunks = new Map<string, ChunkProps>();
  private ray = new THREE.Raycaster();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);

  constructor(private seed: string) {}

  /** Called by the world whenever a chunk's mesh changes. */
  onChunkMesh(key: string, mesh: THREE.Mesh | null, cx: number, cy: number, cz: number) {
    const existing = this.chunks.get(key);
    if (existing) { this.dropUnsupported(existing, mesh); return; }
    if (!mesh) return;
    this.spawn(key, mesh, cx, cy, cz);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const m of c.meshes) { this.group.remove(m); m.dispose(); }
    this.chunks.delete(key);
  }

  private spawn(key: string, mesh: THREE.Mesh, cx: number, cy: number, cz: number) {
    const rng = alea(`${this.seed}:props:${key}`);
    const top = (cy + 1) * CHUNK + 0.5;
    const c: ChunkProps = { meshes: [], ids: [], positions: [] };
    mesh.updateMatrixWorld();
    for (const kind of KINDS) {
      const found: { p: THREE.Vector3; n: THREE.Vector3; id: string; r: number; sc: number }[] = [];
      for (let i = 0; i < kind.perChunk; i++) {
        const x = cx * CHUNK + rng() * CHUNK, z = cz * CHUNK + rng() * CHUNK;
        const r = rng(), sc = kind.scale[0] + rng() * (kind.scale[1] - kind.scale[0]);
        const id = `${key}:${kind.id}:${i}`;
        if (this.picked.has(id)) continue;
        this.ray.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
        this.ray.far = CHUNK + 1;
        const hit = this.ray.intersectObject(mesh, false)[0];
        if (!hit || !hit.face || hit.face.normal.y < 0.65) continue; // only on fairly flat ground
        found.push({ p: hit.point, n: hit.face.normal.clone(), id, r, sc });
      }
      if (found.length === 0) continue;
      const im = new THREE.InstancedMesh(kind.geometry, kind.material, found.length);
      im.userData.kind = kind.id;
      const ids: string[] = [], positions: THREE.Vector3[] = [];
      found.forEach((f, idx) => {
        this.q.setFromUnitVectors(this.up, f.n);
        const spin = new THREE.Quaternion().setFromAxisAngle(this.up, f.r * Math.PI * 2);
        if (kind.lying) spin.multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2));
        this.q.multiply(spin);
        this.s.setScalar(f.sc);
        const p = f.p.clone().addScaledVector(f.n, kind.yOffset * f.sc);
        this.m.compose(p, this.q, this.s);
        im.setMatrixAt(idx, this.m);
        ids.push(f.id);
        positions.push(p);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.group.add(im);
      c.meshes.push(im); c.ids.push(ids); c.positions.push(positions);
    }
    this.chunks.set(key, c);
  }

  /** After digging, props whose ground vanished disappear (they are not marked as picked). */
  private dropUnsupported(c: ChunkProps, mesh: THREE.Mesh | null) {
    const zero = new THREE.Matrix4().makeScale(0, 0, 0);
    mesh?.updateMatrixWorld();
    c.meshes.forEach((im, mi) => {
      let changed = false;
      c.positions[mi].forEach((p, i) => {
        if (!c.ids[mi][i]) return;
        let supported = false;
        if (mesh) {
          this.ray.set(this.s.copy(p).addScaledVector(this.up, 0.5), new THREE.Vector3(0, -1, 0));
          this.ray.far = 1.3;
          supported = this.ray.intersectObject(mesh, false).length > 0;
        }
        if (!supported) { c.ids[mi][i] = ''; im.setMatrixAt(i, zero); changed = true; }
      });
      if (changed) im.instanceMatrix.needsUpdate = true;
    });
  }

  /** What prop (if any) the camera is looking at within reach. */
  lookAt(camera: THREE.Camera, reach: number): { kind: ItemId; mesh: THREE.InstancedMesh; index: number; id: string } | null {
    this.ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    this.ray.far = reach;
    const hit = this.ray.intersectObjects(this.group.children, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const mesh = hit.object as THREE.InstancedMesh;
    for (const c of this.chunks.values()) {
      const mi = c.meshes.indexOf(mesh);
      if (mi < 0) continue;
      const id = c.ids[mi][hit.instanceId];
      if (!id) return null;
      return { kind: mesh.userData.kind as ItemId, mesh, index: hit.instanceId, id };
    }
    return null;
  }

  pick(target: { mesh: THREE.InstancedMesh; index: number; id: string }) {
    this.picked.add(target.id);
    target.mesh.setMatrixAt(target.index, new THREE.Matrix4().makeScale(0, 0, 0));
    target.mesh.instanceMatrix.needsUpdate = true;
    for (const c of this.chunks.values()) {
      const mi = c.meshes.indexOf(target.mesh);
      if (mi >= 0) c.ids[mi][target.index] = '';
    }
  }
}
