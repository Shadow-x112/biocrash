// The hotbar and the first-person view of whatever you hold, with a simple swing animation.
import * as THREE from 'three';
import type { ItemId } from './inventory';

export type Slot = 'hands' | 'stone_pick' | 'stone_knife' | 'spear';
export const SLOTS: Slot[] = ['hands', 'stone_pick', 'stone_knife', 'spear'];
export const SLOT_NAMES: Record<Slot, string> = { hands: 'Hands', stone_pick: 'Stone pick', stone_knife: 'Stone knife', spear: 'Spear' };

/** How hard each slot digs (density per stroke) and how wide. */
export const DIG_POWER: Record<Slot, { strength: number; radius: number; interval: number }> = {
  hands: { strength: 1.1, radius: 1.5, interval: 0.25 },
  stone_pick: { strength: 3.2, radius: 2.2, interval: 0.12 },
  stone_knife: { strength: 0.8, radius: 1.3, interval: 0.25 },
  spear: { strength: 0.8, radius: 1.3, interval: 0.25 },
};

const wood = new THREE.MeshStandardMaterial({ color: 0xcdbfa3, roughness: 0.9, flatShading: true });
const rock = new THREE.MeshStandardMaterial({ color: 0x8a857c, roughness: 1, flatShading: true });
const cord = new THREE.MeshStandardMaterial({ color: 0x8aa46f, roughness: 1, flatShading: true });
const skin = new THREE.MeshStandardMaterial({ color: 0x4d535b, roughness: 0.85 }); // suit glove
const suit = new THREE.MeshStandardMaterial({ color: 0xe6e8ea, roughness: 0.6 });
const hazard = new THREE.MeshStandardMaterial({ color: 0xe07a2f, roughness: 0.6 });

function mesh(g: THREE.BufferGeometry, m: THREE.Material, x = 0, y = 0, z = 0) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  return o;
}

function buildModel(slot: Slot) {
  const g = new THREE.Group();
  // A suited forearm and glove are always visible: the survivor's own hand.
  const arm = mesh(new THREE.CylinderGeometry(0.045, 0.055, 0.42, 8), suit, 0, -0.2, 0.08);
  arm.rotation.x = 1.25;
  const band = mesh(new THREE.CylinderGeometry(0.057, 0.057, 0.04, 8), hazard, 0, -0.13, -0.04);
  band.rotation.x = 1.25;
  const hand = mesh(new THREE.BoxGeometry(0.08, 0.06, 0.1), skin, 0, -0.1, -0.12);
  g.add(arm, band, hand);
  if (slot === 'stone_pick') {
    g.add(mesh(new THREE.CylinderGeometry(0.015, 0.018, 0.5, 6), wood, 0, 0.1, -0.14));
    const head = mesh(new THREE.ConeGeometry(0.035, 0.26, 5), rock, 0.06, 0.33, -0.14);
    head.rotation.z = -Math.PI / 2;
    g.add(head, mesh(new THREE.TorusGeometry(0.024, 0.008, 4, 8), cord, 0, 0.31, -0.14));
  } else if (slot === 'stone_knife') {
    g.add(mesh(new THREE.CylinderGeometry(0.016, 0.016, 0.12, 6), wood, 0, -0.02, -0.14));
    const blade = mesh(new THREE.ConeGeometry(0.03, 0.2, 4), rock, 0, 0.13, -0.14);
    blade.scale.z = 0.35;
    g.add(blade, mesh(new THREE.TorusGeometry(0.02, 0.006, 4, 8), cord, 0, 0.03, -0.14));
  } else if (slot === 'spear') {
    const shaft = mesh(new THREE.CylinderGeometry(0.014, 0.016, 1.5, 6), wood, 0, 0.0, -0.14);
    shaft.rotation.x = -Math.PI / 2 + 0.25;
    const tip = mesh(new THREE.ConeGeometry(0.03, 0.16, 4), rock, 0, 0.18, -0.86);
    tip.rotation.x = -Math.PI / 2 + 0.25;
    g.add(shaft, tip);
  }
  return g;
}

export class Hotbar {
  slot: Slot = 'hands';
  readonly view = new THREE.Group();
  private models = new Map<Slot, THREE.Group>();
  private swingT = 1;
  private bobT = 0;
  onChange: () => void = () => {};

  constructor(camera: THREE.Camera) {
    camera.add(this.view);
    for (const s of SLOTS) {
      const m = buildModel(s);
      m.visible = s === this.slot;
      this.models.set(s, m);
      this.view.add(m);
    }
    this.view.position.set(0.26, -0.2, -0.42);
    this.view.scale.setScalar(0.8);
  }

  /** Select a slot if you own its tool. */
  select(s: Slot, owned: (id: ItemId) => boolean) {
    if (s !== 'hands' && !owned(s)) return false;
    this.slot = s;
    for (const [k, m] of this.models) m.visible = k === s;
    this.onChange();
    return true;
  }

  swing() { this.swingT = 0; }

  update(dt: number, moving: boolean) {
    this.swingT = Math.min(1, this.swingT + dt * 3.2);
    this.bobT += dt * (moving ? 9 : 2);
    const swing = Math.sin(this.swingT * Math.PI);
    const bob = moving ? 0.012 : 0.004;
    const stab = this.slot === 'spear';
    this.view.position.set(0.26 + Math.cos(this.bobT) * bob, -0.2 + Math.abs(Math.sin(this.bobT)) * bob - swing * (stab ? 0.02 : 0.06), -0.42 - swing * (stab ? 0.28 : 0.04));
    this.view.rotation.set(stab ? swing * 0.15 : -swing * 0.9, 0, stab ? 0 : swing * 0.2);
  }
}
