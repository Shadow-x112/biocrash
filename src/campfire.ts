// Campfires: the first heat source you build. They burn fuel, light the night and keep you warm.
import * as THREE from 'three';
import type { HeatSource } from './survival';

export const CAMPFIRE_COST = { stalkwood: 4, stone: 5 } as const;
export const FUEL_START = 180;     // seconds of burn when built
export const FUEL_PER_WOOD = 90;   // seconds added per stalkwood
export const FUEL_MAX = 600;
const HEAT_RADIUS = 8;
const HEAT_C = 45;
const MAX_LIGHTS = 4;

export interface CampfireSave { x: number; y: number; z: number; fuel: number; }

class Campfire {
  readonly group = new THREE.Group();
  readonly heat: HeatSource;
  private flame: THREE.Mesh;
  private inner: THREE.Mesh;
  private t = Math.random() * 10;

  constructor(readonly position: THREE.Vector3, public fuel: number, parts: { stone: THREE.BufferGeometry; log: THREE.BufferGeometry; flame: THREE.BufferGeometry; mats: Record<string, THREE.Material> }) {
    this.group.position.copy(position);
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const s = new THREE.Mesh(parts.stone, parts.mats.stone);
      s.position.set(Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55);
      s.rotation.set(a, a * 2, 0);
      s.scale.setScalar(0.8 + ((i * 37) % 10) / 25);
      this.group.add(s);
    }
    for (let i = 0; i < 3; i++) {
      const l = new THREE.Mesh(parts.log, parts.mats.log);
      l.position.y = 0.18;
      l.rotation.set(Math.PI / 2 - 0.5, (i / 3) * Math.PI * 2, 0, 'YXZ');
      this.group.add(l);
    }
    this.flame = new THREE.Mesh(parts.flame, parts.mats.flame);
    this.flame.position.y = 0.45;
    this.inner = new THREE.Mesh(parts.flame, parts.mats.flameCore);
    this.inner.position.y = 0.38;
    this.inner.scale.setScalar(0.55);
    this.group.add(this.flame, this.inner);
    this.heat = { position: position.clone().add(new THREE.Vector3(0, 0.6, 0)), radius: HEAT_RADIUS, heatC: 0 };
  }

  get lit() { return this.fuel > 0; }

  update(dt: number) {
    this.fuel = Math.max(0, this.fuel - dt);
    this.t += dt;
    // Small fires (low fuel) burn lower and give less heat.
    const strength = this.lit ? Math.min(1, 0.45 + this.fuel / FUEL_START) : 0;
    const flicker = 1 + Math.sin(this.t * 13) * 0.06 + Math.sin(this.t * 23.7) * 0.04;
    this.flame.visible = this.inner.visible = this.lit;
    this.flame.scale.set(strength * flicker, strength * (1.1 + Math.sin(this.t * 9) * 0.12), strength * flicker);
    this.inner.scale.set(0.55 * strength, 0.6 * strength * flicker, 0.55 * strength);
    this.heat.heatC = HEAT_C * strength;
    return strength * flicker;
  }
}

export class Campfires {
  readonly group = new THREE.Group();
  readonly list: Campfire[] = [];
  private lights: THREE.PointLight[] = [];
  private parts = {
    stone: new THREE.DodecahedronGeometry(0.16, 0),
    log: new THREE.CylinderGeometry(0.05, 0.07, 0.8, 6),
    flame: new THREE.ConeGeometry(0.28, 0.9, 7, 1, true).translate(0, 0.1, 0),
    mats: {
      stone: new THREE.MeshStandardMaterial({ color: 0x7c776f, roughness: 1, flatShading: true }),
      log: new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1, flatShading: true }),
      flame: new THREE.MeshBasicMaterial({ color: 0xff8a2a, transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      flameCore: new THREE.MeshBasicMaterial({ color: 0xffe08a, transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
    } as Record<string, THREE.Material>,
  };

  constructor(private heatSources: HeatSource[]) {
    // A fixed pool of lights, handed to the nearest fires, so adding fires never forces shader recompiles.
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff9a4a, 0, 18, 1.6);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  add(position: THREE.Vector3, fuel = FUEL_START) {
    const f = new Campfire(position, fuel, this.parts);
    this.list.push(f);
    this.group.add(f.group);
    this.heatSources.push(f.heat);
    return f;
  }

  /** The campfire the camera points at within reach, if any. */
  lookAt(camera: THREE.Camera, reach: number) {
    const ray = new THREE.Raycaster();
    ray.setFromCamera(new THREE.Vector2(0, 0), camera);
    ray.far = reach;
    const hits = ray.intersectObjects(this.list.map((f) => f.group), true);
    if (!hits.length) return null;
    return this.list.find((f) => hits[0].object.parent === f.group) ?? null;
  }

  addFuel(f: Campfire) { f.fuel = Math.min(FUEL_MAX, f.fuel + FUEL_PER_WOOD); }

  update(dt: number, viewer: THREE.Vector3) {
    const strengths = this.list.map((f) => f.update(dt));
    const lit = this.list.map((f, i) => ({ f, s: strengths[i], d: f.position.distanceToSquared(viewer) }))
      .filter((x) => x.s > 0).sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const x = lit[i];
      if (!x) { l.intensity = 0; return; }
      l.position.copy(x.f.position).add(new THREE.Vector3(0, 0.9, 0));
      l.intensity = 7 * x.s;
    });
  }

  save(): CampfireSave[] {
    return this.list.map((f) => ({ x: f.position.x, y: f.position.y, z: f.position.z, fuel: f.fuel }));
  }

  load(list: CampfireSave[] | undefined) {
    for (const s of list ?? []) this.add(new THREE.Vector3(s.x, s.y, s.z), s.fuel);
  }
}
