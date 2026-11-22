// The crashed station module: a Blender-built model (art/blender/bc_wreck_asset.py) half buried beside the spawn
// point. Solid (a trimesh from its collision mesh), with its red warning beacons and lit window throwing light.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { addDetail, addGrounding, prepGlow, splatMaterial } from './assets';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type RAPIER from '@dimforge/rapier3d';
import { loadProps } from './assets';

const HALF_LEN = 8.6, HALF_WIDTH = 3.6;
/** Where the wreck came to rest, saved so it never moves between sessions (digging near it used to re-seat it). */
export interface WreckSave { x: number; y: number; z: number; rx: number; ry: number; rz: number; cleared?: number[] }

export class Wreck {
  readonly group = new THREE.Group();
  /** Torn hull plates strewn around the crash (world space, not part of the tilted wreck). */
  readonly debris = new THREE.Group();
  readonly center = new THREE.Vector3();
  private yaw: number;
  private beacons: THREE.PointLight[] = [];
  private beaconMats: THREE.MeshStandardMaterial[] = [];
  /** Hull plates cleared by digging (by scatter index; they stay gone). */
  private cleared = new Set<number>();
  private saved: WreckSave | null = null;
  private t = 0;

  placed = false;
  /** Called once it's in place (clear whatever grew where it now lies). */
  onSeated?: () => void;
  private pending: THREE.Mesh | null = null;

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World, renderer: THREE.WebGLRenderer, private spawn: THREE.Vector3,
    private ground: (x: number, z: number) => number | null, saved?: WreckSave) {
    if (saved) { this.saved = saved; for (const i of saved.cleared ?? []) this.cleared.add(i); }
    // Beside the spawn, nose torn open and pointing away from it. It's seated once the ground under it exists.
    this.yaw = 0.55;
    this.center.set(spawn.x + 7.5, spawn.y, spawn.z + 2.5);
    this.group.visible = false;
    const env = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
    new GLTFLoader().load('models/wreck.json', (gltf) => {
      const root = gltf.scene;
      this.group.add(root);
      root.updateMatrixWorld(true);
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh) return;
        if (m.name.startsWith('COL_')) { this.pending = m; m.visible = false; return; }
        m.castShadow = m.name !== 'Wreck_Lights';
        m.receiveShadow = true;
        let mat = m.material as THREE.MeshStandardMaterial;
        // The interior lost its material in export: unnamed white metal that the env map lit bright white through the
        // torn nose. Dark, grimy bulkhead instead.
        if (m.name === 'Wreck_Interior' || (!mat.name && !mat.map)) {
          mat = m.material = new THREE.MeshStandardMaterial({ color: 0x23262a, roughness: 0.8, metalness: 0.35, side: THREE.DoubleSide });
          addDetail(mat, { scale: 1.2, normal: 0.4, moss: 0.15, wet: 0.2, macro: 0.5, rough: 0.4 });
        }
        if (mat.name.startsWith('BeaconRed')) this.beaconMats.push(mat); // pulses with its light
        // A faint reflection environment so the metal reads as metal at night (without one it renders black).
        mat.envMap = env; mat.envMapIntensity = 0.25;
      });
    });
    // Light from the beacons and the window, so the wreck lights its own patch of ground.
    const local = (x: number, y: number, z: number) => new THREE.Vector3(x, z, -y); // Blender (Z up) -> three (Y up)
    for (const [p, c, i, d] of [[local(3.6, -2.4, 2.3), 0xff1a08, 6, 12], [local(-2.8, -3.6, 0.9), 0x40e8ff, 3, 9]] as const) {
      const l = new THREE.PointLight(c, i, d, 2);
      l.position.copy(p);
      this.group.add(l);
      if (c === 0xff1a08) this.beacons.push(l);
    }
  }

  /** Solid: a fixed trimesh from the (hidden) collision mesh, in world space. */
  private collider(m: THREE.Mesh) {
    const g = m.geometry.clone().applyMatrix4(m.matrixWorld);
    const pos = g.getAttribute('position').array as Float32Array;
    const idx = g.index ? new Uint32Array(g.index.array) : new Uint32Array([...Array(pos.length / 3).keys()]);
    this.physics.createCollider(this.rapier.ColliderDesc.trimesh(new Float32Array(pos), idx));
  }

  /** Inside the wreck's footprint (keeps mushrooms, stones and fiber from growing through it). */
  covers(x: number, z: number, margin = 1.5) {
    const dx = x - this.center.x, dz = z - this.center.z;
    const ax = Math.cos(this.yaw), az = -Math.sin(this.yaw);
    const along = dx * ax + dz * az, side = -dx * az + dz * ax;
    return Math.abs(along) < HALF_LEN + margin && Math.abs(side) < HALF_WIDTH + margin;
  }

  /** Picks the flattest spot near the spawn (physics rays over each candidate footprint) and seats the wreck there,
   *  once the terrain colliders exist. Rolled and pitched to the ground, a third of the hull below it. */
  private seat() {
    if (!this.pending) return;
    if (this.saved) {
      // Back where it was. Waits for the ground around it (the debris is seated on it).
      const v = this.saved;
      for (const [dx, dz] of [[0, 0], [16, 0], [-16, 0], [0, 16], [0, -16]]) if (this.ground(v.x + dx, v.z + dz) === null) return;
      this.center.set(v.x, v.y, v.z);
      this.group.position.copy(this.center);
      this.group.rotation.set(v.rx, v.ry, v.rz, 'YXZ');
      this.yaw = v.ry;
      return this.finishSeat();
    }
    let best: { x: number; z: number; yaw: number; mean: number; pitch: number; roll: number; score: number } | null = null;
    const sp = this.spawn;
    for (const r of [9, 12, 15]) for (let k = 0; k < 12; k++) for (const yaw of [0.2, 0.95, 1.7, 2.45]) {
      const a = k / 12 * Math.PI * 2, x = sp.x + Math.cos(a) * r, z = sp.z + Math.sin(a) * r;
      const ax = Math.cos(yaw), az = -Math.sin(yaw), sx = -az, sz = ax;
      const dsx = sp.x - x, dsz = sp.z - z; // keep the spawn point clear of the hull
      if (Math.abs(dsx * ax + dsz * az) < HALF_LEN + 3 && Math.abs(dsx * sx + dsz * sz) < HALF_WIDTH + 3) continue;
      const hs: number[] = [];
      let sumAlong = 0, sumSide = 0, n = 0, ok = true;
      for (const u of [-1, -0.5, 0, 0.5, 1]) for (const v of [-1, 0, 1]) {
        const h = this.ground(x + ax * u * HALF_LEN + sx * v * HALF_WIDTH, z + az * u * HALF_LEN + sz * v * HALF_WIDTH);
        if (h === null) { ok = false; break; }
        hs.push(h); sumAlong += u * h; sumSide += v * h; n++;
      }
      if (!ok) { if (r === 9) return; continue; } // ground not built yet around the spawn: try again next frame
      const mean = hs.reduce((p, q) => p + q, 0) / n;
      const varc = hs.reduce((p, q) => p + (q - mean) ** 2, 0) / n;
      // Least-squares tilt along and across the hull.
      const gA = sumAlong / (n / 5 * (1 + 0.25 + 0 + 0.25 + 1)) / HALF_LEN, gS = sumSide / (n / 3 * 2) / HALF_WIDTH;
      const score = varc + Math.abs(r - 11) * 0.02; // flattest, not too close or far
      if (!best || score < best.score) best = { x, z, yaw, mean, pitch: Math.atan(gA), roll: Math.atan(gS), score };
    }
    if (!best) return;
    this.yaw = best.yaw;
    this.center.set(best.x, best.mean + 0.6, best.z);
    this.group.position.copy(this.center);
    this.group.rotation.set(-best.roll * 0.9 + 0.08, this.yaw, best.pitch * 0.9 - 0.05, 'YXZ');
    this.finishSeat();
  }

  private finishSeat() {
    this.group.updateMatrixWorld(true);
    this.collider(this.pending!);
    this.group.visible = true;
    this.placed = true;
    this.onSeated?.();
    void this.scatterDebris();
  }

  /** Digging or filling under a hull plate: it goes (it would float, or sink into the fill). */
  clearDebrisNear(p: THREE.Vector3, r: number) {
    for (const d of [...this.debris.children]) if (d.position.distanceTo(p) < r + 0.8) { this.debris.remove(d); this.cleared.add(d.userData.i); }
  }

  private async scatterDebris() {
    const m = await loadProps();
    const kinds = ['Debris_1', 'Debris_2', 'Debris_3'].map((n) => m[n]).filter(Boolean)
      .map((k) => { const mat = prepGlow(k.material.clone()); addDetail(mat, { scale: 1.6, normal: 0.35, moss: 0.3, wet: 0.3, macro: 0.4, rough: 0.4 }); addGrounding(mat, 0.15, 0.12, 0.4); return { geometry: k.geometry, material: mat }; });
    if (!kinds.length) return;
    const splatMat = splatMaterial(), quad = new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2);
    let seed = 7;
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 22; i++) {
      // Every random draw happens up front, so a plate keeps its look whether or not its ground has loaded yet.
      const a = rnd() * Math.PI * 2, d = 4 + rnd() * 14;
      const x = this.center.x + Math.cos(a) * d * 1.3, z = this.center.z + Math.sin(a) * d;
      const rx = (rnd() - 0.5) * 0.5, ry = rnd() * Math.PI * 2, rz = (rnd() - 0.5) * 0.5, sc = 0.7 + rnd() * 0.7;
      if (this.covers(x, z, 0.3) || this.cleared.has(i)) continue;
      this.debrisTodo.push({ i, x, z, rx, ry, rz, sc, k: kinds[i % kinds.length], splatMat, quad });
    }
    this.placeDebris();
  }

  /** Plates whose ground isn't built yet wait (they used to be dropped, so the count changed from load to load). */
  private todoTimer = 0;
  private debrisTodo: { i: number; x: number; z: number; rx: number; ry: number; rz: number; sc: number; k: { geometry: THREE.BufferGeometry; material: THREE.Material }; splatMat: THREE.Material; quad: THREE.BufferGeometry }[] = [];
  private placeDebris() {
    this.debrisTodo = this.debrisTodo.filter(({ i, x, z, rx, ry, rz, sc, k, splatMat, quad }) => {
      const h = this.ground(x, z);
      if (h === null) return true;
      const piece = new THREE.Mesh(k.geometry, k.material);
      piece.position.set(x, h + 0.03, z);
      piece.rotation.set(rx, ry, rz, 'YXZ');
      piece.scale.setScalar(sc);
      piece.castShadow = piece.receiveShadow = true;
      piece.userData.i = i;
      // A scorched contact patch under the plate (a child: it goes when the plate is cleared).
      const sp = new THREE.Mesh(quad, splatMat);
      // Lie on the ground's own slope (a flat patch on a slope floats on one side and sinks on the other).
      const hx = (this.ground(x + 0.6, z) ?? h) - (this.ground(x - 0.6, z) ?? h), hz = (this.ground(x, z + 0.6) ?? h) - (this.ground(x, z - 0.6) ?? h);
      const gn = new THREE.Vector3(-hx / 1.2, 1, -hz / 1.2).normalize(), up = new THREE.Vector3(0, 1, 0);
      const world = new THREE.Quaternion().setFromUnitVectors(up, gn).multiply(new THREE.Quaternion().setFromAxisAngle(up, piece.rotation.y));
      sp.quaternion.copy(piece.quaternion).invert().multiply(world);
      sp.position.set(0, -0.025, 0).applyQuaternion(piece.quaternion.clone().invert()); sp.scale.set(1.5, 1, 1.15); sp.renderOrder = -1;
      piece.add(sp);
      this.debris.add(piece);
      return false;
    });
  }

  update(dt: number) {
    if (!this.placed) this.seat();
    else if (this.debrisTodo.length && (this.todoTimer -= dt) <= 0) { this.todoTimer = 0.5; this.placeDebris(); }
    // The beacon pulses: a slow, uneven warning blink.
    this.t += dt;
    const k = Math.max(0, Math.sin(this.t * 2.1)) ** 3 * 0.85 + 0.15;
    for (const b of this.beacons) b.intensity = 6 * k;
    for (const m of this.beaconMats) m.emissiveIntensity = 12 * k; // the lamp blinks with its light (it stayed lit)
  }

  save(): WreckSave | undefined {
    if (!this.placed) return this.saved ?? undefined;
    const r = this.group.rotation;
    return { x: this.center.x, y: this.center.y, z: this.center.z, rx: r.x, ry: r.y, rz: r.z, cleared: [...this.cleared] };
  }
}
