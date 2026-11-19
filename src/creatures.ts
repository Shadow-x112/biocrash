// First fauna (M1 step 5): Tuko and Oomi, two harmless species that test the creature setup.
// Each creature runs a small state machine; the ground is found by probing the chunk meshes below it.
import * as THREE from 'three';
import type { Cost } from './inventory';

type State = 'idle' | 'wander' | 'flee' | 'curl' | 'sleep' | 'dead';

export interface Species {
  id: 'tuko' | 'oomi';
  name: string;
  health: number;
  walk: number;
  run: number;
  radius: number;       // hit sphere
  height: number;       // hit sphere centre above the ground
  scareDist: number;    // flees when you come this close
  drops: Cost;
  build: () => { root: THREE.Group; legs: THREE.Object3D[]; body: THREE.Object3D; glow: THREE.MeshStandardMaterial; ball?: THREE.Object3D };
}

// Shared look rules: walkers have 3 or 6 legs, eyes are mineral lenses, a cool glow means harmless.
const COOL_GLOW = 0x5fe0d0;

function mat(color: number, extra: Partial<THREE.MeshStandardMaterialParameters> = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.85, flatShading: true, ...extra });
}

function buildTuko() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const shell = mat(0x6d7f8c);
  const belly = mat(0xb8a98f);
  const glow = mat(0x1a3a38, { emissive: COOL_GLOW, emissiveIntensity: 1.2 });
  // Three overlapping armor bands over a soft belly.
  for (let i = 0; i < 3; i++) {
    const band = new THREE.Mesh(new THREE.SphereGeometry(0.2 - i * 0.02, 8, 5, 0, Math.PI * 2, 0, Math.PI / 2), shell);
    band.scale.set(1, 0.8, 0.62);
    band.position.z = 0.12 - i * 0.12;
    body.add(band);
  }
  const under = new THREE.Mesh(new THREE.SphereGeometry(0.18, 8, 5), belly);
  under.scale.set(1, 0.35, 1.3);
  under.position.y = 0.02;
  body.add(under);
  for (const x of [-0.06, 0.06]) {
    const eye = new THREE.Mesh(new THREE.IcosahedronGeometry(0.03, 0), glow);
    eye.position.set(x, 0.07, 0.24);
    body.add(eye);
  }
  body.position.y = 0.12;
  root.add(body);
  const legs: THREE.Object3D[] = [];
  const legGeo = new THREE.CylinderGeometry(0.012, 0.018, 0.14, 4).translate(0, -0.07, 0);
  for (let i = 0; i < 6; i++) {
    const leg = new THREE.Mesh(legGeo, belly);
    const side = i < 3 ? -1 : 1;
    leg.position.set(side * 0.15, 0.13, 0.12 - (i % 3) * 0.12);
    leg.rotation.z = side * 0.5;
    root.add(leg);
    legs.push(leg);
  }
  // Curled-up armored ball, shown instead of the body when threatened.
  const ball = new THREE.Mesh(new THREE.IcosahedronGeometry(0.2, 1), shell);
  ball.position.y = 0.2;
  ball.visible = false;
  root.add(ball);
  return { root, legs, body, glow, ball };
}

function buildOomi() {
  const root = new THREE.Group();
  const body = new THREE.Group();
  const skin = mat(0xb9a7c9);
  const dark = mat(0x6d5f7d);
  const glow = mat(0x1d3134, { emissive: COOL_GLOW, emissiveIntensity: 0.9 });
  const torso = new THREE.Mesh(new THREE.SphereGeometry(0.42, 10, 7), skin);
  torso.scale.set(1, 0.78, 1.2);
  body.add(torso);
  // Glowing pores along the back.
  for (let i = 0; i < 6; i++) {
    const pore = new THREE.Mesh(new THREE.IcosahedronGeometry(0.045, 0), glow);
    pore.position.set(Math.sin(i * 2.1) * 0.18, 0.3, 0.32 - i * 0.12);
    body.add(pore);
  }
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.14, 0.4, 6), skin);
  neck.position.set(0, 0.18, 0.5);
  neck.rotation.x = 0.9;
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 6), skin);
  head.scale.set(1, 0.8, 1.3);
  head.position.set(0, 0.28, 0.72);
  const lens = new THREE.Mesh(new THREE.IcosahedronGeometry(0.05, 0), glow);
  lens.position.set(0, 0.33, 0.86);
  body.add(neck, head, lens);
  body.position.y = 1.0;
  root.add(body);
  // Tripod: one leg in front, two behind.
  const legs: THREE.Object3D[] = [];
  const legGeo = new THREE.CylinderGeometry(0.035, 0.07, 1.0, 5).translate(0, -0.5, 0);
  const spots: [number, number][] = [[0, 0.3], [-0.28, -0.3], [0.28, -0.3]];
  for (const [x, z] of spots) {
    const leg = new THREE.Mesh(legGeo, dark);
    leg.position.set(x, 1.0, z);
    root.add(leg);
    legs.push(leg);
  }
  return { root, legs, body, glow };
}

export const SPECIES: Record<Species['id'], Species> = {
  tuko: { id: 'tuko', name: 'Tuko', health: 20, walk: 1.1, run: 4.6, radius: 0.28, height: 0.18, scareDist: 6,
    drops: { chitin: 2, raw_meat: 1 }, build: buildTuko },
  oomi: { id: 'oomi', name: 'Oomi', health: 60, walk: 0.9, run: 4.2, radius: 0.7, height: 1.0, scareDist: 0,
    drops: { hide: 2, bone: 1, raw_meat: 2, fiber: 2 }, build: buildOomi },
};

export class Creature {
  readonly root: THREE.Group;
  private legs: THREE.Object3D[];
  private body: THREE.Object3D;
  private ball?: THREE.Object3D;
  readonly glow: THREE.MeshStandardMaterial;
  health: number;
  state: State = 'idle';
  heading = Math.random() * Math.PI * 2;
  private timer = Math.random() * 3;
  private gait = Math.random() * 10;
  private hurtFlash = 0;
  private speed = 0;
  harvested = false;
  deadTime = 0;
  /** Oomi leave glowing trail spots as they walk. */
  private trailTimer = 0;
  /** Seconds a Tuko holds still after uncurling. */
  private peek = 0;

  constructor(readonly species: Species, readonly position: THREE.Vector3) {
    const b = species.build();
    this.root = b.root; this.legs = b.legs; this.body = b.body; this.glow = b.glow; this.ball = b.ball;
    this.health = species.health;
    this.root.position.copy(position);
  }

  get alive() { return this.state !== 'dead'; }

  /** Centre of the hit sphere. */
  hitCentre(out = new THREE.Vector3()) { return out.copy(this.position).setY(this.position.y + this.species.height); }

  damage(amount: number, from: THREE.Vector3) {
    if (!this.alive) return false;
    if (this.state === 'curl') return false; // armored ball shrugs off hits
    this.health -= amount;
    this.hurtFlash = 0.25;
    this.flee(from, 5);
    if (this.species.id === 'tuko' && this.health > 0) { this.state = 'curl'; this.timer = 4; }
    if (this.health <= 0) this.die();
    return true;
  }

  private die() {
    this.state = 'dead';
    this.speed = 0;
    this.root.rotation.z = Math.PI / 2 * 0.95; // fall on its side
    this.glow.emissiveIntensity = 0;
    if (this.ball) { this.ball.visible = false; this.body.visible = true; }
  }

  private flee(from: THREE.Vector3, seconds: number) {
    this.heading = Math.atan2(this.position.x - from.x, this.position.z - from.z);
    this.state = 'flee';
    this.timer = seconds;
  }

  update(dt: number, ctx: { player: THREE.Vector3; playerRunning: boolean; playerSneaking: boolean; night: number; ground: (x: number, z: number, y: number) => { y: number; ny: number } | null; trail: (p: THREE.Vector3) => void }) {
    this.gait += dt;
    if (this.hurtFlash > 0) this.hurtFlash -= dt;
    if (!this.alive) { this.deadTime += dt; return; }

    const sp = this.species;
    const toPlayer = this.position.distanceTo(ctx.player);
    this.timer -= dt;

    // Decide.
    if (this.state === 'curl') {
      // Uncurl and freeze for a moment before bolting: the window to strike.
      if (this.timer <= 0) { this.state = 'idle'; this.timer = 0; this.peek = 0.8; }
    } else if (this.peek > 0) {
      this.peek -= dt;
      if (this.peek <= 0) this.flee(ctx.player, 3);
    } else if (sp.scareDist > 0 && toPlayer < sp.scareDist * (ctx.playerRunning ? 1.6 : ctx.playerSneaking ? 0.45 : 1) && this.state !== 'flee') {
      // Skittish: bolt, and curl up if you get right on top of it.
      if (toPlayer < 2 && sp.id === 'tuko') { this.state = 'curl'; this.timer = 3; } else this.flee(ctx.player, 3);
    } else if (this.state === 'flee') {
      if (this.timer <= 0) { this.state = 'idle'; this.timer = 2; }
    } else if (sp.id === 'oomi' && ctx.night > 0.7) {
      this.state = 'sleep'; // Oomi bed down at night and glow softly
    } else if (this.timer <= 0) {
      if (this.state === 'wander' || this.state === 'sleep') { this.state = 'idle'; this.timer = 1.5 + Math.random() * 4; }
      else { this.state = 'wander'; this.timer = 3 + Math.random() * 6; this.heading += (Math.random() - 0.5) * 2.2; }
    }

    // Move.
    const target = this.state === 'flee' ? sp.run : this.state === 'wander' ? sp.walk : 0;
    this.speed += (target - this.speed) * Math.min(1, dt * 4);
    if (this.speed > 0.02) {
      const nx = this.position.x + Math.sin(this.heading) * this.speed * dt;
      const nz = this.position.z + Math.cos(this.heading) * this.speed * dt;
      const g = ctx.ground(nx, nz, this.position.y);
      if (g && g.ny > 0.62 && Math.abs(g.y - this.position.y) < 1.2) {
        this.position.set(nx, g.y, nz);
      } else {
        this.heading += Math.PI * (0.5 + Math.random() * 0.5); // too steep or a drop: turn away
      }
    } else {
      const g = ctx.ground(this.position.x, this.position.z, this.position.y);
      if (g) this.position.y += (g.y - this.position.y) * Math.min(1, dt * 8);
    }

    if (sp.id === 'oomi' && this.state === 'wander' && (this.trailTimer -= dt) <= 0) {
      this.trailTimer = 1.6;
      ctx.trail(this.position);
    }

    // Animate.
    this.root.position.copy(this.position);
    const yawDiff = Math.atan2(Math.sin(this.heading - this.root.rotation.y), Math.cos(this.heading - this.root.rotation.y));
    this.root.rotation.y += yawDiff * Math.min(1, dt * 6);
    const step = this.speed * (sp.id === 'tuko' ? 9 : 3.5);
    const phase = this.gait * step;
    this.legs.forEach((leg, i) => {
      const swing = this.speed > 0.05 ? Math.sin(phase + i * (sp.id === 'tuko' ? Math.PI : (Math.PI * 2) / 3)) * 0.45 : 0;
      leg.rotation.x = swing;
    });
    const sleeping = this.state === 'sleep';
    this.body.position.y = (sp.id === 'tuko' ? 0.12 : sleeping ? 0.55 : 1.0) + (this.speed > 0.05 ? Math.abs(Math.sin(phase)) * 0.03 : Math.sin(this.gait * 1.5) * 0.01);
    this.legs.forEach((l) => (l.visible = !sleeping && this.state !== 'curl'));
    if (this.ball) {
      const curled = this.state === 'curl';
      this.ball.visible = curled;
      this.body.visible = !curled;
    }
    this.glow.emissiveIntensity = (sleeping ? 1.8 : 1.0) * (0.85 + Math.sin(this.gait * 2) * 0.15);
    this.glow.color.setHex(this.hurtFlash > 0 ? 0xff3030 : 0x1d3134);
  }
}

/** Spawns creatures around the player, despawns far ones, and draws the Oomi trail glow. */
export class Fauna {
  readonly group = new THREE.Group();
  readonly list: Creature[] = [];
  private trail: THREE.InstancedMesh;
  private trailAge: number[] = [];
  private trailNext = 0;
  private spawnTimer = 0;
  private m4 = new THREE.Matrix4();

  /** Ground height and slope under a point, from the terrain's height grids (no raycasts). */
  readonly ground: (x: number, z: number, nearY: number) => { y: number; ny: number } | null;

  constructor(groundAt: (x: number, z: number) => { y: number; ny: number } | null) {
    this.ground = (x, z) => groundAt(x, z);
    const g = new THREE.CircleGeometry(0.22, 8).rotateX(-Math.PI / 2);
    const m = new THREE.MeshBasicMaterial({ color: COOL_GLOW, transparent: true, opacity: 0.5, depthWrite: false, blending: THREE.AdditiveBlending });
    this.trail = new THREE.InstancedMesh(g, m, 60);
    this.trail.count = 60;
    for (let i = 0; i < 60; i++) { this.trail.setMatrixAt(i, this.m4.makeScale(0, 0, 0)); this.trailAge.push(999); }
    this.trail.frustumCulled = false;
    this.group.add(this.trail);
  }

  private addTrail(p: THREE.Vector3) {
    const i = this.trailNext++ % 60;
    this.trailAge[i] = 0;
    this.m4.makeTranslation(p.x, p.y + 0.04, p.z);
    this.trail.setMatrixAt(i, this.m4);
    this.trail.instanceMatrix.needsUpdate = true;
  }

  spawn(id: Species['id'], at: THREE.Vector3) {
    const c = new Creature(SPECIES[id], at.clone());
    this.list.push(c);
    this.group.add(c.root);
    return c;
  }

  private remove(c: Creature) {
    this.group.remove(c.root);
    // Each creature owns its geometries and materials: free them so long sessions don't leak GPU memory.
    c.root.traverse((o) => {
      if (o instanceof THREE.Mesh) {
        o.geometry.dispose();
        for (const m of Array.isArray(o.material) ? o.material : [o.material]) m.dispose();
      }
    });
    this.list.splice(this.list.indexOf(c), 1);
  }

  update(dt: number, player: THREE.Vector3, playerRunning: boolean, playerSneaking: boolean, night: number) {
    // Keep a modest population around the player: ~8 Tuko, ~3 Oomi.
    if ((this.spawnTimer -= dt) <= 0) {
      this.spawnTimer = 1.5;
      const count = (id: string) => this.list.filter((c) => c.species.id === id && c.alive).length;
      const want: Species['id'] | null = count('tuko') < 8 ? 'tuko' : count('oomi') < 3 ? 'oomi' : null;
      if (want) {
        const a = Math.random() * Math.PI * 2, d = 25 + Math.random() * 40;
        const x = player.x + Math.cos(a) * d, z = player.z + Math.sin(a) * d;
        const g = this.ground(x, z, player.y);
        if (g && g.ny > 0.7) {
          const n = want === 'oomi' ? 1 + Math.floor(Math.random() * 2) : 1; // Oomi wander in pairs
          for (let i = 0; i < n; i++) this.spawn(want, new THREE.Vector3(x + i * 1.5, g.y, z + i));
        }
      }
    }
    for (const c of [...this.list]) {
      c.update(dt, { player, playerRunning, playerSneaking, night, ground: this.ground, trail: (p) => this.addTrail(p) });
      const far = c.position.distanceTo(player) > 110;
      if (far || (!c.alive && (c.harvested || c.deadTime > 300))) this.remove(c);
    }
    // Trail spots fade over a minute.
    for (let i = 0; i < 60; i++) {
      if (this.trailAge[i] > 60) continue;
      this.trailAge[i] += dt;
      if (this.trailAge[i] > 60) { this.trail.setMatrixAt(i, this.m4.makeScale(0, 0, 0)); this.trail.instanceMatrix.needsUpdate = true; }
    }
    (this.trail.material as THREE.MeshBasicMaterial).opacity = 0.15 + night * 0.55;
  }

  /** The creature (or carcass) the camera points at within reach. */
  private lookRay = new THREE.Ray();
  private lookSphere = new THREE.Sphere();
  private lookHit = new THREE.Vector3();
  lookAt(camera: THREE.Camera, reach: number) {
    camera.getWorldPosition(this.lookRay.origin);
    camera.getWorldDirection(this.lookRay.direction);
    let best: Creature | null = null, bestT = reach;
    for (const c of this.list) {
      if (c.harvested) continue;
      c.hitCentre(this.lookSphere.center);
      this.lookSphere.radius = c.species.radius * (c.alive ? 1 : 1.3);
      if (this.lookRay.intersectSphere(this.lookSphere, this.lookHit)) {
        const t = this.lookHit.distanceTo(this.lookRay.origin);
        if (t < bestT) { bestT = t; best = c; }
      }
    }
    return best;
  }
}
