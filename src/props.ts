// Gatherable things lying on the ground: stones, stalkwood and fiber tufts.
// Positions come from the worker's decoration pass (unedited terrain, seeded per chunk); picked ones are saved.
import * as THREE from 'three';
import type { ItemId } from './inventory';
import { STRIDE, type DecoData, type DecoKind } from './terrain/deco';

interface PropKind {
  id: ItemId & DecoKind;
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
  /** Per mesh: candidate index in the deco data, to match validity updates after edits. */
  source: number[][];
}

function fiberGeometry() {
  const pos: number[] = [], nrm: number[] = [];
  for (let i = 0; i < 5; i++) {
    const g = new THREE.ConeGeometry(0.035, 0.55 + (i % 3) * 0.12, 4);
    g.translate(0, 0.28, 0);
    g.rotateZ((i - 2) * 0.22);
    g.rotateY(i * 1.3);
    const ng = g.toNonIndexed();
    pos.push(...(ng.getAttribute('position').array as Float32Array));
    nrm.push(...(ng.getAttribute('normal').array as Float32Array));
    g.dispose(); ng.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
}

const KINDS: PropKind[] = [
  {
    id: 'stone', scale: [0.7, 1.3], yOffset: 0.08, lying: false,
    geometry: new THREE.IcosahedronGeometry(0.22, 0),
    material: new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 1, flatShading: true }),
  },
  {
    id: 'stalkwood', scale: [0.8, 1.25], yOffset: 0.06, lying: true,
    geometry: new THREE.CylinderGeometry(0.06, 0.09, 1.2, 6),
    material: new THREE.MeshStandardMaterial({ color: 0xcdbfa3, roughness: 0.9, flatShading: true }),
  },
  {
    id: 'fiber', scale: [0.8, 1.4], yOffset: 0, lying: false,
    geometry: fiberGeometry(),
    material: new THREE.MeshStandardMaterial({ color: 0x6f9a63, roughness: 1, flatShading: true, side: THREE.DoubleSide }),
  },
];

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class Props {
  readonly group = new THREE.Group();
  readonly picked = new Set<string>();
  private chunks = new Map<string, ChunkProps>();
  private ray = new THREE.Raycaster();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private spin = new THREE.Quaternion();
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private n = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private xAxis = new THREE.Vector3(1, 0, 0);
  private centre = new THREE.Vector2(0, 0);

  /** Called by the world whenever a chunk gets new data. */
  onChunkMesh(key: string, deco: DecoData) {
    const existing = this.chunks.get(key);
    if (existing) this.applyValidity(existing, deco);
    else this.spawn(key, deco);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const m of c.meshes) { this.group.remove(m); m.dispose(); }
    this.chunks.delete(key);
  }

  private spawn(key: string, deco: DecoData) {
    const c: ChunkProps = { meshes: [], ids: [], source: [] };
    for (const kind of KINDS) {
      const d = deco[kind.id];
      const keep: number[] = [];
      for (let i = 0; i < d.length / STRIDE; i++) {
        if (!d[i * STRIDE + 8]) continue; // ground dug away or buried
        if (this.picked.has(`${key}:${kind.id}:${i}`)) continue;
        keep.push(i);
      }
      if (keep.length === 0) continue;
      const im = new THREE.InstancedMesh(kind.geometry, kind.material, keep.length);
      im.userData.kind = kind.id;
      const ids: string[] = [];
      keep.forEach((i, idx) => {
        const o = i * STRIDE;
        const sc = kind.scale[0] + d[o + 5] * (kind.scale[1] - kind.scale[0]);
        // Tilt to the slope: approximate the normal from ny with a seeded lean direction.
        const lean = Math.acos(Math.min(1, d[o + 3])), dir = d[o + 6] * Math.PI * 2;
        this.n.set(Math.sin(lean) * Math.cos(dir), d[o + 3], Math.sin(lean) * Math.sin(dir)).normalize();
        this.q.setFromUnitVectors(this.up, this.n);
        this.spin.setFromAxisAngle(this.up, d[o + 4] * Math.PI * 2);
        if (kind.lying) this.spin.multiply(new THREE.Quaternion().setFromAxisAngle(this.xAxis, Math.PI / 2));
        this.q.multiply(this.spin);
        this.p.set(d[o], d[o + 1], d[o + 2]).addScaledVector(this.n, kind.yOffset * sc);
        this.m.compose(this.p, this.q, this.s.setScalar(sc));
        im.setMatrixAt(idx, this.m);
        ids.push(`${key}:${kind.id}:${i}`);
      });
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.group.add(im);
      c.meshes.push(im); c.ids.push(ids); c.source.push(keep);
    }
    this.chunks.set(key, c);
  }

  /** After digging or filling: props whose ground changed disappear (not marked as picked). */
  private applyValidity(c: ChunkProps, deco: DecoData) {
    c.meshes.forEach((im, mi) => {
      const d = deco[im.userData.kind as DecoKind];
      let changed = false;
      c.source[mi].forEach((i, idx) => {
        if (!c.ids[mi][idx] || d[i * STRIDE + 8]) return;
        c.ids[mi][idx] = '';
        im.setMatrixAt(idx, ZERO);
        changed = true;
      });
      if (changed) im.instanceMatrix.needsUpdate = true;
    });
  }

  /** What prop (if any) the camera is looking at within reach. */
  lookAt(camera: THREE.Camera, reach: number): { kind: ItemId; mesh: THREE.InstancedMesh; index: number; id: string; dist: number } | null {
    this.ray.setFromCamera(this.centre, camera);
    this.ray.far = reach;
    const hit = this.ray.intersectObjects(this.group.children, false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const mesh = hit.object as THREE.InstancedMesh;
    for (const c of this.chunks.values()) {
      const mi = c.meshes.indexOf(mesh);
      if (mi < 0) continue;
      const id = c.ids[mi][hit.instanceId];
      if (!id) return null;
      return { kind: mesh.userData.kind as ItemId, mesh, index: hit.instanceId, id, dist: hit.distance };
    }
    return null;
  }

  pick(target: { mesh: THREE.InstancedMesh; index: number; id: string }) {
    this.picked.add(target.id);
    target.mesh.setMatrixAt(target.index, ZERO);
    target.mesh.instanceMatrix.needsUpdate = true;
    for (const c of this.chunks.values()) {
      const mi = c.meshes.indexOf(target.mesh);
      if (mi >= 0) c.ids[mi][target.index] = '';
    }
  }
}
