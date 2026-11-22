// Campfires: the first heat source you build. They burn fuel, light the night and keep you warm.
import * as THREE from 'three';
import { addDetail, prepGlow } from './assets';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { HeatSource } from './survival';

export const CAMPFIRE_COST = { stalkwood: 4, stone: 5 } as const;
export const FUEL_START = 180;     // seconds of burn when built
export const FUEL_PER_WOOD = 90;   // seconds added per stalkwood
export const FUEL_MAX = 600;
const HEAT_RADIUS = 8;
const HEAT_C = 62; // a full fire keeps you comfortable to ~5 m, room to cook and craft beside it
const MAX_LIGHTS = 2; // only the two nearest fires cast light: every light costs every lit pixel

export interface CampfireSave { x: number; y: number; z: number; fuel: number; cooking?: number[]; /** Ground slope it sits on. */ nx?: number; nz?: number }
/** Rotation that stands something on ground with normal (nx, ny, nz). */
const tiltTo = (nx = 0, nz = 0) => { const ny = Math.sqrt(Math.max(0.01, 1 - nx * nx - nz * nz)); return new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), new THREE.Vector3(nx, ny, nz).normalize()); };

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

  constructor(readonly position: THREE.Vector3, public fuel: number, parts: { ring: THREE.BufferGeometry; logs: THREE.BufferGeometry; flame: THREE.BufferGeometry; meat: THREE.BufferGeometry; mats: Record<string, THREE.Material>; scrap?: { geometry: THREE.BufferGeometry; material: THREE.Material } },
    /** The stone ring, logs and windbreak lie with the slope; the flame and the spit stay upright. */
    readonly tilt = new THREE.Quaternion()) {
    this.group.position.copy(position);
    // The stone ring and log pile are pre-merged (shared by every fire): 2 draw calls instead of 11.
    this.ringMesh = new THREE.Mesh(parts.ring, parts.mats.stone);
    this.logMesh = new THREE.Mesh(parts.logs, parts.mats.log);
    this.ringMesh.quaternion.copy(tilt); this.logMesh.quaternion.copy(tilt);
    this.group.add(this.ringMesh, this.logMesh);
    if (parts.scrap) this.setScrap(parts.scrap);
    this.flame = new THREE.Mesh(parts.flame, parts.mats.flame);
    this.flame.position.y = 0.12;
    this.inner = new THREE.Mesh(parts.flame, parts.mats.flameCore);
    this.inner.position.y = 0.1;
    this.inner.scale.setScalar(0.55);
    this.meat = new THREE.Mesh(parts.meat, parts.mats.meat.clone());
    this.meat.position.y = 0.95;
    this.meat.visible = false;
    this.group.add(this.flame, this.inner, this.meat);
    this.heat = { position: position.clone().add(new THREE.Vector3(0, 0.6, 0)), radius: HEAT_RADIUS, heatC: 0 };
  }

  readonly ringMesh: THREE.Mesh;
  readonly logMesh: THREE.Mesh;
  private scrapMesh: THREE.Mesh | null = null;
  /** The scrap-metal windbreak (part of the Blender-built look). */
  setScrap(s: { geometry: THREE.BufferGeometry; material: THREE.Material }) {
    if (this.scrapMesh) return;
    this.scrapMesh = new THREE.Mesh(s.geometry, s.material);
    this.scrapMesh.quaternion.copy(this.tilt).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.random() * Math.PI * 2));
    this.scrapMesh.castShadow = true;
    this.group.add(this.scrapMesh);
  }

  get lit() { return this.fuel > 0; }

  dispose() { (this.meat.material as THREE.Material).dispose(); }

  /** A real gutter (horror camp event): dips the flame and burns `seconds` of fuel. */
  gutterNow(seconds: number) { this.gutter = 1.6; this.fuel = Math.max(1, this.fuel - seconds); }

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

/** Flames: three crossed planes (they read from every side) with a scrolling-noise fire shader. */
function flameGeometry() {
  const parts = [0, 1, 2].map((i) => new THREE.PlaneGeometry(0.62, 1.0, 1, 1).translate(0, 0.42, 0).rotateY(i * Math.PI / 3));
  return mergeGeometries(parts);
}
export const flameTime = { value: 0 };
function flameMaterial(hot: THREE.Color, edge: THREE.Color, speed: number) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: flameTime, uHot: { value: hot }, uEdge: { value: edge }, uSpeed: { value: speed } },
    vertexShader: `varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: `
      uniform float uTime, uSpeed; uniform vec3 uHot, uEdge; varying vec2 vUv;
      float h(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
      float n(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
        return mix(mix(h(i), h(i + vec2(1, 0)), f.x), mix(h(i + vec2(0, 1)), h(i + vec2(1, 1)), f.x), f.y); }
      float fbm(vec2 p) { float a = 0.5, s = 0.0; for (int i = 0; i < 4; i++) { s += a * n(p); p *= 2.03; a *= 0.5; } return s; }
      void main() {
        vec2 uv = vUv; float t = uTime * uSpeed;
        // Teardrop: wide at the base, licking to a point; the noise eats into the edges and rises.
        float x = (uv.x - 0.5) * 2.0;
        float width = mix(0.85, 0.05, pow(uv.y, 0.8));
        float body = 1.0 - smoothstep(width * 0.55, width, abs(x + (fbm(vec2(uv.y * 3.0, t * 1.3)) - 0.5) * 0.35 * uv.y));
        float lick = fbm(vec2(x * 2.2, uv.y * 3.2 - t * 2.4));
        float a = body * smoothstep(0.0, 0.08, uv.y) * (1.0 - smoothstep(0.55, 1.0, uv.y + (lick - 0.5) * 0.6));
        a *= 0.55 + lick * 0.9;
        vec3 c = mix(uEdge, uHot, smoothstep(0.25, 0.85, a));
        gl_FragColor = vec4(c * a, a);
      }`,
    transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
  });
}

/** Eight stones in a ring, baked into one geometry. */
function ringGeometry() {
  const stone = new THREE.DodecahedronGeometry(0.16, 0), m = new THREE.Object3D(), parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    m.position.set(Math.cos(a) * 0.55, 0.08, Math.sin(a) * 0.55);
    m.rotation.set(a, a * 2, 0);
    m.scale.setScalar(0.8 + ((i * 37) % 10) / 25);
    m.updateMatrix();
    parts.push(stone.clone().applyMatrix4(m.matrix));
  }
  return mergeGeometries(parts)!;
}

/** Three logs leaning together, baked into one geometry. */
function logsGeometry() {
  const log = new THREE.CylinderGeometry(0.05, 0.07, 0.8, 6), m = new THREE.Object3D(), parts: THREE.BufferGeometry[] = [];
  for (let i = 0; i < 3; i++) {
    m.position.set(0, 0.18, 0);
    m.rotation.set(Math.PI / 2 - 0.5, (i / 3) * Math.PI * 2, 0, 'YXZ');
    m.updateMatrix();
    parts.push(log.clone().applyMatrix4(m.matrix));
  }
  return mergeGeometries(parts)!;
}

export class Campfires {
  readonly group = new THREE.Group();
  readonly list: Campfire[] = [];
  private lights: THREE.PointLight[] = [];
  private parts: { ring: THREE.BufferGeometry; logs: THREE.BufferGeometry; flame: THREE.BufferGeometry; meat: THREE.BufferGeometry; mats: Record<string, THREE.Material>; scrap?: { geometry: THREE.BufferGeometry; material: THREE.Material } } = {
    ring: ringGeometry(),
    logs: logsGeometry(),
    flame: flameGeometry(),
    meat: new THREE.DodecahedronGeometry(0.13, 0).scale(1.3, 0.8, 1),
    mats: {
      stone: new THREE.MeshStandardMaterial({ color: 0x7c776f, roughness: 1, flatShading: true }),
      meat: new THREE.MeshStandardMaterial({ color: 0xbf5249, roughness: 0.7, flatShading: true }),
      log: new THREE.MeshStandardMaterial({ color: 0x5a4636, roughness: 1, flatShading: true }),
      // Brighter than white on purpose (HDR): the bloom pass picks the flames out.
      flame: flameMaterial(new THREE.Color(2.4, 0.85, 0.22), new THREE.Color(0.9, 0.12, 0.02), 1.0),
      flameCore: flameMaterial(new THREE.Color(3.0, 2.2, 1.0), new THREE.Color(2.2, 0.8, 0.2), 1.6),
    } as Record<string, THREE.Material>,
  };

  /** Use the Blender-built fire (dark stone ring, scrap windbreak, broken fungal wood) once loaded, for every fire. */
  setLooks(meshes: Record<string, { geometry: THREE.BufferGeometry; material: THREE.Material }>) {
    let st = meshes.Campfire_Stones, wd = meshes.Campfire_Wood; const sc = meshes.Campfire_Scrap;
    if (!st || !wd) return;
    // Own copies with the shared detail layer (the Blender materials are shared with other props).
    const stoneMat = prepGlow(st.material.clone()), logMat = prepGlow(wd.material.clone(), 2.2); // embers
    addDetail(stoneMat, { scale: 2.4, normal: 0.5, macro: 0.4 }); addDetail(logMat, { scale: 3.5, normal: 0.55, macro: 0.5 });
    st = { geometry: st.geometry, material: stoneMat }; wd = { geometry: wd.geometry, material: logMat };
    this.parts.ring = st.geometry; this.parts.mats.stone = st.material;
    this.parts.logs = wd.geometry; this.parts.mats.log = wd.material;
    if (sc) this.parts.scrap = sc;
    for (const f of this.list) {
      f.ringMesh.geometry = st.geometry; f.ringMesh.material = st.material;
      f.logMesh.geometry = wd.geometry; f.logMesh.material = wd.material;
      if (sc) f.setScrap(sc);
    }
  }

  constructor(private heatSources: HeatSource[]) {
    // A fixed pool of lights, handed to the nearest fires, so adding fires never forces shader recompiles.
    for (let i = 0; i < MAX_LIGHTS; i++) {
      const l = new THREE.PointLight(0xff9a4a, 0, 18, 1.6);
      this.lights.push(l);
      this.group.add(l);
    }
  }

  add(position: THREE.Vector3, fuel = FUEL_START, nx = 0, nz = 0) {
    const f = new Campfire(position, fuel, this.parts, tiltTo(nx, nz));
    this.list.push(f);
    this.group.add(f.group);
    this.heatSources.push(f.heat);
    return f;
  }

  /** The campfire the camera points at within reach, if any. */
  private ray = new THREE.Raycaster();
  private centre = new THREE.Vector2(0, 0);
  lookAt(camera: THREE.Camera, reach: number) {
    // Only fires within reach are worth a raycast (this runs 10 times a second).
    const near = this.list.filter((f) => f.position.distanceToSquared(camera.position) < (reach + 2) ** 2);
    if (!near.length) return null;
    this.ray.setFromCamera(this.centre, camera);
    this.ray.far = reach;
    const hits = this.ray.intersectObjects(near.map((f) => f.group), true);
    if (!hits.length) return null;
    return this.list.find((f) => hits[0].object.parent === f.group) ?? null;
  }

  addFuel(f: Campfire) {
    if (!f.lit) f.flare = 1; // relit: a burst of light
    f.fuel = Math.min(FUEL_MAX, f.fuel + FUEL_PER_WOOD);
  }

  /** A see-through fire ring for placing (green when it fits, red when it doesn't). */
  makePreview() {
    const mat = new THREE.MeshBasicMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.45, depthWrite: false });
    const group = new THREE.Group();
    group.add(new THREE.Mesh(this.parts.ring, mat), new THREE.Mesh(this.parts.logs, mat));
    group.visible = false;
    return { group, setOk: (ok: boolean) => mat.color.setHex(ok ? 0x7dff9a : 0xff6a50) };
  }

  /** Take a fire out of the world (its heat source and its own cloned meat material go with it). */
  remove(f: Campfire) {
    const i = this.list.indexOf(f);
    if (i < 0) return;
    this.list.splice(i, 1);
    this.group.remove(f.group);
    const h = this.heatSources.indexOf(f.heat);
    if (h >= 0) this.heatSources.splice(h, 1);
    f.dispose();
  }

  /** Called when a piece of meat finishes cooking on a fire. */
  onCooked: (f: Campfire) => void = () => {};

  update(dt: number, viewer: THREE.Vector3) {
    flameTime.value += dt;
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
    return this.list.map((f) => { const n = new THREE.Vector3(0, 1, 0).applyQuaternion(f.tilt); return { x: f.position.x, y: f.position.y, z: f.position.z, fuel: f.fuel, cooking: [...f.cooking], nx: n.x, nz: n.z }; });
  }

  load(list: CampfireSave[] | undefined) {
    for (const s of list ?? []) { const f = this.add(new THREE.Vector3(s.x, s.y, s.z), s.fuel, s.nx ?? 0, s.nz ?? 0); f.cooking = [...(s.cooking ?? [])]; f.flare = 0; }
  }
}
