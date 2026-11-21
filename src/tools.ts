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

/** Where the fist closes around a handle (viewmodel space). */
const GRIP: [number, number, number] = [0, -0.09, -0.14];

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
  private raiseT = 1;      // 0 -> 1 after switching tools: the new one comes up from below
  private dipV = 0;        // landing dip
  private lag = new THREE.Vector2(); // trails the mouse a little
  private prevLook: { yaw: number; pitch: number } | null = null;
  onChange: () => void = () => {};
  /** Rest position of the held view (the modelled hand sits higher, so the glove and grip are in frame). */
  private base = new THREE.Vector3(0.26, -0.2, -0.42);

  constructor(camera: THREE.Camera) {
    camera.add(this.view);
    for (const s of SLOTS) {
      const m = buildModel(s);
      m.visible = s === this.slot;
      this.models.set(s, m);
      this.view.add(m);
    }
    this.view.position.set(0.26, -0.2, -0.42);
    this.view.scale.setScalar(0.66); // the hand camera's 60° view shows it larger than the old 75°
  }

  /**
   * Swap in the Blender viewmodels, Minecraft style: only the held tool shows, tilted across the view with its handle
   * running off the bottom-right edge (no hand or arm); bare-handed shows nothing. Tools turn about their grip point (GRIP).
   */
  setLooks(m: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>) {
    if (!m.Tool_Pick) return;
    this.base.set(0.3, -0.17, -0.38); // handle ends run off the bottom-right edge
    const make = (n: string) => { const o = new THREE.Mesh(m[n].geometry, m[n].material); o.frustumCulled = false; return o; };
    // Per tool: [mesh, tilt x (tip forward), tilt z (lean left across the view), lift].
    const tool: Record<Slot, [string, number, number, number] | null> = {
      hands: null, stone_pick: ['Tool_Pick', -0.3, 0.55, 0], stone_knife: ['Tool_Knife', -0.25, 0.55, -0.03], spear: ['Tool_Spear', 0.0, 0.18, 0.04],
    };
    for (const [slot, g] of this.models) {
      g.clear();
      const t = tool[slot];
      if (!t) continue; // bare hands: nothing in view
      if (!m[t[0]]) continue;
      const pivot = new THREE.Group(), mesh = make(t[0]);
      pivot.position.set(GRIP[0], GRIP[1] + t[3], GRIP[2]); pivot.rotation.set(t[1], 0, t[2]);
      mesh.position.set(-GRIP[0], -GRIP[1], -GRIP[2]);
      pivot.add(mesh); g.add(pivot);
    }
  }

  /** Select a slot if you own its tool. */
  select(s: Slot, owned: (id: ItemId) => boolean) {
    if (s !== 'hands' && !owned(s)) return false;
    if (s !== this.slot) this.raiseT = 0;
    this.slot = s;
    for (const [k, m] of this.models) m.visible = k === s;
    this.onChange();
    return true;
  }

  swing() { this.swingT = 0; }

  /** A heavy landing pushes the hand down for a moment (0..1). */
  dip(amount: number) { this.dipV = Math.max(this.dipV, amount * 0.08); }

  update(dt: number, moving: boolean, look?: { yaw: number; pitch: number }) {
    // Sway: the tool lags behind quick turns, then catches up.
    if (look) {
      if (this.prevLook && dt > 0) {
        const dy = look.yaw - this.prevLook.yaw, dp = look.pitch - this.prevLook.pitch;
        this.lag.x = THREE.MathUtils.clamp(this.lag.x + dy * 0.35, -0.06, 0.06);
        this.lag.y = THREE.MathUtils.clamp(this.lag.y - dp * 0.35, -0.05, 0.05);
      }
      this.prevLook = { yaw: look.yaw, pitch: look.pitch };
    }
    this.lag.multiplyScalar(Math.max(0, 1 - dt * 9));
    this.raiseT = Math.min(1, this.raiseT + dt / 0.18);
    this.dipV *= Math.max(0, 1 - dt * 8);
    const raise = 1 - (1 - this.raiseT) * (1 - this.raiseT); // ease out
    this.swingT = Math.min(1, this.swingT + dt * 3.2);
    this.bobT += dt * (moving ? 9 : 2);
    // Wind-up, a fast strike that lands at ~0.4 of the swing (about 0.12 s, when the hit registers), then recovery.
    const t = this.swingT;
    const strike = t < 0.25 ? -0.35 * Math.sin((t / 0.25) * Math.PI / 2) : t < 0.42 ? -0.35 + 1.35 * ((t - 0.25) / 0.17) : 1 - (t - 0.42) / 0.58;
    const s = t >= 1 ? 0 : strike;
    const bob = moving ? 0.012 : 0.004;
    const bx = this.base.x + Math.cos(this.bobT) * bob, by = this.base.y + Math.abs(Math.sin(this.bobT)) * bob, bz = this.base.z;
    switch (this.slot) {
      case 'spear': // straight stab
        this.view.position.set(bx, by - s * 0.02, bz - s * 0.3);
        this.view.rotation.set(s * 0.12, 0, 0);
        break;
      case 'stone_pick': // big overhead chop
        this.view.position.set(bx - s * 0.03, by + 0.05 * Math.max(0, -s) - s * 0.09, bz - s * 0.06);
        this.view.rotation.set(-s * 1.25, 0, s * 0.1);
        break;
      case 'stone_knife': // sideways slash
        this.view.position.set(bx - s * 0.16, by - s * 0.03, bz - s * 0.08);
        this.view.rotation.set(-s * 0.3, s * 0.5, s * 0.7);
        break;
      default: // hands: a short grab forward
        this.view.position.set(bx - s * 0.04, by - s * 0.04, bz - s * 0.12);
        this.view.rotation.set(-s * 0.5, 0, s * 0.15);
    }
    this.view.position.x += this.lag.x;
    this.view.position.y += this.lag.y - this.dipV - (1 - raise) * 0.3;
    this.view.rotation.z += this.lag.x * 2;
  }
}
