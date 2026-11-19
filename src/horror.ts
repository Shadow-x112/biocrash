// Psychological horror layer. A hidden "unease" level (never shown) rises in the dark, in caves, in the cold, when hurt and
// when you stay away from fire at night. It only changes what you hear and see: sourceless sounds, whispers behind you,
// memories of Earth, a figure at the edge of your vision, a glitching wrist readout. Nothing here can hurt you.
import * as THREE from 'three';
import type { Audio, Loop } from './audio';

export interface HorrorInput {
  dt: number;
  camera: THREE.Camera;
  night: number;       // 0 day .. 1 night
  daylight: number;    // 0..1
  fireNear: number;    // 0..1, how much lit fire is close by
  warmth: number;      // 0..100
  health: number;      // 0..100
  underground: boolean;
  ground: (x: number, z: number) => { y: number; ny: number } | null;
  crashSite: THREE.Vector3;
}

const smooth = (a: number, b: number, x: number) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class Horror {
  /** 0..1 hidden unease. */
  level = 0;
  /** For tests/debug: forces the level when set. */
  override: number | null = null;
  /** Wrist readout glitch: when > 0, the HUD should show nonsense. */
  glitch = 0;
  /** Counts of what fired (debug/tests). */
  readonly fired: Record<string, number> = {};
  private awayFromFire = 0;
  private beds: Record<string, Loop> = {};
  private timers: Record<string, number> = { creature: 20, wreck: 40, swell: 30, whisper: 60, breath: 90, memory: 150, figure: 100, sting: 3600, glitch: 50, loon: 30 };
  private whisperVoice: { gain: GainNode; pos: THREE.Vector3 } | null = null;
  private memoryVoice: { gain: GainNode; end: number } | null = null;
  private figure: THREE.Group;
  private figureLife = 0;
  private fwd = new THREE.Vector3();
  private tmp = new THREE.Vector3();
  private vignette: HTMLElement;
  private staticEl: HTMLElement;

  constructor(private audio: Audio, scene: THREE.Scene) {
    // The figure: tall, thin, too still. Unlit black so it reads as a silhouette through the fog.
    const mat = new THREE.MeshBasicMaterial({ color: 0x050607, fog: true });
    this.figure = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.22, 2.1, 4, 8), mat);
    body.position.y = 1.3;
    const head = new THREE.Mesh(new THREE.SphereGeometry(0.2, 10, 8), mat);
    head.position.y = 2.75; head.scale.set(0.9, 1.25, 0.9);
    const armL = new THREE.Mesh(new THREE.CapsuleGeometry(0.06, 1.5, 3, 6), mat);
    armL.position.set(-0.3, 1.45, 0); armL.rotation.z = 0.06;
    const armR = armL.clone(); armR.position.x = 0.3; armR.rotation.z = -0.06;
    this.figure.add(body, head, armL, armR);
    this.figure.visible = false;
    scene.add(this.figure);
    this.vignette = document.getElementById('unease')!;
    this.staticEl = document.getElementById('static')!;
  }

  private fire(k: string) { this.fired[k] = (this.fired[k] ?? 0) + 1; }

  private bed(id: string) { return (this.beds[id] ??= this.audio.loop(id)); }

  /** A point `dist` metres from the listener in a random direction, on the ground if possible. */
  private around(cam: THREE.Vector3, dist: number, ground: HorrorInput['ground'], behind?: THREE.Vector3) {
    const a = behind ? Math.atan2(-behind.x, -behind.z) + rand(-0.6, 0.6) : Math.random() * Math.PI * 2;
    const p = new THREE.Vector3(cam.x + Math.sin(a) * dist, cam.y, cam.z + Math.cos(a) * dist);
    const g = ground(p.x, p.z);
    if (g) p.y = g.y + 1;
    return p;
  }

  /** True when the player is looking (roughly) toward p. */
  private looking(cam: THREE.Camera, p: THREE.Vector3, cosLimit: number) {
    this.tmp.subVectors(p, cam.position).normalize();
    return this.tmp.dot(this.fwd) > cosLimit;
  }

  update(i: HorrorInput) {
    const { dt, camera } = i;
    const cam = camera.position;
    camera.getWorldDirection(this.fwd);

    // --- The unease level -------------------------------------------------------------------------
    const dark = i.night * (1 - i.fireNear);
    this.awayFromFire = i.fireNear > 0.3 || i.night < 0.3 ? Math.max(0, this.awayFromFire - dt * 4) : this.awayFromFire + dt;
    const target = Math.min(1, Math.max(0,
      dark * 0.4 + (i.underground ? 0.3 : 0) + smooth(30, 0, i.warmth) * 0.15 + smooth(45, 10, i.health) * 0.25
      + Math.min(0.3, this.awayFromFire / 300) - i.fireNear * 0.35 - i.daylight * (i.underground ? 0 : 0.25)));
    if (this.override !== null) this.level = this.override;
    else this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 1 / 40 : 1 / 12));
    const u = this.level;

    // --- Ambient beds ---------------------------------------------------------------------------
    const cave = i.underground ? 1 : 0;
    this.bed('bed_day').setLevel(i.daylight * (1 - cave) * 0.7 * (1 - u * 0.6));
    this.bed('bed_night').setLevel(i.night * (1 - cave) * 0.8);
    this.bed('bed_cave').setLevel(cave * 0.9);
    this.bed('bed_dread').setLevel(smooth(0.4, 0.85, u) * 0.75, 3);

    // --- Screen: a darker edge and lower exposure as unease grows (read by the renderer) ------------
    this.vignette.style.opacity = String(smooth(0.2, 1, u) * 0.75);

    // --- Timed events -------------------------------------------------------------------------
    const t = this.timers;
    for (const k in t) t[k] -= dt;

    // Something big, far off, that you never find.
    if (t.creature <= 0) {
      t.creature = rand(25, 60) * (1.3 - u);
      if (i.night > 0.4 || i.underground || u > 0.3) {
        const p = this.around(cam, rand(35, 60), i.ground);
        if (Math.random() < 0.25) this.audio.playAny('moan', 2, { pos: p, gain: 1.2, rate: rand(0.75, 0.95) });
        else this.audio.playAny('growl', 6, { pos: p, gain: 1.4, rate: rand(0.7, 0.95) });
        if (u > 0.55 && Math.random() < 0.3) this.audio.play('horn', { pos: this.around(cam, 70, i.ground), gain: 1.3, rate: 0.8 });
        this.fire('creature');
      }
    }
    // Daytime alien bird calls keep days alive.
    if (t.loon <= 0) {
      t.loon = rand(25, 70);
      if (i.daylight > 0.5 && !i.underground) { this.audio.play('loon', { pos: this.around(cam, rand(20, 45), i.ground), gain: 0.8, rate: rand(0.85, 1.2) }); this.fire('loon'); }
    }
    // The wreck groans at night.
    if (t.wreck <= 0) {
      t.wreck = rand(45, 100);
      if (i.night > 0.5) {
        const d = cam.distanceTo(i.crashSite);
        if (d < 120) { this.audio.playAny('metal', 3, { pos: i.crashSite, gain: 1.6, rate: rand(0.6, 0.9) }); this.fire('wreck'); }
      }
    }
    // Low string swells: the music notices before you do.
    if (t.swell <= 0) {
      t.swell = rand(35, 80);
      if (u > 0.35) {
        if (Math.random() < 0.3) this.audio.play('friction', { gain: 0.35 * u, fadeIn: 2, bus: 'amb' });
        else this.audio.playAny('lowstring', 3, { gain: 0.4 * u, fadeIn: 2, bus: 'amb' });
        this.fire('swell');
      }
    }
    // A whisper right behind you. It stops if you turn around.
    if (t.whisper <= 0 && !this.whisperVoice) {
      t.whisper = rand(60, 140) * (1.4 - u);
      if (u > 0.45) {
        const pos = cam.clone().addScaledVector(this.fwd, -2.2).add(new THREE.Vector3(rand(-0.6, 0.6), 0.1, rand(-0.6, 0.6)));
        const v = this.audio.play('whisper', { pos, gain: 0.55, hrtf: true, offset: rand(0, 8), dur: rand(4, 7), fadeIn: 1.2 });
        if (v) { this.whisperVoice = { gain: v.gain, pos }; v.src.onended = () => { this.whisperVoice = null; }; this.fire('whisper'); }
      }
    }
    if (this.whisperVoice && this.looking(camera, this.whisperVoice.pos, 0.2)) {
      const g = this.whisperVoice.gain.gain, now = this.audio.ctx!.currentTime;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.25);
      this.whisperVoice = null;
    }
    // Breathing, close, when it's very bad.
    if (t.breath <= 0) {
      t.breath = rand(80, 160);
      if (u > 0.65) {
        const pos = cam.clone().addScaledVector(this.fwd, -1.2);
        this.audio.play('breathing', { pos, gain: 0.5, hrtf: true, offset: rand(0, 10), dur: rand(5, 8), fadeIn: 2 });
        this.fire('breath');
      }
    }
    // Earth. A farm, birds, people. It shouldn't be here, and it cuts off.
    if (t.memory <= 0 && !this.memoryVoice) {
      t.memory = rand(180, 320);
      if (u > 0.5) {
        const id = Math.random() < 0.5 ? 'earth_farm' : 'earth_woods';
        const len = rand(6, 11);
        const v = this.audio.play(id, { gain: 0.6, fadeIn: 3, offset: rand(0, 10), bus: 'amb' });
        if (v) { this.memoryVoice = { gain: v.gain, end: this.audio.ctx!.currentTime + len }; v.src.stop(this.audio.ctx!.currentTime + len + 0.1); this.fire('memory'); }
      }
    }
    if (this.memoryVoice && this.audio.ctx && this.audio.ctx.currentTime >= this.memoryVoice.end - 0.05) {
      this.memoryVoice = null;
      this.audio.playAny('disrupt', 4, { gain: 0.7, bus: 'ui' });
      this.flashStatic(0.2);
    }
    // The figure at the edge of your vision. Look at it and it's gone.
    if (t.figure <= 0 && !this.figure.visible) {
      t.figure = rand(120, 240);
      if (u > 0.6 && !i.underground) {
        const side = Math.random() < 0.5 ? 1 : -1;
        const yaw = Math.atan2(this.fwd.x, this.fwd.z) + side * rand(0.9, 1.15); // ~55-65 degrees off centre
        const d = rand(16, 26);
        const p = new THREE.Vector3(cam.x + Math.sin(yaw) * d, 0, cam.z + Math.cos(yaw) * d);
        const g = i.ground(p.x, p.z);
        if (g) {
          this.figure.position.set(p.x, g.y, p.z);
          this.figure.lookAt(cam.x, g.y, cam.z);
          this.figure.visible = true;
          this.figureLife = rand(6, 12);
          this.fire('figure');
        }
      }
    }
    if (this.figure.visible) {
      this.figureLife -= dt;
      const head = this.tmp.copy(this.figure.position).setY(this.figure.position.y + 2.4);
      const seen = this.looking(camera, head, Math.cos(0.38));
      const close = cam.distanceTo(this.figure.position) < 9;
      if (seen || close || this.figureLife <= 0) {
        this.figure.visible = false;
        if ((seen || close) && t.sting <= 0 && u > 0.7 && Math.random() < 0.5) this.stinger();
        else if (seen || close) { this.audio.play('static', { gain: 0.35, bus: 'ui', dur: 0.4 }); this.flashStatic(0.12); }
      }
    }
    // A rare scare out of nowhere, with a riser first.
    if (t.sting <= 0 && u > 0.75 && Math.random() < dt / 60) {
      this.audio.playAny('riser', 3, { gain: 0.6, bus: 'amb' });
      setTimeout(() => this.stinger(), 2200);
      t.sting = rand(3600, 4800);
    }
    // The wrist readout glitches. The AI is fine. Probably.
    if (t.glitch <= 0) {
      t.glitch = rand(50, 120) * (1.3 - u);
      if (u > 0.3) {
        this.glitch = rand(0.6, 1.4);
        this.audio.playAny('disrupt', 4, { gain: 0.4, bus: 'ui', dur: 0.8 });
        this.fire('glitch');
      }
    }
    if (this.glitch > 0) this.glitch -= dt;
  }

  private stinger() {
    const ids = ['sting_shadows', 'sting_from_below', 'sting_taken', 'sting_lights_out'];
    this.audio.play(ids[Math.floor(Math.random() * ids.length)], { gain: 0.9, bus: 'ui' });
    this.audio.play('subdrop', { gain: 0.6, bus: 'ui' });
    this.flashStatic(0.25);
    this.timers.sting = rand(3600, 4800); // at most one scare an hour
    this.fire('sting');
  }

  private flashStatic(seconds: number) {
    this.staticEl.style.opacity = '0.35';
    setTimeout(() => { this.staticEl.style.opacity = '0'; }, seconds * 1000);
  }

  /** Exposure multiplier for the renderer: the world dims a little as unease grows. */
  get exposure() { return 1 - smooth(0.3, 1, this.level) * 0.22; }
}
