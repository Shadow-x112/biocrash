// Fungal forest flora (M1 step 6): giant mushrooms you can harvest for stalkwood, glowing sprouts,
// and drifting spores at night. Placement is seeded per chunk like the props.
import * as THREE from 'three';
import alea from 'alea';
import type RAPIER from '@dimforge/rapier3d-compat';
import { CHUNK } from './config';

export const STALK_HARVESTS = 4;   // uses per mushroom
export const STALK_YIELD = 2;      // stalkwood per use

interface Shroom { id: string; base: THREE.Vector3; radius: number; height: number; collider: RAPIER.Collider | null; }
interface ChunkFlora { meshes: THREE.Object3D[]; shrooms: Shroom[]; }

const STALK = new THREE.MeshStandardMaterial({ color: 0xd8ccb4, roughness: 0.9, flatShading: true });
const GILLS = new THREE.MeshStandardMaterial({ color: 0x8c6f86, roughness: 1, flatShading: true, side: THREE.DoubleSide });
const SPOTS = new THREE.MeshStandardMaterial({ color: 0x20302c, emissive: 0x6ff0d8, emissiveIntensity: 0.3, flatShading: true });
const SPROUT = new THREE.MeshStandardMaterial({ color: 0x24403a, emissive: 0x7affd6, emissiveIntensity: 0.3, flatShading: true });
const CAP_COLORS = [0x9a5a8c, 0x6f63a8, 0xb06a5a, 0x5f8f8a].map((c) => new THREE.MeshStandardMaterial({ color: c, roughness: 0.75, flatShading: true }));

// Unit geometries, scaled per instance: 1 m tall stalk, 1 m radius cap.
const stalkGeo = new THREE.CylinderGeometry(0.7, 1, 1, 9, 3).translate(0, 0.5, 0);
const capGeo = new THREE.SphereGeometry(1, 14, 7, 0, Math.PI * 2, 0, Math.PI * 0.42);
capGeo.scale(1, 0.55, 1);
const gillGeo = new THREE.CircleGeometry(0.93, 14).rotateX(Math.PI / 2);
const spotGeo = new THREE.IcosahedronGeometry(0.09, 0);
const sproutGeo = (() => {
  const g = new THREE.ConeGeometry(0.05, 0.35, 5).translate(0, 0.17, 0);
  const tip = new THREE.SphereGeometry(0.06, 6, 4).translate(0, 0.37, 0);
  const parts = [g.toNonIndexed(), tip.toNonIndexed()];
  const pos: number[] = [], nrm: number[] = [];
  for (const p of parts) { pos.push(...(p.getAttribute('position').array as Float32Array)); nrm.push(...(p.getAttribute('normal').array as Float32Array)); }
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
  private ray = new THREE.Raycaster();
  private spores: THREE.Points;
  private sporeVel: Float32Array;

  constructor(private seed: string, private rapier: typeof RAPIER, private physics: RAPIER.World, private avoid: THREE.Vector3) {
    // Spore motes that drift around the viewer and show up at night.
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

  onChunkMesh(key: string, mesh: THREE.Mesh | null, cx: number, cy: number, cz: number) {
    if (this.chunks.has(key) || !mesh) return;
    this.spawn(key, mesh, cx, cy, cz);
  }

  onChunkUnload(key: string) {
    const c = this.chunks.get(key);
    if (!c) return;
    for (const m of c.meshes) { this.group.remove(m); if (m instanceof THREE.InstancedMesh) m.dispose(); }
    for (const s of c.shrooms) if (s.collider) this.physics.removeCollider(s.collider, false);
    this.chunks.delete(key);
  }

  private surface(mesh: THREE.Mesh, x: number, z: number, top: number) {
    this.ray.set(new THREE.Vector3(x, top, z), new THREE.Vector3(0, -1, 0));
    this.ray.far = CHUNK + 1;
    const hit = this.ray.intersectObject(mesh, false)[0];
    return hit?.face ? { p: hit.point, ny: hit.face.normal.y } : null;
  }

  private spawn(key: string, mesh: THREE.Mesh, cx: number, cy: number, cz: number) {
    const rng = alea(`${this.seed}:flora:${key}`);
    const top = (cy + 1) * CHUNK + 0.5;
    mesh.updateMatrixWorld();
    const c: ChunkFlora = { meshes: [], shrooms: [] };
    // Forest density varies in patches so there are clearings and thick groves.
    const grove = 0.5 + 0.5 * Math.sin(cx * 1.7 + cz * 0.9) * Math.cos(cz * 1.3 - cx * 0.4);
    const giant = Math.round(1 + grove * 5), small = Math.round(4 + grove * 10);

    type Placed = { p: THREE.Vector3; h: number; r: number; cap: number; tilt: number; spin: number; color: number; id: string };
    const placed: Placed[] = [];
    const tryPlace = (count: number, hMin: number, hMax: number, tag: string) => {
      for (let i = 0; i < count; i++) {
        const x = cx * CHUNK + rng() * CHUNK, z = cz * CHUNK + rng() * CHUNK;
        const h = hMin + rng() * (hMax - hMin), tilt = (rng() - 0.5) * 0.25, spin = rng() * Math.PI * 2, color = Math.floor(rng() * CAP_COLORS.length);
        if (Math.hypot(x - this.avoid.x, z - this.avoid.z) < 9) continue; // keep the crash site clear
        const s = this.surface(mesh, x, z, top);
        if (!s || s.ny < 0.78) continue;
        const r = h * (tag === 'g' ? 0.06 : 0.09);
        if (placed.some((o) => o.p.distanceTo(s.p) < (o.cap + h * 0.45) * 0.8)) continue; // no overlapping caps
        placed.push({ p: s.p, h, r, cap: h * (tag === 'g' ? 0.42 : 0.5), tilt, spin, color, id: `${key}:${tag}${i}` });
      }
    };
    tryPlace(giant, 7, 15, 'g');
    tryPlace(small, 1.2, 3.5, 's');

    if (placed.length) {
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), e = new THREE.Euler(), sc = new THREE.Vector3(), v = new THREE.Vector3();
      const stalks = new THREE.InstancedMesh(stalkGeo, STALK, placed.length);
      const gills = new THREE.InstancedMesh(gillGeo, GILLS, placed.length);
      const caps = CAP_COLORS.map((mat) => new THREE.InstancedMesh(capGeo, mat, placed.length));
      const capCount = CAP_COLORS.map(() => 0);
      const spotsPer = 7;
      const spots = new THREE.InstancedMesh(spotGeo, SPOTS, placed.length * spotsPer);
      placed.forEach((o, i) => {
        e.set(o.tilt, o.spin, o.tilt * 0.6);
        q.setFromEuler(e);
        m.compose(o.p.clone().add(new THREE.Vector3(0, -0.3, 0)), q, sc.set(o.r, o.h + 0.3, o.r));
        stalks.setMatrixAt(i, m);
        // Cap sits on the (tilted) stalk top.
        const topP = v.set(0, o.h, 0).applyQuaternion(q).add(o.p);
        m.compose(topP, q, sc.set(o.cap, o.cap, o.cap));
        const ci = o.color;
        caps[ci].setMatrixAt(capCount[ci]++, m);
        m.compose(topP.clone().add(new THREE.Vector3(0, 0.02, 0)), q, sc.set(o.cap, o.cap, o.cap));
        gills.setMatrixAt(i, m);
        for (let k = 0; k < spotsPer; k++) {
          const a = k * 2.4 + o.spin, rr = 0.35 + (k % 3) * 0.2;
          const local = new THREE.Vector3(Math.cos(a) * rr, Math.sqrt(Math.max(0, 1 - rr * rr)) * 0.55, Math.sin(a) * rr).multiplyScalar(o.cap);
          m.compose(local.applyQuaternion(q).add(topP), q, sc.setScalar(o.cap * 0.9));
          spots.setMatrixAt(i * spotsPer + k, m);
        }
        if (o.h > 5) {
          const desc = this.rapier.ColliderDesc.cylinder(o.h / 2, o.r * 0.85).setTranslation(o.p.x, o.p.y + o.h / 2, o.p.z);
          c.shrooms.push({ id: o.id, base: o.p.clone(), radius: o.r, height: o.h, collider: this.physics.createCollider(desc) });
        } else {
          c.shrooms.push({ id: o.id, base: o.p.clone(), radius: o.r, height: o.h, collider: null });
        }
      });
      caps.forEach((im, i) => { im.count = capCount[i]; });
      for (const im of [stalks, gills, spots, ...caps]) {
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        this.group.add(im);
        c.meshes.push(im);
      }
    }

    // Glowing sprouts in little clusters.
    const sproutSpots: THREE.Matrix4[] = [];
    const clusters = Math.round(3 + grove * 6);
    for (let k = 0; k < clusters; k++) {
      const x0 = cx * CHUNK + rng() * CHUNK, z0 = cz * CHUNK + rng() * CHUNK;
      for (let j = 0; j < 7; j++) {
        const x = x0 + (rng() - 0.5) * 2.2, z = z0 + (rng() - 0.5) * 2.2, s = 0.6 + rng() * 0.9, spin = rng() * 6.28;
        const hit = this.surface(mesh, x, z, top);
        if (!hit || hit.ny < 0.7) continue;
        sproutSpots.push(new THREE.Matrix4().compose(hit.p, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), spin), new THREE.Vector3(s, s, s)));
      }
    }
    if (sproutSpots.length) {
      const im = new THREE.InstancedMesh(sproutGeo, SPROUT, sproutSpots.length);
      sproutSpots.forEach((mm, i) => im.setMatrixAt(i, mm));
      im.instanceMatrix.needsUpdate = true;
      im.computeBoundingSphere();
      this.group.add(im);
      c.meshes.push(im);
    }
    this.chunks.set(key, c);
  }

  /** The mushroom stalk the camera faces within reach (for harvesting stalkwood). */
  lookAt(camera: THREE.Camera, reach: number) {
    const origin = camera.getWorldPosition(new THREE.Vector3());
    const dir = camera.getWorldDirection(new THREE.Vector3());
    let best: Shroom | null = null, bestT = reach;
    for (const c of this.chunks.values()) for (const s of c.shrooms) {
      // Approximate the stalk as a vertical cylinder: test the ray against a sphere at eye height.
      const centre = new THREE.Vector3(s.base.x, Math.min(Math.max(origin.y, s.base.y + 0.3), s.base.y + s.height * 0.8), s.base.z);
      const hit = new THREE.Ray(origin, dir).intersectSphere(new THREE.Sphere(centre, s.radius + 0.15), new THREE.Vector3());
      if (hit) { const t = hit.distanceTo(origin); if (t < bestT) { bestT = t; best = s; } }
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
    // Spores: drift upward, wrap around the viewer.
    const pos = this.spores.geometry.getAttribute('position') as THREE.BufferAttribute;
    const a = pos.array as Float32Array;
    for (let i = 0; i < a.length; i += 3) {
      a[i] += this.sporeVel[i] * dt; a[i + 1] += this.sporeVel[i + 1] * dt; a[i + 2] += this.sporeVel[i + 2] * dt;
      if (a[i + 1] > 10) a[i + 1] = 0;
      if (a[i] > 20) a[i] -= 40; else if (a[i] < -20) a[i] += 40;
      if (a[i + 2] > 20) a[i + 2] -= 40; else if (a[i + 2] < -20) a[i + 2] += 40;
    }
    pos.needsUpdate = true;
    this.spores.position.set(viewer.x, viewer.y - 3, viewer.z);
    (this.spores.material as THREE.PointsMaterial).opacity = night * 0.9;
  }
}
