// Campfires: the first heat source you build. They burn fuel, light the night and keep you warm.
import * as THREE from 'three';
import type { HeatSource } from './survival';

export const CAMPFIRE_COST = { stalkwood: 4, stone: 5 } as const;
export const FUEL_START = 180;     // seconds of burn when built
export const FUEL_PER_WOOD = 90;   // seconds added per stalkwood
export const FUEL_MAX = 600;
const HEAT_RADIUS = 8;
const HEAT_C = 45;
const MAX_LIGHTS = 2; // only the two nearest fires cast light: every light costs every lit pixel

export interface CampfireSave { x: number; y: number; z: number; fuel: number; cooking?: number[]; }
/** Seconds to cook one piece of meat over a lit fire. */
export const COOK_TIME = 9;

class Campfire {
  readonly group = new THREE.Group();
  readonly heat: HeatSource;
  private flame: THREE.Mesh;
  private inner: THREE.Mesh;
  private t = Math.random() * 10;
  /** Seconds left on each piece of meat on the spit (only the first cooks; the fire must be lit). */
  cooking: number[] = [];
  private meat: THREE.Mesh;
  /** Flicker: a random walk toward new targets every few frames (sines read as mechanical). */
  private flick = 1;
  private flickTarget = 1;
  private flickTimer = 0;
  /** Now and then the fire gutters to ~40% for a moment: a warning that usually means nothing. */
  private gutter = 0;
  private gutterTimer = 60 + Math.random() * 120;
  /** 0..1 burst of light when lit or relit. */
  flare = 1;
  /** Light jitter, so lit surfaces crawl. */
  readonly jitter = new THREE.Vector3();

  constructor(readonly position: THREE.Vector3, public fuel: number, parts: { stone: THREE.BufferGeometry; log: THREE.BufferGeometry; flame: THREE.BufferGeometry; meat: THREE.BufferGeometry; mats: Record<string, THREE.Material> }) {
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
    this.meat = new THREE.Mesh(parts.meat, parts.mats.meat.clone());
    this.meat.position.y = 0.95;
    this.meat.visible = false;
    this.group.add(this.flame, this.inner, this.meat);
    this.heat = { position: position.clone().add(new THREE.Vector3(0, 0.6, 0)), radius: HEAT_RADIUS, heatC: 0 };
  }

  get lit() { return this.fuel > 0; }

  /** Returns how many pieces finished cooking this frame (via `done`). */
  update(dt: number, done: () => void = () => {}) {
    this.fuel = Math.max(0, this.fuel - dt);
    this.t += dt;
    if (this.lit && this.cooking.length && (this.cooking[0] -= dt) <= 0) { this.cooking.shift(); done(); }
    this.meat.visible = this.cooking.length > 0;
    if (this.meat.visible) {
      this.meat.rotation.y += dt * 0.8;
      const c = 1 - Math.max(0, this.cooking[0]) / COOK_TIME; // browns as it cooks
      (this.meat.material as THREE.MeshStandardMaterial).color.setRGB(0.75 - c * 0.38, 0.32 - c * 0.12, 0.3 - c * 0.17);
    }
    // Small fires (low fuel) burn lower and give less heat.
    const strength = this.lit ? Math.min(1, 0.45 + this.fuel / FUEL_START) : 0;
    if ((this.flickTimer -= dt) <= 0) {
      this.flickTimer = 0.05 + Math.random() * 0.09;
      this.flickTarget = 0.82 + Math.random() * 0.3;
      this.jitter.set((Math.random() - 0.5) * 0.16, (Math.random() - 0.5) * 0.1, (Math.random() - 0.5) * 0.16);
    }
    this.flick += (this.flickTarget - this.flick) * Math.min(1, dt * 18);
    if ((this.gutterTimer -= dt) <= 0) { this.gutterTimer = 90 + Math.random() * 180; this.gutter = 1.6; }
    this.gutter = Math.max(0, this.gutter - dt);
    const gut = this.gutter > 0 ? 0.4 + 0.6 * Math.abs(this.gutter - 0.8) / 0.8 : 1; // dips to 40% and recovers
    this.flare = Math.max(0, this.flare - dt * 0.8);
    const flicker = this.flick * gut;
    this.flame.visible = this.inner.visible = this.lit;
    this.flame.scale.set(strength * flicker, strength * (1.1 + Math.sin(this.t * 9) * 0.12), strength * flicker);
    this.inner.scale.set(0.55 * strength, 0.6 * strength * flicker, 0.55 * strength);
    this.heat.heatC = HEAT_C * strength;
    return strength * flicker + (this.lit ? this.flare * 1.2 : 0);
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
    meat: new THREE.DodecahedronGeometry(0.13, 0).scale(1.3, 0.8, 1),
    mats: {
      stone: new THREE.MeshStandardMaterial({ color: 0x7c776f, roughness: 1, flatShading: true }),
      meat: new THREE.MeshStandardMaterial({ color: 0xbf5249, roughness: 0.7, flatShading: true }),
      log: new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1, flatShading: true }),
      // Brighter than white on purpose (HDR): the bloom pass picks the flames out.
      flame: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.2, 0.9, 0.28), transparent: true, opacity: 0.85, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
      flameCore: new THREE.MeshBasicMaterial({ color: new THREE.Color(2.6, 1.9, 0.8), transparent: true, opacity: 0.95, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }),
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
  private ray = new THREE.Raycaster();
  private centre = new THREE.Vector2(0, 0);
  lookAt(camera: THREE.Camera, reach: number) {
    if (!this.list.length) return null;
    this.ray.setFromCamera(this.centre, camera);
    this.ray.far = reach;
    const hits = this.ray.intersectObjects(this.list.map((f) => f.group), true);
    if (!hits.length) return null;
    return this.list.find((f) => hits[0].object.parent === f.group) ?? null;
  }

  addFuel(f: Campfire) {
    if (!f.lit) f.flare = 1; // relit: a burst of light
    f.fuel = Math.min(FUEL_MAX, f.fuel + FUEL_PER_WOOD);
  }

  /** Called when a piece of meat finishes cooking on a fire. */
  onCooked: (f: Campfire) => void = () => {};

  update(dt: number, viewer: THREE.Vector3) {
    const strengths = this.list.map((f) => f.update(dt, () => this.onCooked(f)));
    const lit = this.list.map((f, i) => ({ f, s: strengths[i], d: f.position.distanceToSquared(viewer) }))
      .filter((x) => x.s > 0).sort((a, b) => a.d - b.d);
    this.lights.forEach((l, i) => {
      const x = lit[i];
      if (!x) { l.intensity = 0; return; }
      l.position.copy(x.f.position).add(x.f.jitter).y += 0.9;
      l.intensity = 7 * x.s;
      // Redder as the fuel runs low.
      const low = Math.min(1, x.f.fuel / 120);
      l.color.setRGB(1, 0.42 + 0.2 * low, 0.18 + 0.12 * low);
    });
  }

  save(): CampfireSave[] {
    return this.list.map((f) => ({ x: f.position.x, y: f.position.y, z: f.position.z, fuel: f.fuel, cooking: [...f.cooking] }));
  }

  load(list: CampfireSave[] | undefined) {
    for (const s of list ?? []) { const f = this.add(new THREE.Vector3(s.x, s.y, s.z), s.fuel); f.cooking = [...(s.cooking ?? [])]; f.flare = 0; }
  }
}
