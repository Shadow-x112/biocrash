// Psychological horror layer. A hidden "unease" level (never shown) rises in the dark, in caves, in the cold, when hurt, when
// you stay away from fire at night and with what you do (noise, freezing in place, whipping around). It only changes what
// you hear and see: sourceless sounds, whispers behind you, memories of Earth, a figure at the edge of your vision, a
// glitching wrist readout, traces of something that passed. Nothing here can hurt you.
//
// Pacing (after Left 4 Dead's director and Alien: Isolation's menace gauge): calm -> build -> one big event (peak) -> a real
// rest of 1-2 minutes. Big events come from a shuffled deck, so none repeats until all have played, and they unlock over the
// first nights: nights 1-2 have only distant calls, the wreck and drips; the figure comes later, and a stinger only after it.
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
  /** Nights survived so far (0 during the first night). */
  nights: number;
  running: boolean;    // sprinting: noise
  moving: boolean;
  litFiresNear: number;
  fogNear: number;     // the figure never stands closer than this
}

type Phase = 'calm' | 'build' | 'peak' | 'relax';
type Major = 'whisper' | 'breath' | 'memory' | 'figure' | 'voice' | 'falseAlarm';
const MAJORS: Major[] = ['whisper', 'breath', 'memory', 'figure', 'voice', 'falseAlarm'];
/** First night (0-based) on which each event can happen. */
const UNLOCK: Record<Major | 'glitch', number> = { memory: 1, whisper: 2, glitch: 2, breath: 2, voice: 2, falseAlarm: 2, figure: 3 };
/** Unease needed for each big event. */
const NEED: Record<Major, number> = { memory: 0.5, whisper: 0.45, breath: 0.65, voice: 0.6, falseAlarm: 0.55, figure: 0.6 };

export interface HorrorSave { figureSeen: boolean; figureNight: number }

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
  phase: Phase = 'calm';
  /** The figure shows at most once per night; stingers only after it has been seen. */
  figureSeen = false;
  figureNight = -1;
  private phaseT = 0;
  private deck: Major[] = [];
  private last: Major | null = null;
  private awayFromFire = 0;
  private beds: Record<string, Loop> = {};
  private timers: Record<string, number> = { creature: 30, wreck: 60, swell: 45, major: 40, sting: 3600, glitch: 90, loon: 30, drip: 2 };
  private pendingSting = -1; // game-time countdown from riser to stinger (pauses with the game)
  private whisperVoice: { gain: GainNode; pos: THREE.Vector3 } | null = null;
  private memoryVoice: { gain: GainNode; end: number } | null = null;
  private figure: THREE.Group;
  private figureLife = 0;
  private fwd = new THREE.Vector3();
  private prevFwd = new THREE.Vector3(0, 0, -1);
  private turn = 0;   // smoothed turning speed (rad/s)
  private still = 0;  // seconds without moving
  private tmp = new THREE.Vector3();
  private vignette: HTMLElement;
  private staticEl: HTMLElement;
  private traces = new THREE.Group();

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
    scene.add(this.figure, this.traces);
    this.vignette = document.getElementById('unease')!;
    this.staticEl = document.getElementById('static')!;
  }

  save(): HorrorSave { return { figureSeen: this.figureSeen, figureNight: this.figureNight }; }
  load(s: Partial<HorrorSave> | undefined) {
    if (typeof s?.figureSeen === 'boolean') this.figureSeen = s.figureSeen;
    if (typeof s?.figureNight === 'number' && Number.isFinite(s.figureNight)) this.figureNight = s.figureNight;
  }

  private fire(k: string) { this.fired[k] = (this.fired[k] ?? 0) + 1; }
  private bed(id: string) { return (this.beds[id] ??= this.audio.loop(id)); }

  /** A big event happened: hold the peak a few seconds, then rest. */
  private peaked(k: Major) { this.phase = 'peak'; this.phaseT = rand(3, 5); this.last = k; this.fire(k); }

  /** Next card; when the deck runs out it's reshuffled, never starting with the card that just played. */
  private draw(): Major {
    if (!this.deck.length) {
      this.deck = [...MAJORS].sort(() => Math.random() - 0.5);
      if (this.deck[0] === this.last) this.deck.push(this.deck.shift()!);
    }
    return this.deck.shift()!;
  }

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

  private static boneGeo = new THREE.TetrahedronGeometry(0.12, 0).scale(1, 0.35, 2.2);
  private static boneMat = new THREE.MeshStandardMaterial({ color: 0xd8d0bd, roughness: 0.9, flatShading: true });
  private static patchGeo = new THREE.CircleGeometry(1.4, 12).rotateX(-Math.PI / 2);
  private static patchMat = new THREE.MeshBasicMaterial({ color: 0x120c10, transparent: true, opacity: 0.55, depthWrite: false });

  /** Something passed here: a dark, dragged patch and a few pale shards. Kept for the session (at most 6). */
  private leaveTrace(p: THREE.Vector3, ground: HorrorInput['ground']) {
    const g = ground(p.x, p.z);
    if (!g || g.ny < 0.8) return;
    const grp = new THREE.Group();
    grp.position.set(p.x, g.y + 0.03, p.z);
    grp.rotation.y = Math.random() * Math.PI * 2;
    const patch = new THREE.Mesh(Horror.patchGeo, Horror.patchMat);
    patch.scale.set(rand(0.8, 1.3), 1, rand(1.6, 2.6));
    grp.add(patch);
    for (let k = 0; k < 4; k++) {
      const b = new THREE.Mesh(Horror.boneGeo, Horror.boneMat);
      b.position.set(rand(-1, 1), 0.04, rand(-2, 2));
      b.rotation.set(rand(-0.3, 0.3), rand(0, 6.3), rand(-0.3, 0.3));
      grp.add(b);
    }
    this.traces.add(grp);
    while (this.traces.children.length > 6) this.traces.remove(this.traces.children[0]);
    this.fire('trace');
  }

  update(i: HorrorInput) {
    const { dt, camera } = i;
    const cam = camera.position;
    camera.getWorldDirection(this.fwd);

    // --- The unease level -------------------------------------------------------------------------
    const dark = i.night * (1 - i.fireNear);
    this.awayFromFire = i.fireNear > 0.3 || i.night < 0.3 ? Math.max(0, this.awayFromFire - dt * 4) : this.awayFromFire + dt;
    // What you do feeds it too: noise (sprinting at night), freezing in place in the dark, whipping around to look.
    this.still = i.moving ? 0 : this.still + dt;
    const turnNow = Math.acos(Math.min(1, this.prevFwd.dot(this.fwd))) / Math.max(dt, 1e-3);
    this.prevFwd.copy(this.fwd);
    this.turn += (turnNow - this.turn) * Math.min(1, dt * 2);
    const actions = dark * ((i.running ? 0.1 : 0) + Math.min(0.1, (this.still / 60) * 0.1) + smooth(2, 6, this.turn) * 0.08);
    const target = Math.min(1, Math.max(0,
      dark * 0.4 + (i.underground ? 0.3 : 0) + smooth(30, 0, i.warmth) * 0.15 + smooth(45, 10, i.health) * 0.25
      + Math.min(0.3, this.awayFromFire / 300) + actions
      - i.fireNear * 0.35 - Math.min(0.15, Math.max(0, i.litFiresNear - 1) * 0.05) - i.daylight * (i.underground ? 0 : 0.25)));
    if (this.override !== null) this.level = this.override;
    else this.level += (target - this.level) * Math.min(1, dt * (target > this.level ? 1 / 40 : 1 / 12));
    const u = this.level;

    // --- Ambient beds ---------------------------------------------------------------------------
    // Each bed is two recordings of different lengths, so their combination never repeats the same way.
    const cave = i.underground ? 1 : 0;
    const day = i.daylight * (1 - cave) * 0.7 * (1 - u * 0.6), night = i.night * (1 - cave) * 0.8;
    const dread = smooth(0.4, 0.85, u) * 0.75;
    this.bed('bed_day').setLevel(day); this.bed('bed_day2').setLevel(day * 0.8);
    this.bed('bed_night').setLevel(night); this.bed('bed_night2').setLevel(night * 0.7);
    this.bed('bed_cave').setLevel(cave * 0.9); this.bed('bed_cave2').setLevel(cave * 0.6);
    this.bed('bed_dread').setLevel(dread, 3); this.bed('bed_dread2').setLevel(dread * 0.6, 3);
    this.audio.setSpace(cave);

    // --- Pacing ---------------------------------------------------------------------------------
    this.phaseT -= dt;
    if (this.phase === 'calm' && u > 0.35) { this.phase = 'build'; this.timers.major = Math.max(this.timers.major, rand(20, 45)); }
    else if (this.phase === 'build' && u < 0.25) this.phase = 'calm';
    else if (this.phase === 'peak' && this.phaseT <= 0) { this.phase = 'relax'; this.phaseT = rand(60, 120); }
    else if (this.phase === 'relax' && this.phaseT <= 0) this.phase = 'calm';
    const resting = this.phase === 'relax' || this.phase === 'peak';

    // --- Screen: a darker edge and lower exposure as unease grows (read by the renderer) ------------
    this.vignette.style.opacity = String(smooth(0.2, 1, u) * 0.75);

    // --- Small, ambient events -------------------------------------------------------------------
    const t = this.timers;
    for (const k in t) t[k] -= dt;

    // Something big, far off, that you never find. Sometimes it leaves something behind.
    if (t.creature <= 0) {
      t.creature = rand(40, 95);
      if (!resting && (i.night > 0.4 || i.underground || u > 0.3)) {
        const p = this.around(cam, rand(35, 65), i.ground);
        const r = Math.random();
        if (r < 0.2) this.audio.playAny('moan', 2, { pos: p, gain: 1.3, rate: rand(0.75, 0.95) });
        else if (r < 0.45) this.audio.playAny('mutation', 4, { pos: p, gain: 1.3, rate: rand(0.7, 0.9) });
        else this.audio.playAny('growl', 10, { pos: p, gain: 1.5, rate: rand(0.7, 0.95) });
        if (u > 0.55 && i.nights >= 1 && Math.random() < 0.3) this.audio.play('horn', { pos: this.around(cam, 70, i.ground), gain: 1.3, rate: 0.8 });
        if (!i.underground && Math.random() < 0.35) this.leaveTrace(cam.clone().lerp(p, rand(0.4, 0.6)), i.ground);
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
      if (i.night > 0.5 && !resting && cam.distanceTo(i.crashSite) < 120) {
        if (Math.random() < 0.25) this.audio.play('scrape', { pos: i.crashSite, gain: 1.4, rate: rand(0.5, 0.7) });
        else this.audio.playAny('metal', 3, { pos: i.crashSite, gain: 1.6, rate: rand(0.6, 0.9) });
        this.fire('wreck');
      }
    }
    // Low string swells: the music notices before you do.
    if (t.swell <= 0) {
      t.swell = rand(60, 120);
      if (u > 0.35 && !resting) {
        if (Math.random() < 0.3) this.audio.play('friction', { gain: 0.35 * u, fadeIn: 2, bus: 'amb' });
        else this.audio.playAny('lowstring', 3, { gain: 0.4 * u, fadeIn: 2, bus: 'amb' });
        this.fire('swell');
      }
    }
    // Caves drip.
    if (t.drip <= 0) {
      t.drip = rand(1.2, 4.5);
      if (i.underground) this.audio.play('drips', { pos: this.around(cam, rand(3, 12), () => null), offset: rand(0, 40), dur: rand(0.8, 1.6), gain: 1.2, rate: rand(0.9, 1.15) });
    }
    // The wrist readout glitches. The AI is fine. Probably.
    if (t.glitch <= 0) {
      t.glitch = rand(90, 180);
      if (u > 0.3 && i.nights >= UNLOCK.glitch && !resting) {
        this.glitch = rand(0.6, 1.4);
        if (Math.random() < 0.3) this.audio.play('receiver', { gain: 0.35, bus: 'ui', offset: rand(0, 12), dur: this.glitch + 0.3 });
        else this.audio.playAny('disrupt', 4, { gain: 0.4, bus: 'ui', dur: 0.8 });
        this.fire('glitch');
      }
    }
    if (this.glitch > 0) this.glitch -= dt;
    if (this.staticT > 0) this.staticT -= dt;

    // --- One big event per build-up, from the deck --------------------------------------------------
    if (this.phase === 'build' && t.major <= 0 && this.pendingSting < 0) {
      t.major = rand(25, 60);
      // Try the deck in order; cards that can't play right now go to the back.
      for (let tries = 0; tries < MAJORS.length; tries++) {
        const k = this.draw();
        if (i.nights >= UNLOCK[k] && u >= NEED[k] && this.trigger(k, i)) { this.peaked(k); break; }
        this.deck.push(k);
      }
    }
    // A whisper stops if you turn around.
    if (this.whisperVoice && this.looking(camera, this.whisperVoice.pos, 0.2)) {
      const g = this.whisperVoice.gain.gain, now = this.audio.ctx!.currentTime;
      g.cancelScheduledValues(now); g.setValueAtTime(g.value, now); g.linearRampToValueAtTime(0, now + 0.25);
      this.whisperVoice = null;
    }
    if (this.memoryVoice && this.audio.ctx && this.audio.ctx.currentTime >= this.memoryVoice.end - 0.05) {
      this.memoryVoice = null;
      this.audio.playAny('disrupt', 4, { gain: 0.7, bus: 'ui' });
      this.flashStatic(0.2);
    }
    // The figure vanishes when looked at, approached, or after a few seconds.
    if (this.figure.visible) {
      this.figureLife -= dt;
      const head = this.tmp.copy(this.figure.position).setY(this.figure.position.y + 2.4);
      const seen = this.looking(camera, head, Math.cos(0.38));
      const close = cam.distanceTo(this.figure.position) < 9;
      if (seen || close || this.figureLife <= 0) {
        this.figure.visible = false;
        if (seen || close) this.figureSeen = true;
        if ((seen || close) && t.sting <= 0 && u > 0.7 && Math.random() < 0.5) this.stinger();
        else if (seen || close) { this.audio.play('static', { gain: 0.35, bus: 'ui', dur: 0.4 }); this.flashStatic(0.12); }
      }
    }
    // A rare scare out of nowhere, with a riser first: only once the figure has been seen, at most once an hour.
    if (this.figureSeen && this.phase === 'build' && t.sting <= 0 && this.pendingSting < 0 && u > 0.75 && Math.random() < dt / 60) {
      this.audio.duck(-14, 1.5, 0.8, 0.3);                     // the world goes quiet first
      this.audio.playAny('riser', 3, { gain: 0.35, bus: 'ui', delay: 0.6 });
      this.pendingSting = 2.4;
      t.sting = rand(3600, 5400);
    }
    if (this.pendingSting >= 0 && (this.pendingSting -= dt) < 0) this.stinger();
  }

  /** Plays big event `k` if the moment allows it. */
  private trigger(k: Major, i: HorrorInput): boolean {
    const cam = i.camera.position;
    switch (k) {
      case 'whisper': { // right behind you
        if (this.whisperVoice) return false;
        const pos = cam.clone().addScaledVector(this.fwd, -2.2).add(new THREE.Vector3(rand(-0.6, 0.6), 0.1, rand(-0.6, 0.6)));
        const v = Math.random() < 0.5
          ? this.audio.play('whisper', { pos, gain: 0.3, hrtf: true, offset: rand(0, 8), dur: rand(4, 7), fadeIn: 1.2 })
          : this.audio.playAny('vwhisper', 2, { pos, gain: 0.3, hrtf: true, fadeIn: 0.8 });
        if (!v) return false;
        this.whisperVoice = { gain: v.gain, pos };
        v.src.onended = () => { this.whisperVoice = null; };
        return true;
      }
      case 'breath': { // close, when it's very bad
        const pos = cam.clone().addScaledVector(this.fwd, -1.2);
        return !!this.audio.play('breathing', { pos, gain: 0.5, hrtf: true, offset: rand(0, 10), dur: rand(5, 8), fadeIn: 2 });
      }
      case 'memory': { // Earth: a farm, birds, people. It shouldn't be here, and it cuts off.
        if (this.memoryVoice) return false;
        const pool = ['earth_farm', 'earth_woods', 'earth_night', 'earth_rain'];
        const id = pool[Math.floor(Math.random() * pool.length)];
        const len = rand(6, 11);
        const v = this.audio.play(id, { gain: 0.6, fadeIn: 3, offset: rand(0, 10), bus: 'amb' });
        if (!v) return false;
        this.memoryVoice = { gain: v.gain, end: this.audio.ctx!.currentTime + len };
        v.src.stop(this.audio.ctx!.currentTime + len + 0.1);
        return true;
      }
      case 'figure': { // at the edge of your vision, once a night at most, never inside the fog's clear zone
        if (this.figure.visible || i.underground || this.figureNight === i.nights) return false;
        const side = Math.random() < 0.5 ? 1 : -1;
        const yaw = Math.atan2(this.fwd.x, this.fwd.z) + side * rand(0.9, 1.15); // ~55-65 degrees off centre
        const d = Math.max(i.fogNear, rand(16, 26));
        const p = new THREE.Vector3(cam.x + Math.sin(yaw) * d, 0, cam.z + Math.cos(yaw) * d);
        const g = i.ground(p.x, p.z);
        if (!g) return false;
        this.figure.position.set(p.x, g.y, p.z);
        this.figure.lookAt(cam.x, g.y, cam.z);
        this.figure.visible = true;
        this.figureLife = rand(6, 12);
        this.figureNight = i.nights;
        this.audio.play('rumble_1', { gain: 0.35, bus: 'amb' }); // felt more than heard
        return true;
      }
      case 'voice': // distant, female, ethereal, impossible
        return !!this.audio.playAny('voice', 3, { pos: this.around(cam, rand(25, 40), i.ground), gain: 0.45, fadeIn: 1.5 });
      case 'falseAlarm': // the world holds its breath... and nothing happens
        this.audio.duck(-14, 1.5, rand(3, 5), 2.5);
        this.audio.play('gasp', { gain: 0.35, bus: 'ui', delay: 1.4 });
        return true;
    }
  }

  private stinger() {
    this.pendingSting = -1;
    this.audio.duck(-10, 0.05, 0.4, 1.5);                     // everything else steps back under the hit
    const ids = ['sting_shadows', 'sting_from_below', 'sting_taken', 'sting_lights_out'];
    this.audio.play(ids[Math.floor(Math.random() * ids.length)], { gain: 0.9, bus: 'ui' });
    this.audio.play('subdrop', { gain: 0.4, bus: 'ui' });
    this.flashStatic(0.25);
    this.timers.sting = rand(3600, 5400); // at most one scare an hour
    this.phase = 'relax'; this.phaseT = rand(90, 150); // a longer calm stretch afterwards
    this.fire('sting');
  }

  /** Seconds of static flash left (the post pass turns it into grain and split colours). */
  staticT = 0;

  private flashStatic(seconds: number) {
    this.staticT = seconds;
    this.staticEl.style.opacity = '0.35';
    setTimeout(() => { this.staticEl.style.opacity = '0'; }, seconds * 1000);
  }

  /** Exposure multiplier for the renderer: the world dims a little as unease grows. */
  get exposure() { return 1 - smooth(0.3, 1, this.level) * 0.22; }
}
