// Storage crates: lashed stalkwood boxes under a hull-plate lid, placed at camp. Each holds 16 slots, and meat kept in
// one spoils at half speed (out of the damp and the warmth of your suit).
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d';
import { Inventory, PERISHABLE } from './inventory';

export const CRATE_COST = { stalkwood: 6, cordage: 3, stone: 2 } as const;
export const CRATE_SLOTS = 16;
export const MAX_CRATES = 30;
const HALF = new THREE.Vector3(0.47, 0.3, 0.32); // collider half-extents

export interface CrateSave { x: number; y: number; z: number; rot: number; items: Record<string, number>; fresh?: Record<string, number[]>; wear?: Record<string, number> }
type Look = { geometry: THREE.BufferGeometry; material: THREE.Material };

export interface Crate { position: THREE.Vector3; rot: number; inv: Inventory; group: THREE.Group; body: RAPIER.RigidBody }

// Until the Blender model loads: a plain box with a darker lid.
let woodGeo: THREE.BufferGeometry = new THREE.BoxGeometry(0.92, 0.56, 0.62).translate(0, 0.28, 0);
let lidGeo: THREE.BufferGeometry = new THREE.BoxGeometry(0.98, 0.04, 0.7).translate(0, 0.58, 0);
let woodMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x2a2228, roughness: 0.85 });
let lidMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0x3a3d42, roughness: 0.5, metalness: 0.6 });

export class Crates {
  readonly group = new THREE.Group();
  readonly list: Crate[] = [];
  private ray = new THREE.Raycaster();
  private centre = new THREE.Vector2();

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World) {}

  setLooks(m: Record<string, Look>) {
    if (!m.Crate_Wood || !m.Crate_Lid) return;
    woodGeo = m.Crate_Wood.geometry; woodMat = m.Crate_Wood.material; lidGeo = m.Crate_Lid.geometry; lidMat = m.Crate_Lid.material;
    for (const c of this.list) {
      const [w, l] = c.group.children as THREE.Mesh[];
      w.geometry = woodGeo; w.material = woodMat; l.geometry = lidGeo; l.material = lidMat;
    }
  }

  add(position: THREE.Vector3, rot: number, items?: Record<string, number>, fresh?: Record<string, number[]>, wear?: Record<string, number>) {
    const g = new THREE.Group();
    g.position.copy(position); g.rotation.y = rot;
    const w = new THREE.Mesh(woodGeo, woodMat), l = new THREE.Mesh(lidGeo, lidMat);
    w.castShadow = l.castShadow = true;
    g.add(w, l);
    this.group.add(g);
    const R = this.rapier;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
    const body = this.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(position.x, position.y, position.z).setRotation(q));
    this.physics.createCollider(R.ColliderDesc.cuboid(HALF.x, HALF.y, HALF.z).setTranslation(0, HALF.y, 0), body);
    const inv = new Inventory(CRATE_SLOTS);
    inv.load(items ?? {}, fresh, [], wear);
    const c: Crate = { position: position.clone(), rot, inv, group: g, body };
    this.list.push(c);
    return c;
  }

  remove(c: Crate) {
    const i = this.list.indexOf(c);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.group.remove(c.group);
    this.physics.removeRigidBody(c.body);
  }

  /** The crate under the crosshair within `reach`, if any. */
  lookAt(camera: THREE.Camera, reach: number) {
    const near = this.list.filter((c) => c.position.distanceToSquared(camera.position) < (reach + 2) ** 2);
    if (!near.length) return null;
    this.ray.setFromCamera(this.centre, camera);
    this.ray.far = reach;
    const hits = this.ray.intersectObjects(near.map((c) => c.group), true);
    if (!hits.length) return null;
    return this.list.find((c) => hits[0].object.parent === c.group) ?? null;
  }

  /** Meat in crates keeps twice as long. */
  update(dt: number) { for (const c of this.list) c.inv.tick(dt * 0.5); }

  makePreview() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.4, depthWrite: false });
    const group = new THREE.Group();
    const w = new THREE.Mesh(woodGeo, mat), l = new THREE.Mesh(lidGeo, mat);
    group.add(w, l);
    group.visible = false;
    return {
      group,
      setOk: (ok: boolean) => mat.color.setHex(ok ? 0x7dff9a : 0xff6a50),
      /** Picks up the Blender model once it has loaded. */
      refresh: () => { w.geometry = woodGeo; l.geometry = lidGeo; },
    };
  }

  save(): CrateSave[] {
    return this.list.map((c) => ({
      x: c.position.x, y: c.position.y, z: c.position.z, rot: c.rot,
      items: Object.fromEntries(Object.entries(c.inv.counts).filter(([, n]) => n > 0)),
      fresh: Object.fromEntries(PERISHABLE.map((k) => [k, [...c.inv.ages[k]]])),
      wear: Object.fromEntries(Object.entries(c.inv.wear).filter(([, n]) => n)) as Record<string, number>,
    }));
  }

  load(list: CrateSave[] | undefined) {
    for (const s of list ?? []) this.add(new THREE.Vector3(s.x, s.y, s.z), s.rot, s.items, s.fresh, s.wear);
  }
}
