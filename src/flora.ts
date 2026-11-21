// Fungal forest flora: giant mushrooms you can harvest for stalkwood, glowing sprouts, and drifting
// spores at night. Placement comes from the worker's decoration pass (unedited terrain, seeded per chunk).
import * as THREE from 'three';
import { addSway, fxUniforms } from './fx';
import type RAPIER from '@dimforge/rapier3d';
import { STRIDE, type DecoData } from './terrain/deco';
import { InstancePool } from './pool';

export const STALK_HARVESTS = 4;   // uses per mushroom
export const STALK_YIELD = 2;      // stalkwood per use
const SPOTS_PER = 7;

interface Shroom {
  id: string; source: number; kind: 'giant' | 'small';
  base: THREE.Vector3; radius: number; height: number;
  body: RAPIER.RigidBody | null;
  slot: number;
  alive: boolean;
  /** Placement, kept so harvesting can rebuild the instances (shorter stalk, toppled at the end). */
  q: THREE.Quaternion; capR: number; color: number; spin: number;
}
interface ChunkFlora {
  shrooms: Shroom[];
  sprouts: { slot: number; source: number }[];
}

const SPROUT = new THREE.MeshStandardMaterial({ color: 0x24403a, emissive: 0x7affd6, emissiveIntensity: 0.3, flatShading: true });
addSway(SPROUT, 0.1, true);
const CAP_COLORS = [0x9a5a8c, 0x6f63a8, 0xb06a5a, 0x5f8f8a].map((c) => new THREE.Color(c));

// Unit geometries, scaled per instance: 1 m tall stalk, 1 m radius cap.
const capGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
capGeo.scale(1, 0.55, 1);
// The dome's rim sits CAP_RIM above its centre: lower it so the rim meets the gills (it used to float ~0.7 m above them).
const CAP_RIM = Math.cos(Math.PI * 0.42) * 0.55;
// ...and the rim's radius: the gills fill it exactly (same 14 corners), so no ring of sky shows between them.
const CAP_RIM_R = Math.sin(Math.PI * 0.42);
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

// --- One mushroom = one object -------------------------------------------------------------------
// Trunk, cap, gills and spots are merged into a single mesh, so the parts can never drift apart. Each vertex says
// which part it belongs to (aPart 0 = trunk, 1 = crown), whether it takes the mushroom's cap colour (aTint) and how
// much it glows (aGlow). Per mushroom (iDims): trunk radius, trunk length, cap radius. The shader stretches only the
// trunk and seats the crown on top of it, so cutting shortens the trunk and the cap sinks with it, still attached.
const STALK_COL = new THREE.Color(0xd8ccb4), GILL_COL = new THREE.Color(0x8c6f86), SPOT_COL = new THREE.Color(0x20302c);
const bodyGeo = (() => {
  const parts: { g: THREE.BufferGeometry; part: number; tint: number; glow: number; col: THREE.Color }[] = [
    { g: new THREE.CylinderGeometry(0.7, 1, 1, 9, 3).translate(0, 0.5, 0), part: 0, tint: 0, glow: 0, col: STALK_COL },
    { g: capGeo, part: 1, tint: 1, glow: 0, col: new THREE.Color(1, 1, 1) },
    // Gills face the ground, so no sun reaches them: a faint glow of their own colour keeps them from going black.
    { g: new THREE.CircleGeometry(CAP_RIM_R, 14).rotateX(Math.PI / 2).translate(0, 0.004, 0), part: 1, tint: 0, glow: -0.45, col: GILL_COL },
  ];
  for (let k = 0; k < SPOTS_PER; k++) {
    const a = k * 2.4, rr = 0.35 + (k % 3) * 0.2;
    parts.push({ g: new THREE.IcosahedronGeometry(0.081, 0).translate(Math.cos(a) * rr, Math.sqrt(1 - rr * rr) * 0.55 - CAP_RIM, Math.sin(a) * rr), part: 1, tint: 0, glow: 1, col: SPOT_COL });
  }
  const pos: number[] = [], nrm: number[] = [], col: number[] = [], part: number[] = [], tint: number[] = [], glow: number[] = [];
  for (const p of parts) {
    const g = p.g.index ? p.g.toNonIndexed() : p.g;
    const n = g.getAttribute('position').count;
    pos.push(...(g.getAttribute('position').array as Float32Array)); nrm.push(...(g.getAttribute('normal').array as Float32Array));
    for (let i = 0; i < n; i++) { col.push(p.col.r, p.col.g, p.col.b); part.push(p.part); tint.push(p.tint); glow.push(p.glow); }
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.Float32BufferAttribute(nrm, 3));
  out.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  out.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 1));
  out.setAttribute('aTint', new THREE.Float32BufferAttribute(tint, 1));
  out.setAttribute('aGlow', new THREE.Float32BufferAttribute(glow, 1));
  return out;
})();
// The trunk reaches this far below its base point, so on a slope its downhill side still meets the ground.
const BODY_VERT = `
  float SINK = 0.4 + iDims.x * 1.5;
  vec3 transformed = aPart < 0.5
    ? vec3(position.x * iDims.x, position.y * (iDims.y + SINK) - SINK, position.z * iDims.x)
    : position * iDims.z + vec3(0.0, iDims.y, 0.0);`;
const SWAY = `
  {
    vec3 base = (modelMatrix * vec4(instanceMatrix[3].xyz, 1.0)).xyz;
    float ph = base.x * 0.15 + base.z * 0.11, speed = mix(1.0, 0.45, uBreath);
    vec3 sway = vec3(sin(uFxTime * 0.7 * speed + ph), sin(uFxTime * 0.4 + ph * 2.0) * uBreath * 0.6, cos(uFxTime * 0.53 * speed + ph * 1.3)) * 0.07 * (1.0 + uBreath);
    sway *= clamp(transformed.y / max(iDims.y, 0.5), 0.0, 1.0); // rooted: the trunk bends, the crown moves most
    mvPosition.xyz += (viewMatrix * vec4(sway, 0.0)).xyz;
    gl_Position = projectionMatrix * mvPosition;
  }`;
const BODY = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85, flatShading: true });
const glowU = { value: 0.25 };
BODY.onBeforeCompile = (sh) => {
  Object.assign(sh.uniforms, fxUniforms, { uGlow: glowU });
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPart; attribute float aTint; attribute float aGlow; attribute vec3 iDims;\nvarying float vGlow; uniform float uFxTime; uniform float uBreath;')
    .replace('#include <begin_vertex>', BODY_VERT + '\n  vGlow = aGlow;')
    .replace('#include <color_vertex>', 'vColor = vec4(1.0); vColor.rgb = color.rgb * mix(vec3(1.0), instanceColor.rgb, aTint);')
    .replace('#include <project_vertex>', '#include <project_vertex>' + SWAY);
  sh.fragmentShader = sh.fragmentShader
    .replace('#include <common>', '#include <common>\nvarying float vGlow; uniform float uGlow; uniform vec3 uRim;')
    .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
      totalEmissiveRadiance += vGlow > 0.0 ? vec3(0.435, 0.941, 0.847) * vGlow * uGlow : diffuseColor.rgb * -vGlow;
      { float rimF = pow(1.0 - clamp(abs(dot(normalize(normal), normalize(vViewPosition))), 0.0, 1.0), 3.0);
        totalEmissiveRadiance += uRim * rimF; }`);
};
BODY.customProgramCacheKey = () => 'shroom-body';
// Shadows are drawn with a depth material: it needs the same trunk stretch, or the shadow would be a unit mushroom.
const BODY_DEPTH = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
BODY_DEPTH.onBeforeCompile = (sh) => {
  sh.vertexShader = sh.vertexShader
    .replace('#include <common>', '#include <common>\nattribute float aPart; attribute vec3 iDims;')
    .replace('#include <begin_vertex>', BODY_VERT);
};
BODY_DEPTH.customProgramCacheKey = () => 'shroom-depth';
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
  /** Ground nothing may grow on (the wreck). */
  blocked?: (x: number, z: number) => boolean;
  private chunks = new Map<string, ChunkFlora>();
  private bodies: InstancePool;
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
    this.bodies = new InstancePool(bodyGeo, BODY, this.group, 1024, true, true, { extra: { name: 'iDims', size: 3 }, depth: BODY_DEPTH });
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
        if (this.blocked?.(p.x, p.z)) continue; // not through the wreck
        const h = hMin + d[o + 4] * (hMax - hMin);
        const capR = h * (kind === 'giant' ? 0.42 : 0.5);
        if (placed.some((q) => q.p.distanceTo(p) < (q.cap + capR) * 0.8)) continue; // no overlapping caps
        placed.push({ p, h, r: h * (kind === 'giant' ? 0.06 : 0.09), cap: capR, tilt: (d[o + 5] - 0.5) * 0.25,
          spin: d[o + 6] * Math.PI * 2, color: Math.floor(d[o + 7] * CAP_COLORS.length) % CAP_COLORS.length, id: `${key}:${kind}:${i}`, source: i, kind });
      }
    }

    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), one = new THREE.Vector3(1, 1, 1);
    for (const o of placed) {
      e.set(o.tilt, o.spin, o.tilt * 0.6);
      q.setFromEuler(e);
      const slot = this.bodies.alloc(m.compose(o.p, q, one), CAP_COLORS[o.color]);
      this.bodies.setExtra(slot, o.r, o.h, o.cap);
      const s: Shroom = { id: o.id, source: o.source, kind: o.kind, base: o.p, radius: o.r, height: o.h, body: null, slot, alive: true,
        q: q.clone(), capR: o.cap, color: o.color, spin: o.spin };
      c.shrooms.push(s);
      this.shape(s); // physics, and the harvested state if it was already cut
    }

    // Glowing sprouts.
    const sd = deco.sprout;
    const up = new THREE.Vector3(0, 1, 0), p = new THREE.Vector3(), sc = new THREE.Vector3();
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
    this.clearBody(s);
    this.bodies.release(s.slot);
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
  private clearBody(s: Shroom) {
    if (s.body) { this.physics.removeRigidBody(s.body); s.body = null; }
  }

  /** One solid body per mushroom, posed like its mesh: a trunk cylinder plus the cap's convex hull (you can stand on
   *  it). Every mushroom, small ones included. */
  private solid(s: Shroom, pos: THREE.Vector3, rot: THREE.Quaternion, h: number) {
    this.clearBody(s);
    const R = this.rapier;
    const body = this.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(rot));
    const sink = 0.4 + s.radius * 1.5, len = h + sink;
    this.physics.createCollider(R.ColliderDesc.cylinder(len / 2, s.radius * 0.85).setTranslation(0, len / 2 - sink, 0), body);
    const pts = new Float32Array(CAP_HULL.length);
    for (let i = 0; i < pts.length; i++) pts[i] = CAP_HULL[i] * s.capR;
    const hull = R.ColliderDesc.convexHull(pts);
    if (hull) this.physics.createCollider(hull.setTranslation(0, h, 0), body);
    s.body = body;
  }

  /** Poses a mushroom for how often it's been cut: each cut takes ~18% off the trunk and the cap sinks with it. The
   *  last cut fells it whole, cap and all: it tips over along its spin direction until the cap rim meets the ground,
   *  leaving the trunk propped at an angle. */
  private shape(s: Shroom) {
    const n = Math.min(STALK_HARVESTS, this.harvested.get(s.id) ?? 0);
    const m = new THREE.Matrix4(), pos = s.base.clone(), one = new THREE.Vector3(1, 1, 1);
    let rot = s.q, h = s.height * (1 - 0.18 * n);
    if (n >= STALK_HARVESTS) {
      h = s.height * (1 - 0.18 * (STALK_HARVESTS - 1)); // cut at the base: the whole remaining trunk comes down
      const lean = Math.min(Math.PI / 2 - 0.08, Math.max(0.9, Math.PI / 2 - Math.atan2(s.capR - s.radius, h)));
      rot = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(Math.cos(s.spin), 0, Math.sin(s.spin)), lean);
      pos.y += s.radius * 0.6;
    }
    this.bodies.set(s.slot, m.compose(pos, rot, one));
    this.bodies.setExtra(s.slot, s.radius, h, s.capR);
    this.solid(s, pos, rot, h);
  }

  update(dt: number, viewer: THREE.Vector3, night: number) {
    const glow = 0.25 + night * 1.9;
    glowU.value = glow;
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
