// Station tech you build in the world: signal flares (two minutes of red light that steadies the nerves) and solar
// panels (in daylight they charge the wrist lamp while you stand close). Models: art/blender/bc_props.py.
import * as THREE from 'three';
import type RAPIER from '@dimforge/rapier3d';

type Look = { geometry: THREE.BufferGeometry; material: THREE.Material };
export interface PlacedSave { solars: { x: number; y: number; z: number; rot: number; nx?: number; nz?: number }[]; flares: { x: number; y: number; z: number; t: number }[] }

export const FLARE_TIME = 120;
export const MAX_SOLARS = 12;
const FLARE_LIGHTS = 2; // a fixed pool: adding/removing lights would recompile every material
const FLARE_RED = new THREE.Color(1.0, 0.2, 0.08);

/** Soft additive glow sprite (no light cost): what makes a flare's head read from far away. */
const glowSprite = (() => {
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!, grd = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grd.addColorStop(0, 'rgba(255,255,255,1)'); grd.addColorStop(0.2, 'rgba(255,255,255,0.5)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  return (color: THREE.Color, size: number) => {
    const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    s.scale.setScalar(size);
    return s;
  };
})();
export { glowSprite };

interface Flare { pos: THREE.Vector3; t: number; group: THREE.Group; glow: THREE.Sprite }
interface Solar { pos: THREE.Vector3; rot: number; n: THREE.Vector3; group: THREE.Group; body: RAPIER.RigidBody }

let flareLook: Look = { geometry: new THREE.CylinderGeometry(0.02, 0.02, 0.7, 6).translate(0, 0.35, 0), material: new THREE.MeshStandardMaterial({ color: 0x3a2a2a, emissive: 0xff3010, emissiveIntensity: 0.4 }) };
let frameLook: Look = { geometry: new THREE.BoxGeometry(0.9, 0.9, 0.55).translate(0, 0.45, 0), material: new THREE.MeshStandardMaterial({ color: 0x2a2228 }) };
let panelLook: Look = { geometry: new THREE.BoxGeometry(1, 0.03, 0.68).translate(0, 0.8, 0), material: new THREE.MeshStandardMaterial({ color: 0x0a1430, metalness: 0.6, roughness: 0.3 }) };

export class Placeables {
  readonly group = new THREE.Group();
  readonly flares: Flare[] = [];
  readonly solars: Solar[] = [];
  private lights: THREE.PointLight[] = [];
  private t = 0;

  constructor(private rapier: typeof RAPIER, private physics: RAPIER.World) {
    for (let i = 0; i < FLARE_LIGHTS; i++) {
      const l = new THREE.PointLight(FLARE_RED, 0, 16, 1.6);
      this.lights.push(l); this.group.add(l);
    }
  }

  setLooks(m: Record<string, Look>) {
    if (m.Flare) { flareLook = m.Flare; for (const f of this.flares) { const s = f.group.children[0] as THREE.Mesh; s.geometry = flareLook.geometry; s.material = flareLook.material; } }
    if (m.Solar_Frame && m.Solar_Panel) {
      frameLook = m.Solar_Frame; panelLook = m.Solar_Panel;
      for (const s of this.solars) { const [a, b] = s.group.children as THREE.Mesh[]; a.geometry = frameLook.geometry; a.material = frameLook.material; b.geometry = panelLook.geometry; b.material = panelLook.material; }
    }
  }

  addFlare(pos: THREE.Vector3, t = FLARE_TIME) {
    const g = new THREE.Group(); g.position.copy(pos); g.rotation.set((Math.random() - 0.5) * 0.25, Math.random() * 6.28, (Math.random() - 0.5) * 0.25);
    const m = new THREE.Mesh(flareLook.geometry, flareLook.material); m.castShadow = m.receiveShadow = true;
    const glow = glowSprite(FLARE_RED, 0.7); glow.position.y = 0.66;
    g.add(m, glow); this.group.add(g);
    this.flares.push({ pos: pos.clone(), t, group: g, glow });
  }

  addSolar(pos: THREE.Vector3, rot: number, nx = 0, nz = 0) {
    const n = new THREE.Vector3(nx, Math.sqrt(Math.max(0.01, 1 - nx * nx - nz * nz)), nz).normalize();
    const tq = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n).multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot));
    const g = new THREE.Group(); g.position.copy(pos); g.quaternion.copy(tq);
    const a = new THREE.Mesh(frameLook.geometry, frameLook.material), b = new THREE.Mesh(panelLook.geometry, panelLook.material);
    a.castShadow = b.castShadow = a.receiveShadow = b.receiveShadow = true;
    g.add(a, b); this.group.add(g);
    const R = this.rapier, q = tq;
    const body = this.physics.createRigidBody(R.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z).setRotation(q));
    this.physics.createCollider(R.ColliderDesc.cuboid(0.5, 0.5, 0.35).setTranslation(0, 0.5, 0), body);
    this.solars.push({ pos: pos.clone(), rot, n, group: g, body });
  }

  /** 0..1: how much burning flare light is around `p` (fades out over ~12 m). */
  flareNear(p: THREE.Vector3) {
    let best = 0;
    for (const f of this.flares) if (f.t > 0) best = Math.max(best, (1 - f.pos.distanceTo(p) / 12) * Math.min(1, f.t / 10));
    return Math.max(0, best);
  }

  solarNear(p: THREE.Vector3, r: number) { return this.solars.some((s) => s.pos.distanceToSquared(p) < r * r); }

  update(dt: number, viewer: THREE.Vector3) {
    this.t += dt;
    for (let i = this.flares.length - 1; i >= 0; i--) {
      const f = this.flares[i];
      f.t -= dt;
      if (f.t <= -30) { this.group.remove(f.group); this.flares.splice(i, 1); continue; } // the burnt stake lingers a while
      const k = Math.max(0, Math.min(1, f.t / 8)) * (0.75 + 0.25 * Math.sin(this.t * 23 + i) * Math.sin(this.t * 7.1 + i * 3));
      f.glow.material.opacity = k * 0.7; f.glow.scale.setScalar(0.5 + k * 0.35);
    }
    // The two nearest burning flares get the real lights.
    const lit = this.flares.filter((f) => f.t > 0).sort((a, b) => a.pos.distanceToSquared(viewer) - b.pos.distanceToSquared(viewer));
    this.lights.forEach((l, i) => {
      const f = lit[i];
      if (!f) { l.intensity = 0; return; }
      l.position.copy(f.pos).y += 0.75;
      l.intensity = 9 * Math.max(0, Math.min(1, f.t / 8)) * (0.8 + 0.2 * Math.sin(this.t * 19 + i * 2));
    });
  }

  makePreview(kind: 'flare' | 'solar') {
    const mat = new THREE.MeshBasicMaterial({ color: 0x7dff9a, transparent: true, opacity: 0.4, depthWrite: false });
    const group = new THREE.Group();
    const parts = kind === 'flare' ? [new THREE.Mesh(flareLook.geometry, mat)] : [new THREE.Mesh(frameLook.geometry, mat), new THREE.Mesh(panelLook.geometry, mat)];
    group.add(...parts); group.visible = false;
    return {
      group, setOk: (ok: boolean) => mat.color.setHex(ok ? 0x7dff9a : 0xff6a50),
      refresh: () => {
        if (kind === 'flare') parts[0].geometry = flareLook.geometry;
        else { parts[0].geometry = frameLook.geometry; parts[1].geometry = panelLook.geometry; }
      },
    };
  }

  save(): PlacedSave {
    return {
      solars: this.solars.map((s) => ({ x: s.pos.x, y: s.pos.y, z: s.pos.z, rot: s.rot, nx: s.n.x, nz: s.n.z })),
      flares: this.flares.filter((f) => f.t > 0).map((f) => ({ x: f.pos.x, y: f.pos.y, z: f.pos.z, t: f.t })),
    };
  }

  load(s: PlacedSave | undefined) {
    for (const p of s?.solars ?? []) this.addSolar(new THREE.Vector3(p.x, p.y, p.z), p.rot, p.nx ?? 0, p.nz ?? 0);
    for (const f of s?.flares ?? []) this.addFlare(new THREE.Vector3(f.x, f.y, f.z), f.t);
  }
}
