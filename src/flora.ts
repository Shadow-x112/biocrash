// Fungal forest flora: giant mushrooms you can harvest for stalkwood, glowing sprouts, and drifting
// spores at night. Placement comes from the worker's decoration pass (unedited terrain, seeded per chunk).
import * as THREE from 'three';
import { addSway } from './fx';
import type RAPIER from '@dimforge/rapier3d';
import { STRIDE, type DecoData } from './terrain/deco';
import { InstancePool } from './pool';

export const STALK_HARVESTS = 4;   // uses per mushroom
export const STALK_YIELD = 2;      // stalkwood per use
const SPOTS_PER = 7;

interface Shroom {
  id: string; source: number; kind: 'giant' | 'small';
  base: THREE.Vector3; radius: number; height: number;
  collider: RAPIER.Collider | null;
  slots: { stalk: number; gill: number; cap: number; spots: number[] };
  alive: boolean;
}
interface ChunkFlora {
  shrooms: Shroom[];
  sprouts: { slot: number; source: number }[];
}

const STALK = new THREE.MeshStandardMaterial({ color: 0xd8ccb4, roughness: 0.9, flatShading: true });
const GILLS = new THREE.MeshStandardMaterial({ color: 0x8c6f86, roughness: 1, flatShading: true, side: THREE.DoubleSide });
const SPOTS = new THREE.MeshStandardMaterial({ color: 0x20302c, emissive: 0x6ff0d8, emissiveIntensity: 0.3, flatShading: true });
const SPROUT = new THREE.MeshStandardMaterial({ color: 0x24403a, emissive: 0x7affd6, emissiveIntensity: 0.3, flatShading: true });
const CAP = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.75, flatShading: true }); // tinted per instance
// Caps, gills and their glowing spots sway together (same world-space motion); sprouts bend from the base.
for (const m of [CAP, GILLS, SPOTS]) addSway(m, 0.06);
addSway(SPROUT, 0.1, true);
const CAP_COLORS = [0x9a5a8c, 0x6f63a8, 0xb06a5a, 0x5f8f8a].map((c) => new THREE.Color(c));

// Unit geometries, scaled per instance: 1 m tall stalk, 1 m radius cap.
const stalkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 9, 3).translate(0, 0.5, 0);
const capGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
capGeo.scale(1, 0.55, 1);
const gillGeo = new THREE.CircleGeometry(0.93, 14).rotateX(Math.PI / 2);
const spotGeo = new THREE.IcosahedronGeometry(0.09, 0);
const sproutGeo = (() => {
  const parts = [new THREE.ConeGeometry(0.05, 0.35, 5).translate(0, 0.17, 0), new THREE.SphereGeometry(0.06, 6, 4).translate(0, 0.37, 0)];
  const pos: number[] = [], nrm: number[] = [];
  for (const p of parts) {
    const g = p.toNonIndexed();
    pos.push(...(g.getAttribute('position').array as Float32Array)); nrm.push(...(g.getAttribute('normal').array as Float32Array));
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  return out;
})();

export class Flora {
  readonly group = new THREE.Group();
  /** How many times each mushroom has been harvested (saved). */
  readonly harvested = new Map<string, number>();
  private chunks = new Map<string, ChunkFlora>();
  private stalks: InstancePool;
  private gills: InstancePool;
  private caps: InstancePool;
  private spots: InstancePool;
  private sprouts: InstancePool;
  private spores: THREE.Points;
  private sporeVel: Float32Array;
  // Scratch objects for look-ups (no per-call allocation).
  private ray = new THREE.Ray();
  private sphere = new THREE.Sphere();
  private hit = new THREE.Vector3();
  private origin = new THREE.Vector3();
  private dir = new THREE.Vector3();

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World, private avoid: THREE.Vector3) {
    this.stalks = new InstancePool(stalkGeo, STALK, this.group, 1024);
    this.gills = new InstancePool(gillGeo, GILLS, this.group, 1024);
    this.caps = new InstancePool(capGeo, CAP, this.group, 1024, true);
    this.spots = new InstancePool(spotGeo, SPOTS, this.group, 1024 * SPOTS_PER);
    this.sprouts = new InstancePool(sproutGeo, SPROUT, this.group, 4096);
    const n = 260;
    const pos = new Float32Array(n * 3);
    this.sporeVel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([(Math.random() - 0.5) * 40, Math.random() * 10, (Math.random() - 0.5) * 40], i * 3);
      this.sporeVel.set([(Math.random() - 0.5) * 0.3, 0.05 + Math.random() * 0.15, (Math.random() - 0.5) * 0.3], i * 3);
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    this.spores = new THREE.Points(g, new THREE.PointsMaterial({
      color: 0x9fffe6, size: 0.09, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending,
    }));
    this.spores.frustumCulled = false;
    this.group.add(this.spores);
  }

  onChunkMesh(key: string, deco: DecoData) {
    const c = this.chunks.get(key);
    if (c) this.applyValidity(c, deco);
    else this.spawn(key, deco);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const s of c.shrooms) this.removeShroom(s);
    for (const sp of c.sprouts) this.sprouts.release(sp.slot);
    this.chunks.delete(key);
  }

  private spawn(key: string, deco: DecoData) {
    const c: ChunkFlora = { shrooms: [], sprouts: [] };
    type Placed = { p: THREE.Vector3; h: number; r: number; cap: number; tilt: number; spin: number; color: number; id: string; source: number; kind: 'giant' | 'small' };
    const placed: Placed[] = [];
    for (const kind of ['giant', 'small'] as const) {
      const d = deco[kind];
      const [hMin, hMax] = kind === 'giant' ? [7, 15] : [1.2, 3.5];
      for (let i = 0; i < d.length / STRIDE; i++) {
        const o = i * STRIDE;
        if (!d[o + 8]) continue;
        const p = new THREE.Vector3(d[o], d[o + 1], d[o + 2]);
        if (Math.hypot(p.x - this.avoid.x, p.z - this.avoid.z) < 9) continue; // keep the crash site clear
        const h = hMin + d[o + 4] * (hMax - hMin);
        const capR = h * (kind === 'giant' ? 0.42 : 0.5);
        if (placed.some((q) => q.p.distanceTo(p) < (q.cap + capR) * 0.8)) continue; // no overlapping caps
        placed.push({ p, h, r: h * (kind === 'giant' ? 0.06 : 0.09), cap: capR, tilt: (d[o + 5] - 0.5) * 0.25,
          spin: d[o + 6] * Math.PI * 2, color: Math.floor(d[o + 7] * CAP_COLORS.length) % CAP_COLORS.length, id: `${key}:${kind}:${i}`, source: i, kind });
      }
    }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), v = new THREE.Vector3(), local = new THREE.Vector3(), topP = new THREE.Vector3();
    for (const o of placed) {
      e.set(o.tilt, o.spin, o.tilt * 0.6);
      q.setFromEuler(e);
      m.compose(v.copy(o.p).setY(o.p.y - 0.3), q, sc.set(o.r, o.h + 0.3, o.r));
      const stalk = this.stalks.alloc(m);
      topP.set(0, o.h, 0).applyQuaternion(q).add(o.p);
      m.compose(topP, q, sc.setScalar(o.cap));
      const cap = this.caps.alloc(m, CAP_COLORS[o.color]);
      m.compose(v.copy(topP).setY(topP.y + 0.02), q, sc.setScalar(o.cap));
      const gill = this.gills.alloc(m);
      const spots: number[] = [];
      for (let k = 0; k < SPOTS_PER; k++) {
        const a = k * 2.4 + o.spin, rr = 0.35 + (k % 3) * 0.2;
        local.set(Math.cos(a) * rr, Math.sqrt(Math.max(0, 1 - rr * rr)) * 0.55, Math.sin(a) * rr).multiplyScalar(o.cap);
        m.compose(local.applyQuaternion(q).add(topP), q, sc.setScalar(o.cap * 0.9));
        spots.push(this.spots.alloc(m));
      }
      const collider = o.h > 5
        ? this.physics.createCollider(this.rapier.ColliderDesc.cylinder(o.h / 2, o.r * 0.85).setTranslation(o.p.x, o.p.y + o.h / 2, o.p.z))
        : null;
      c.shrooms.push({ id: o.id, source: o.source, kind: o.kind, base: o.p, radius: o.r, height: o.h, collider, slots: { stalk, gill, cap, spots }, alive: true });
    }

    // Glowing sprouts.
    const sd = deco.sprout;
    const up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3();
    for (let i = 0; i < sd.length / STRIDE; i++) {
      const o = i * STRIDE;
      if (!sd[o + 8]) continue;
      m.compose(p.set(sd[o], sd[o + 1], sd[o + 2]), q.setFromAxisAngle(up, sd[o + 5] * 6.28), sc.setScalar(0.6 + sd[o + 4] * 0.9));
      c.sprouts.push({ slot: this.sprouts.alloc(m), source: i });
    }
    this.chunks.set(key, c);
  }

  private removeShroom(s: Shroom) {
    if (!s.alive) return;
    s.alive = false;
    if (s.collider) { this.physics.removeCollider(s.collider, false); s.collider = null; }
    this.stalks.release(s.slots.stalk);
    this.gills.release(s.slots.gill);
    this.caps.release(s.slots.cap);
    for (const sp of s.slots.spots) this.spots.release(sp);
  }

  /** After digging or filling: mushrooms and sprouts whose ground changed are removed (with their colliders). */
  private applyValidity(c: ChunkFlora, deco: DecoData) {
    for (const s of c.shrooms) if (s.alive && !deco[s.kind][s.source * STRIDE + 8]) this.removeShroom(s);
    c.sprouts = c.sprouts.filter((sp) => {
      if (deco.sprout[sp.source * STRIDE + 8]) return true;
      this.sprouts.release(sp.slot);
      return false;
    });
  }

  /** The mushroom stalk the camera faces within reach (for harvesting stalkwood). */
  lookAt(camera: THREE.Camera, reach: number): Shroom | null {
    camera.getWorldPosition(this.origin);
    camera.getWorldDirection(this.dir);
    this.ray.set(this.origin, this.dir);
    let best: Shroom | null = null, bestT = reach;
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      if (!s.alive) continue;
      const dx = s.base.x - this.origin.x, dz = s.base.z - this.origin.z;
      if (dx * dx + dz * dz > (reach + 2) * (reach + 2)) continue; // cheap reject
      // Approximate the stalk as a sphere at eye height, clamped to the stalk's length.
      this.sphere.center.set(s.base.x, Math.min(Math.max(this.origin.y, s.base.y + 0.3), s.base.y + s.height * 0.8), s.base.z);
      this.sphere.radius = s.radius + 0.15;
      if (this.ray.intersectSphere(this.sphere, this.hit)) {
        const t = this.hit.distanceTo(this.origin);
        if (t < bestT) { bestT = t; best = s; }
      }
    }
    return best;
  }

  usesLeft(s: Shroom) { return STALK_HARVESTS - (this.harvested.get(s.id) ?? 0); }

  harvest(s: Shroom) {
    if (this.usesLeft(s) <= 0) return 0;
    this.harvested.set(s.id, (this.harvested.get(s.id) ?? 0) + 1);
    return STALK_YIELD;
  }

  update(dt: number, viewer: THREE.Vector3, night: number) {
    const glow = 0.25 + night * 1.9;
    SPOTS.emissiveIntensity = glow;
    SPROUT.emissiveIntensity = glow * 1.1;
    const pos = this.spores.geometry.getAttribute('position') as THREE.BufferAttribute;
    if (night > 0.02) {
      const a = pos.array as Float32Array;
      for (let i = 0; i < a.length; i += 3) {
        a[i] += this.sporeVel[i] * dt; a[i + 1] += this.sporeVel[i + 1] * dt; a[i + 2] += this.sporeVel[i + 2] * dt;
        if (a[i + 1] > 10) a[i + 1] = 0;
        if (a[i] > 20) a[i] -= 40; else if (a[i] < -20) a[i] += 40;
        if (a[i + 2] > 20) a[i + 2] -= 40; else if (a[i + 2] < -20) a[i + 2] += 40;
      }
      pos.needsUpdate = true;
    }
    this.spores.position.set(viewer.x, viewer.y - 3, viewer.z);
    (this.spores.material as THREE.PointsMaterial).opacity = night * 0.9;
  }
}
