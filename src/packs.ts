// Packs: what you were carrying when you froze, left where you fell. Walk up to one and press E to take it back.
import * as THREE from 'three';
import type { PackSave } from './save';

export interface Pack { position: THREE.Vector3; items: Record<string, number>; group: THREE.Group;
  /** Age in seconds of each piece of meat in it (so a death can't refresh rotting meat). */
  ages?: Record<string, number[]>;
  /** When you died and dropped it (ms since epoch); overflow packs have none. The compass leads to the latest. */
  died?: number }

let sackGeo: THREE.BufferGeometry = new THREE.DodecahedronGeometry(0.28, 0).scale(1, 0.75, 0.85);
const strapGeo = new THREE.TorusGeometry(0.2, 0.025, 4, 10);
let sackMat: THREE.Material = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.7, flatShading: true }); // suit fabric
let modelled = false;
const glowMat = new THREE.MeshBasicMaterial({ color: 0xe07a2f }); // hazard orange: visible at night
const beaconGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.4, 4).translate(0, 0.9, 0);
const beaconMat = new THREE.MeshBasicMaterial({ color: 0xe07a2f, transparent: true, opacity: 0.55, depthWrite: false });

const MAX_PACKS = 20;

export class Packs {
  readonly group = new THREE.Group();
  readonly list: Pack[] = [];
  private t = 0;

  /** Use the Blender-built pack (soft suit-fabric bag with a hazard stripe) once loaded. */
  setLook(m: { geometry: THREE.BufferGeometry; material: THREE.Material } | undefined) {
    if (!m) return;
    sackGeo = m.geometry; sackMat = m.material; modelled = true;
    for (const p of this.list) { const s = p.group.children[0] as THREE.Mesh; s.geometry = sackGeo; s.material = sackMat; s.position.y = 0; p.group.children[1].visible = false; }
  }

  add(position: THREE.Vector3, items: Record<string, number>, ages?: Record<string, number[]>, died?: number) {
    // Repeated deaths can't pile up packs forever: past the cap, the oldest pack's contents move into the new one
    // (nothing is lost, it just isn't where it was).
    items = { ...items };
    ages = Object.fromEntries(Object.entries(ages ?? {}).map(([k, a]) => [k, [...a]]));
    while (this.list.length >= MAX_PACKS) {
      const old = this.list[0];
      if (old.died && !died) died = old.died; // merged into this one: it still holds what you died with
      for (const [k, n] of Object.entries(old.items)) items[k] = (items[k] ?? 0) + n;
      for (const [k, a] of Object.entries(old.ages ?? {})) (ages[k] ??= []).push(...a);
      this.remove(old);
    }
    const g = new THREE.Group();
    g.position.copy(position);
    const sack = new THREE.Mesh(sackGeo, sackMat);
    sack.position.y = modelled ? 0 : 0.2;
    sack.receiveShadow = true;
    const strap = new THREE.Mesh(strapGeo, glowMat);
    strap.position.y = 0.22;
    strap.rotation.x = Math.PI / 2;
    const beacon = new THREE.Mesh(beaconGeo, beaconMat); // a thin light so you can find it from a distance
    strap.visible = !modelled; // the modelled pack has its own strap
    g.add(sack, strap, beacon);
    this.group.add(g);
    const p: Pack = { position: position.clone(), items: { ...items }, group: g, ages, died };
    this.list.push(p);
    return p;
  }

  remove(p: Pack) {
    this.group.remove(p.group);
    this.list.splice(this.list.indexOf(p), 1);
  }

  /** The pack within `r` metres of `pos`, nearest first. */
  near(pos: THREE.Vector3, r: number) {
    let best: Pack | null = null, bd = r * r;
    for (const p of this.list) { const d = p.position.distanceToSquared(pos); if (d < bd) { bd = d; best = p; } }
    return best;
  }

  nearest(pos: THREE.Vector3) { return this.near(pos, 1e6); }

  /** The pack from your latest death, if it's still out there. */
  latestDeath() { let best: Pack | null = null; for (const p of this.list) if (p.died && (!best || p.died > best.died!)) best = p; return best; }

  update(dt: number) {
    this.t += dt;
    beaconMat.opacity = 0.35 + 0.25 * Math.sin(this.t * 2.2);
  }

  save(): PackSave[] { return this.list.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, items: { ...p.items }, ...(p.ages && Object.keys(p.ages).length ? { ages: p.ages } : {}), ...(p.died ? { died: p.died } : {}) })); }

  load(list: PackSave[] | undefined) { for (const p of list ?? []) this.add(new THREE.Vector3(p.x, p.y, p.z), p.items, p.ages, p.died); }
}
