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

type Entry = { kind: PropKind; slot: number; splat: number; id: string; source: number; x: number; z: number };

interface ChunkProps {
  /** Live instances: pool slot and prop id per kind. */
  slots: Entry[];
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

import { InstancePool } from './pool';
import { addDetail, addFade, addGrounding, addWind, splatMaterial } from './assets';
import { fxUniforms } from './fx';

/** Local height of a model's top (wind bends from 0 to here). */
function tipHeight(g: THREE.BufferGeometry) { g.computeBoundingBox(); return Math.max(0.05, g.boundingBox!.max.y); }

/** Contact patch size per kind (x, z in the prop's ground frame, times its scale). */
const SPLAT: Record<string, [number, number]> = { stone: [0.62, 0.62], stalkwood: [0.42, 1.55], fiber: [0.5, 0.5] };

export class Props {
  /** Ground nothing may lie on (the wreck). */
  blocked?: (x: number, z: number) => boolean;
  readonly group = new THREE.Group();
  readonly picked = new Set<string>();
  private chunks = new Map<string, ChunkProps>();
  private pools: Map<PropKind['id'], InstancePool>;
  /** Pool slot -> owning chunk and entry, per kind. */
  private owners = new Map<THREE.InstancedMesh, Map<number, { key: string; id: string }>>();
  private ray = new THREE.Raycaster();
  private m = new THREE.Matrix4();
  private q = new THREE.Quaternion();
  private spin = new THREE.Quaternion();
  private lie = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI / 2);
  private s = new THREE.Vector3();
  private p = new THREE.Vector3();
  private n = new THREE.Vector3();
  private up = new THREE.Vector3(0, 1, 0);
  private centre = new THREE.Vector2(0, 0);

  /** Dark contact patches under every prop (not raycast). */
  private splats: InstancePool;
  private gq = new THREE.Quaternion();
  private gs = new THREE.Vector3();

  constructor() {
    const quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    this.splats = new InstancePool(quad, splatMaterial(), this.group, 4096);
    this.splats.mesh.renderOrder = -1;
    this.pools = new Map(KINDS.map((k) => {
      const pool = new InstancePool(k.geometry, k.material, this.group, 2048);
      pool.mesh.userData.kind = k.id;
      return [k.id, pool] as const;
    }));
  }

  /** Use the Blender-built models once loaded. */
  setLooks(meshes: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>) {
    const map: Record<string, string> = { stone: 'Stone', stalkwood: 'Stalkwood', fiber: 'Fiber' };
    for (const [id, name] of Object.entries(map)) {
      const m = meshes[name], pool = this.pools.get(id as PropKind['id']);
      if (!m || !pool) continue;
      // Own material per kind: grounding depends on how far above the ground the kind sits.
      const kind = KINDS.find((k) => k.id === id)!, mat = m.material.clone();
      if (id === 'stone') addDetail(mat, { scale: 2.2, normal: 0.85, moss: 0.9, wet: 0.2, macro: 0.75 });
      if (id === 'stalkwood') addDetail(mat, { scale: 3.0, normal: 0.8, moss: 0.55, wet: 0.25, macro: 0.7 });
      if (id === 'fiber') { addDetail(mat, { scale: 4.0, normal: 0.2, macro: 0.8, rough: 0.3 }); addWind(mat, fxUniforms.uFxTime, 0.16, tipHeight(m.geometry)); }
      if (id !== 'stalkwood') addFade(mat, 55, 75); // small things dissolve at range instead of popping
      addGrounding(mat, kind.yOffset + (kind.lying ? 0.03 : 0.02), id === 'fiber' ? 0.22 : 0.16, id === 'fiber' ? 0.5 : 0.62);
      pool.setLook(m.geometry, mat);
      pool.mesh.castShadow = id === 'stalkwood'; // stones and tufts are too small for the shadow map; AO grounds them
    }
    this.rebuildOwners();
  }

  /** Called by the world whenever a chunk gets new data. */
  onChunkMesh(key: string, deco: DecoData) {
    const existing = this.chunks.get(key);
    if (existing) this.applyValidity(key, existing, deco);
    else this.spawn(key, deco);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const e of c.slots) this.releaseEntry(e);
    this.chunks.delete(key);
  }

  private ownerMap(kind: PropKind) {
    const mesh = this.pools.get(kind.id)!.mesh;
    let map = this.owners.get(mesh);
    if (!map) { map = new Map(); this.owners.set(mesh, map); }
    return map;
  }

  private releaseEntry(e: Entry) {
    this.ownerMap(e.kind).delete(e.slot);
    this.pools.get(e.kind.id)!.release(e.slot);
    this.splats.release(e.splat);
  }

  private spawn(key: string, deco: DecoData) {
    const c: ChunkProps = { slots: [] };
    const meshesBefore = [...this.pools.values()].map((p) => p.mesh);
    for (const kind of KINDS) {
      const d = deco[kind.id];
      const pool = this.pools.get(kind.id)!;
      for (let i = 0; i < d.length / STRIDE; i++) {
        const o = i * STRIDE;
        if (!d[o + 8]) continue; // ground dug away or buried
        const id = `${key}:${kind.id}:${i}`;
        if (this.picked.has(id)) continue;
        if (this.blocked?.(d[o], d[o + 2])) continue; // not inside the wreck
        const sc = kind.scale[0] + d[o + 5] * (kind.scale[1] - kind.scale[0]);
        // Lie with the slope (the true surface normal).
        this.n.set(d[o + 9], d[o + 3], d[o + 10]).normalize();
        this.q.setFromUnitVectors(this.up, this.n);
        this.spin.setFromAxisAngle(this.up, d[o + 4] * Math.PI * 2);
        if (kind.lying) this.spin.multiply(this.lie);
        this.q.multiply(this.spin);
        this.p.set(d[o], d[o + 1], d[o + 2]).addScaledVector(this.n, kind.yOffset * sc);
        this.m.compose(this.p, this.q, this.s.setScalar(sc));
        const slot = pool.alloc(this.m);
        // Contact patch: on the ground plane under it, turned with the prop (logs get a long one).
        this.gq.setFromUnitVectors(this.up, this.n).multiply(this.spin.setFromAxisAngle(this.up, d[o + 4] * Math.PI * 2));
        const [sx, sz] = SPLAT[kind.id];
        this.p.set(d[o], d[o + 1], d[o + 2]).addScaledVector(this.n, 0.015);
        this.m.compose(this.p, this.gq, this.gs.set(sx * sc, 1, sz * sc));
        const splat = this.splats.alloc(this.m);
        c.slots.push({ kind, slot, splat, id, source: i, x: d[o], z: d[o + 2] });
      }
    }
    this.chunks.set(key, c);
    // If a pool grew it now has a new mesh, so the owner maps must be rebuilt; otherwise just add ours.
    if ([...this.pools.values()].some((p, i) => p.mesh !== meshesBefore[i])) this.rebuildOwners();
    else for (const e of c.slots) this.ownerMap(e.kind).set(e.slot, { key, id: e.id });
  }

  /** Owner lookup is keyed by the current pool meshes (which change when a pool grows). */
  private rebuildOwners() {
    this.owners.clear();
    for (const [key, c] of this.chunks) for (const e of c.slots) this.ownerMap(e.kind).set(e.slot, { key, id: e.id });
  }

  /** Removes props already placed on ground that's now blocked (the wreck settled after they loaded). */
  clearBlocked() {
    if (!this.blocked) return;
    for (const c of this.chunks.values()) c.slots = c.slots.filter((e) => {
      if (!this.blocked!(e.x, e.z)) return true;
      this.releaseEntry(e);
      return false;
    });
  }

  /** After digging or filling: props whose ground changed disappear (not marked as picked). */
  private applyValidity(_key: string, c: ChunkProps, deco: DecoData) {
    c.slots = c.slots.filter((e) => {
      if (deco[e.kind.id][e.source * STRIDE + 8]) return true;
      this.releaseEntry(e);
      return false;
    });
  }

  /** What prop (if any) the camera is looking at within reach. */
  lookAt(camera: THREE.Camera, reach: number): { kind: ItemId; mesh: THREE.InstancedMesh; index: number; id: string; dist: number } | null {
    for (const pool of this.pools.values()) pool.prepareRaycast();
    this.ray.setFromCamera(this.centre, camera);
    this.ray.far = reach;
    const hit = this.ray.intersectObjects([...this.pools.values()].map((p) => p.mesh), false)[0];
    if (!hit || hit.instanceId === undefined) return null;
    const mesh = hit.object as THREE.InstancedMesh;
    const owner = this.owners.get(mesh)?.get(hit.instanceId);
    if (!owner) return null;
    return { kind: mesh.userData.kind as ItemId, mesh, index: hit.instanceId, id: owner.id, dist: hit.distance };
  }

  pick(target: { mesh: THREE.InstancedMesh; index: number; id: string }) {
    this.picked.add(target.id);
    const owner = this.owners.get(target.mesh)?.get(target.index);
    if (!owner) return;
    const c = this.chunks.get(owner.key);
    const kind = KINDS.find((k) => k.id === target.mesh.userData.kind)!;
    const e = c?.slots.find((x) => x.kind === kind && x.slot === target.index);
    if (c && e) { c.slots = c.slots.filter((x) => x !== e); this.releaseEntry(e); }
    else { this.ownerMap(kind).delete(target.index); this.pools.get(kind.id)!.release(target.index); }
  }

  /** Live prop count (debug overlay). */
  get count() { let n = 0; for (const p of this.pools.values()) n += p.size; return n; }
}
