// Fungal forest flora: giant mushrooms you can harvest for stalkwood, glowing sprouts, and drifting
// spores at night. Placement comes from the worker's decoration pass (unedited terrain, seeded per chunk).
import * as THREE from 'three';
import { addSway, addRim } from './fx';
import type RAPIER from '@dimforge/rapier3d';
import { STRIDE, type DecoData } from './terrain/deco';
import { InstancePool } from './pool';

const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);
export const STALK_HARVESTS = 4;   // uses per mushroom
export const STALK_YIELD = 2;      // stalkwood per use
const SPOTS_PER = 7;

interface Shroom {
  id: string; source: number; kind: 'giant' | 'small';
  base: THREE.Vector3; radius: number; height: number;
  colliders: RAPIER.Collider[];
  slots: { stalk: number; gill: number; cap: number; spots: number[] };
  alive: boolean;
  /** Placement, kept so harvesting can rebuild the instances (shorter stalk, toppled at the end). */
  q: THREE.Quaternion; capR: number; color: number; spin: number;
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
addRim(STALK);
addSway(SPROUT, 0.1, true);
const CAP_COLORS = [0x9a5a8c, 0x6f63a8, 0xb06a5a, 0x5f8f8a].map((c) => new THREE.Color(c));

// Unit geometries, scaled per instance: 1 m tall stalk, 1 m radius cap.
const stalkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 9, 3).translate(0, 0.5, 0);
const capGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
capGeo.scale(1, 0.55, 1);
// The dome's rim sits CAP_RIM above its centre: lower it so the rim meets the gills (it used to float ~0.7 m above them).
const CAP_RIM = Math.cos(Math.PI * 0.42) * 0.55;
capGeo.translate(0, -CAP_RIM, 0);
// Unit cap outline for its physics shape (a convex hull, scaled per mushroom): the cap is solid, you can stand on it.
const CAP_HULL = (() => {
  const p = capGeo.getAttribute('position'), seen = new Set<string>(), out: number[] = [];
  for (let i = 0; i < p.count; i++) {
    const k = `${p.getX(i).toFixed(3)},${p.getY(i).toFixed(3)},${p.getZ(i).toFixed(3)}`;
    if (!seen.has(k)) { seen.add(k); out.push(p.getX(i), p.getY(i), p.getZ(i)); }
  }
  return out;
})();
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
    this.stalks = new InstancePool(stalkGeo, STALK, this.group, 1024, false, true);
    this.gills = new InstancePool(gillGeo, GILLS, this.group, 1024);
    this.caps = new InstancePool(capGeo, CAP, this.group, 1024, true, true);
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
        local.set(Math.cos(a) * rr, Math.sqrt(Math.max(0, 1 - rr * rr)) * 0.55 - CAP_RIM, Math.sin(a) * rr).multiplyScalar(o.cap);
        m.compose(local.applyQuaternion(q).add(topP), q, sc.setScalar(o.cap * 0.9));
        spots.push(this.spots.alloc(m));
      }
      const s: Shroom = { id: o.id, source: o.source, kind: o.kind, base: o.p, radius: o.r, height: o.h, colliders: [], slots: { stalk, gill, cap, spots }, alive: true,
        q: q.clone(), capR: o.cap, color: o.color, spin: o.spin };
      c.shrooms.push(s);
      if (this.harvested.get(s.id)) this.shape(s); // already cut: rebuild its harvested state
      else this.solid(s, o.h, null);
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
    this.clearColliders(s);
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
      if (!s.alive || this.usesLeft(s) <= 0) continue; // toppled stalks lie on the ground: nothing left to cut
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
    this.shape(s);
    return STALK_YIELD;
  }

  /** True once a mushroom has been cut all the way down (it lies toppled). */
  toppled(s: Shroom) { return this.usesLeft(s) <= 0; }

  /** Rebuilds a mushroom's instances for how often it's been cut: each cut takes ~18% off the stalk (the cap sinks
   *  with it); the last one topples it: the stalk lies on the ground, the cap is gone. */
  private clearColliders(s: Shroom) {
    for (const c of s.colliders) this.physics.removeCollider(c, false);
    s.colliders = [];
  }

  /** Physics for a mushroom as it currently looks: every stalk (giant or small) and every cap is solid. Standing:
   *  a tilted cylinder for the stalk plus the cap's convex hull. Toppled (`fall` set): the stalk lying on the ground. */
  private solid(s: Shroom, h: number, fall: THREE.Quaternion | null) {
    this.clearColliders(s);
    const R = this.rapier, c = new THREE.Vector3();
    if (fall) {
      c.set(0, h / 2, 0).applyQuaternion(fall).add(s.base).setY(c.y + s.radius * 0.8);
      s.colliders.push(this.physics.createCollider(R.ColliderDesc.cylinder(h / 2, s.radius * 0.85)
        .setTranslation(c.x, c.y, c.z).setRotation(fall)));
      return;
    }
    const len = h + 0.3;
    c.set(0, len / 2, 0).applyQuaternion(s.q).add(s.base).setY(c.y - 0.3);
    s.colliders.push(this.physics.createCollider(R.ColliderDesc.cylinder(len / 2, s.radius * 0.85)
      .setTranslation(c.x, c.y, c.z).setRotation(s.q)));
    const top = c.set(0, h, 0).applyQuaternion(s.q).add(s.base);
    const pts = new Float32Array(CAP_HULL.length);
    for (let i = 0; i < pts.length; i++) pts[i] = CAP_HULL[i] * s.capR;
    const hull = R.ColliderDesc.convexHull(pts);
    if (hull) s.colliders.push(this.physics.createCollider(hull.setTranslation(top.x, top.y, top.z).setRotation(s.q)));
  }

  private shape(s: Shroom) {
    const n = Math.min(STALK_HARVESTS, this.harvested.get(s.id) ?? 0);
    const m = new THREE.Matrix4(), v = new THREE.Vector3(), sc = new THREE.Vector3(), top = new THREE.Vector3(), local = new THREE.Vector3();
    if (n >= STALK_HARVESTS) {
      // Toppled: the stalk falls over along its spin direction; cap, gills and spots are gone; no collider.
      const fall = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(s.spin), 0, Math.sin(s.spin)), Math.PI / 2 - 0.08);
      const len = s.height * 0.35;
      m.compose(v.copy(s.base).setY(s.base.y + s.radius * 0.8), fall, sc.set(s.radius, len, s.radius));
      this.stalks.set(s.slots.stalk, m);
      this.caps.set(s.slots.cap, ZERO); this.gills.set(s.slots.gill, ZERO);
      for (const sp of s.slots.spots) this.spots.set(sp, ZERO);
      this.solid(s, len, fall);
      return;
    }
    const h = s.height * (1 - 0.18 * n);
    m.compose(v.copy(s.base).setY(s.base.y - 0.3), s.q, sc.set(s.radius, h + 0.3, s.radius));
    this.solid(s, h, null);
    this.stalks.set(s.slots.stalk, m);
    top.set(0, h, 0).applyQuaternion(s.q).add(s.base);
    m.compose(top, s.q, sc.setScalar(s.capR));
    this.caps.set(s.slots.cap, m);
    m.compose(v.copy(top).setY(top.y + 0.02), s.q, sc.setScalar(s.capR));
    this.gills.set(s.slots.gill, m);
    s.slots.spots.forEach((sp, k) => {
      const a = k * 2.4 + s.spin, rr = 0.35 + (k % 3) * 0.2;
      local.set(Math.cos(a) * rr, Math.sqrt(Math.max(0, 1 - rr * rr)) * 0.55 - CAP_RIM, Math.sin(a) * rr).multiplyScalar(s.capR);
      m.compose(local.applyQuaternion(s.q).add(top), s.q, sc.setScalar(s.capR * 0.9));
      this.spots.set(sp, m);
    });
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
