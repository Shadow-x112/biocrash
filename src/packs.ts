// Packs: what you were carrying when you froze, left where you fell. Walk up to one and press E to take it back.
import * as THREE from 'three';
import type { PackSave } from './save';

export interface Pack { position: THREE.Vector3; items: Record<string, number>; group: THREE.Group }

const sackGeo = new THREE.DodecahedronGeometry(0.28, 0).scale(1, 0.75, 0.85);
const strapGeo = new THREE.TorusGeometry(0.2, 0.025, 4, 10);
const sackMat = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.7, flatShading: true }); // suit fabric
const glowMat = new THREE.MeshBasicMaterial({ color: 0xe07a2f }); // hazard orange: visible at night
const beaconGeo = new THREE.CylinderGeometry(0.015, 0.015, 1.4, 4).translate(0, 0.9, 0);
const beaconMat = new THREE.MeshBasicMaterial({ color: 0xe07a2f, transparent: true, opacity: 0.55, depthWrite: false });

export class Packs {
  readonly group = new THREE.Group();
  readonly list: Pack[] = [];
  private t = 0;

  add(position: THREE.Vector3, items: Record<string, number>) {
    const g = new THREE.Group();
    g.position.copy(position);
    const sack = new THREE.Mesh(sackGeo, sackMat);
    sack.position.y = 0.2;
    const strap = new THREE.Mesh(strapGeo, glowMat);
    strap.position.y = 0.22;
    strap.rotation.x = Math.PI / 2;
    const beacon = new THREE.Mesh(beaconGeo, beaconMat); // a thin light so you can find it from a distance
    g.add(sack, strap, beacon);
    this.group.add(g);
    const p = { position: position.clone(), items: { ...items }, group: g };
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

  update(dt: number) {
    this.t += dt;
    beaconMat.opacity = 0.35 + 0.25 * Math.sin(this.t * 2.2);
  }

  save(): PackSave[] { return this.list.map((p) => ({ x: p.position.x, y: p.position.y, z: p.position.z, items: { ...p.items } })); }

  load(list: PackSave[] | undefined) { for (const p of list ?? []) this.add(new THREE.Vector3(p.x, p.y, p.z), p.items); }
}
