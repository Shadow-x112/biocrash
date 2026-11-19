// All game sound, synthesized at runtime with Web Audio: no audio files to download or license.
// Buses: master -> (sfx, ambience, ui). The context starts on the first click (browser autoplay rules).
import * as THREE from 'three';

type V3 = { x: number; y: number; z: number };

export class Audio {
  ctx: AudioContext | null = null;
  private master!: GainNode;
  private sfx!: GainNode;
  private amb!: GainNode;
  private ui!: GainNode;
  private noise!: AudioBuffer;
  private wind?: { gain: GainNode; filter: BiquadFilterNode };
  private hum?: GainNode;
  private nightLevel = 0;
  private insectTimer = 0;
  private last = new Map<string, number>(); // per-sound cooldowns
  volumes = { master: 0.8, sfx: 1, ambience: 0.7, ui: 0.8 };

  /** Call from a click handler. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    const comp = ctx.createDynamicsCompressor(); // keeps stacked sounds from clipping
    comp.threshold.value = -14; comp.ratio.value = 4;
    this.master.connect(comp).connect(ctx.destination);
    this.sfx = ctx.createGain(); this.amb = ctx.createGain(); this.ui = ctx.createGain();
    this.sfx.connect(this.master); this.amb.connect(this.master); this.ui.connect(this.master);
    this.applyVolumes();
    // One second of white noise, reused by every noisy sound.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master;
    this.sfx.gain.value = this.volumes.sfx;
    this.amb.gain.value = this.volumes.ambience;
    this.ui.gain.value = this.volumes.ui;
  }

  /** Pause/resume with the game (menus mute the world, not the UI). */
  setWorldPaused(paused: boolean) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.amb.gain.setTargetAtTime(paused ? 0 : this.volumes.ambience, t, 0.1);
  }

  /** Move the listener with the camera. */
  updateListener(camera: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener, p = camera.position;
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion);
    const u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    if (l.positionX) {
      const t = this.ctx.currentTime;
      l.positionX.setValueAtTime(p.x, t); l.positionY.setValueAtTime(p.y, t); l.positionZ.setValueAtTime(p.z, t);
      l.forwardX.setValueAtTime(f.x, t); l.forwardY.setValueAtTime(f.y, t); l.forwardZ.setValueAtTime(f.z, t);
      l.upX.setValueAtTime(u.x, t); l.upY.setValueAtTime(u.y, t); l.upZ.setValueAtTime(u.z, t);
    } else {
      l.setPosition(p.x, p.y, p.z);
      l.setOrientation(f.x, f.y, f.z, u.x, u.y, u.z);
    }
  }

  // --- Building blocks ---------------------------------------------------------------------------

  private out(bus: GainNode, pos?: V3, hrtf = false) {
    if (!pos) return bus;
    const p = this.ctx!.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 2; p.maxDistance = 60; p.rolloffFactor = 1.3;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    p.connect(bus);
    return p;
  }

  private canPlay(key: string, gap: number) {
    const now = this.ctx!.currentTime, t = this.last.get(key) ?? -1;
    if (now - t < gap) return false;
    this.last.set(key, now);
    return true;
  }

  /** A filtered noise burst with an attack/decay envelope. */
  noiseHit(o: { dur: number; type: BiquadFilterType; freq: number; freqEnd?: number; q?: number; gain: number; attack?: number; bus?: 'sfx' | 'ui' | 'amb'; pos?: V3; delay?: number; rate?: number }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = o.rate ?? 1;
    const f = ctx.createBiquadFilter();
    f.type = o.type; f.Q.value = o.q ?? 1;
    f.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) f.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
    const g = ctx.createGain();
    const a = o.attack ?? 0.004;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Number.isFinite(o.gain) ? Math.max(0.0002, o.gain) : 0.0002, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    src.connect(f).connect(g).connect(this.out(o.bus === 'ui' ? this.ui : o.bus === 'amb' ? this.amb : this.sfx, o.pos));
    src.start(t, Math.random() * 0.8);
    src.stop(t + o.dur + 0.05);
  }

  /** An oscillator blip with a pitch glide. */
  tone(o: { dur: number; freq: number; freqEnd?: number; type?: OscillatorType; gain: number; attack?: number; bus?: 'sfx' | 'ui' | 'amb'; pos?: V3; delay?: number; vibrato?: number; hrtf?: boolean }) {
    const ctx = this.ctx;
    if (!ctx) return;
    const t = ctx.currentTime + (o.delay ?? 0);
    const osc = ctx.createOscillator();
    osc.type = o.type ?? 'sine';
    osc.frequency.setValueAtTime(o.freq, t);
    if (o.freqEnd) osc.frequency.exponentialRampToValueAtTime(o.freqEnd, t + o.dur);
    if (o.vibrato) {
      const lfo = ctx.createOscillator(), lg = ctx.createGain();
      lfo.frequency.value = 6; lg.gain.value = o.vibrato;
      lfo.connect(lg).connect(osc.frequency);
      lfo.start(t); lfo.stop(t + o.dur + 0.05);
    }
    const g = ctx.createGain();
    const a = o.attack ?? 0.005;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Number.isFinite(o.gain) ? Math.max(0.0002, o.gain) : 0.0002, t + a);
    g.gain.exponentialRampToValueAtTime(0.0001, t + o.dur);
    osc.connect(g).connect(this.out(o.bus === 'ui' ? this.ui : o.bus === 'amb' ? this.amb : this.sfx, o.pos, o.hrtf));
    osc.start(t);
    osc.stop(t + o.dur + 0.05);
  }

  // --- Game sounds ---------------------------------------------------------------------------------
  // Every call varies pitch and level a little so repeats never sound identical.

  private vary(x: number, amount = 0.12) { return x * (1 + (Math.random() * 2 - 1) * amount); }

  footstep(run: boolean, sneak: boolean, rocky: boolean) {
    if (!this.ctx) return;
    const g = sneak ? 0.07 : run ? 0.26 : 0.18;
    this.noiseHit({ dur: 0.09, type: 'lowpass', freq: this.vary(rocky ? 1500 : 700), q: 0.8, gain: g });
    if (rocky) this.noiseHit({ dur: 0.03, type: 'highpass', freq: 3500, gain: g * 0.35, delay: 0.005 });
  }

  land(strength: number) {
    this.noiseHit({ dur: 0.18, type: 'lowpass', freq: 380, gain: Math.min(0.55, 0.2 + strength * 0.05) });
    this.tone({ dur: 0.14, freq: 90, freqEnd: 50, gain: Math.min(0.4, strength * 0.04) });
  }

  jump() { this.noiseHit({ dur: 0.08, type: 'bandpass', freq: 500, q: 0.7, gain: 0.08 }); }

  dig(pos: V3, strong: boolean) {
    if (!this.ctx || !this.canPlay('dig', 0.08)) return;
    this.noiseHit({ dur: strong ? 0.16 : 0.22, type: 'lowpass', freq: this.vary(strong ? 900 : 500), freqEnd: 180, q: 1.5, gain: strong ? 0.38 : 0.26, pos });
    this.noiseHit({ dur: 0.06, type: 'bandpass', freq: this.vary(strong ? 2600 : 1600), q: 2, gain: strong ? 0.16 : 0.06, pos }); // crunch
  }

  fill(pos: V3) {
    if (!this.ctx || !this.canPlay('fill', 0.08)) return;
    this.noiseHit({ dur: 0.25, type: 'lowpass', freq: this.vary(350), q: 0.7, gain: 0.22, attack: 0.04, pos });
  }

  pickup(kind: string) {
    const base = kind === 'stone' ? 520 : kind === 'stalkwood' ? 420 : 680;
    this.tone({ dur: 0.08, freq: this.vary(base, 0.05), freqEnd: base * 1.5, type: 'triangle', gain: 0.12, bus: 'ui' });
    this.noiseHit({ dur: 0.05, type: kind === 'stone' ? 'bandpass' : 'highpass', freq: kind === 'stone' ? 1800 : 2500, q: 2, gain: 0.08 });
  }

  chop(pos: V3) {
    this.noiseHit({ dur: 0.12, type: 'bandpass', freq: this.vary(1100), q: 3, gain: 0.3, pos });
    this.tone({ dur: 0.1, freq: this.vary(220), freqEnd: 140, type: 'triangle', gain: 0.12, pos });
  }

  craft() {
    this.tone({ dur: 0.12, freq: 660, type: 'triangle', gain: 0.12, bus: 'ui' });
    this.tone({ dur: 0.2, freq: 990, type: 'triangle', gain: 0.1, bus: 'ui', delay: 0.08 });
  }

  click() { this.tone({ dur: 0.04, freq: 1400, type: 'square', gain: 0.03, bus: 'ui' }); }

  deny() { this.tone({ dur: 0.12, freq: 220, freqEnd: 180, type: 'square', gain: 0.04, bus: 'ui' }); }

  hit(pos: V3, kill: boolean) {
    this.tone({ dur: kill ? 0.3 : 0.14, freq: kill ? 160 : 140, freqEnd: 45, gain: 0.45, pos });
    this.noiseHit({ dur: 0.08, type: 'bandpass', freq: 900, q: 1.2, gain: 0.3, pos });
  }

  swing() { this.noiseHit({ dur: 0.12, type: 'bandpass', freq: 800, freqEnd: 2400, q: 1.5, gain: 0.05 }); }

  shellClack(pos: V3) {
    this.noiseHit({ dur: 0.05, type: 'highpass', freq: 3000, gain: 0.35, pos });
    this.tone({ dur: 0.06, freq: 1900, type: 'square', gain: 0.05, pos });
  }

  tukoChirp(pos: V3) {
    this.tone({ dur: 0.07, freq: this.vary(1900, 0.08), freqEnd: 2700, gain: 0.07, pos, hrtf: true });
    this.tone({ dur: 0.07, freq: this.vary(2100, 0.08), freqEnd: 3000, gain: 0.06, pos, delay: 0.11, hrtf: true });
  }

  oomiHoot(pos: V3, sleepy: boolean) {
    this.tone({ dur: sleepy ? 0.9 : 0.55, freq: this.vary(sleepy ? 150 : 230, 0.06), freqEnd: sleepy ? 120 : 170, gain: sleepy ? 0.08 : 0.16, vibrato: 6, attack: 0.08, pos, hrtf: true });
  }

  fireCrackle(pos: V3, strength: number) {
    this.noiseHit({ dur: 0.02 + Math.random() * 0.03, type: 'highpass', freq: this.vary(2500, 0.4), gain: 0.06 + strength * 0.12, pos });
  }

  fireLit(pos: V3) {
    this.noiseHit({ dur: 0.6, type: 'bandpass', freq: 300, freqEnd: 1600, q: 0.8, gain: 0.25, attack: 0.1, pos });
  }

  heartbeat() {
    this.tone({ dur: 0.12, freq: 70, freqEnd: 45, gain: 0.35, bus: 'ui' });
    this.tone({ dur: 0.12, freq: 65, freqEnd: 42, gain: 0.25, bus: 'ui', delay: 0.22 });
  }

  shiverBreath() { this.noiseHit({ dur: 0.9, type: 'bandpass', freq: 1300, freqEnd: 700, q: 0.9, gain: 0.05, attack: 0.25, bus: 'ui' }); }

  death() { this.tone({ dur: 2.2, freq: 220, freqEnd: 55, gain: 0.18, attack: 0.1, bus: 'ui', type: 'triangle' }); }

  // --- Ambience ------------------------------------------------------------------------------------

  private startAmbience() {
    const ctx = this.ctx!;
    // Wind: looping noise through a slowly wandering band-pass.
    const src = ctx.createBufferSource();
    src.buffer = this.noise; src.loop = true;
    const filter = ctx.createBiquadFilter();
    filter.type = 'bandpass'; filter.frequency.value = 420; filter.Q.value = 0.6;
    const gain = ctx.createGain(); gain.gain.value = 0;
    src.connect(filter).connect(gain).connect(this.amb);
    src.start();
    this.wind = { gain, filter };
    // Low forest hum, strongest at night.
    const hsrc = ctx.createBufferSource();
    hsrc.buffer = this.noise; hsrc.loop = true; hsrc.playbackRate.value = 0.5;
    const hf = ctx.createBiquadFilter(); hf.type = 'lowpass'; hf.frequency.value = 140;
    this.hum = ctx.createGain(); this.hum.gain.value = 0;
    hsrc.connect(hf).connect(this.hum).connect(this.amb);
    hsrc.start();
  }

  /** Called each frame: wind follows the time of day and altitude; insects chirp at night. */
  updateAmbience(dt: number, night: number, altitude: number, listener: V3) {
    if (!this.ctx || !this.wind || !this.hum) return;
    const t = this.ctx.currentTime;
    const gust = 0.5 + 0.5 * Math.sin(t * 0.23) * Math.sin(t * 0.071 + 1.3);
    const windLevel = (0.04 + gust * 0.08) * (1 + Math.max(0, altitude - 25) / 40) * (1 - night * 0.4);
    this.wind.gain.gain.setTargetAtTime(windLevel, t, 0.5);
    this.wind.filter.frequency.setTargetAtTime(300 + gust * 500, t, 0.8);
    this.nightLevel = night;
    this.hum.gain.setTargetAtTime(0.02 + night * 0.06, t, 1);
    if (night > 0.5 && (this.insectTimer -= dt) <= 0) {
      this.insectTimer = 0.4 + Math.random() * 1.6;
      const a = Math.random() * Math.PI * 2, d = 8 + Math.random() * 20;
      const pos = { x: listener.x + Math.cos(a) * d, y: listener.y + Math.random() * 4, z: listener.z + Math.sin(a) * d };
      const f = 3200 + Math.random() * 1400;
      for (let i = 0; i < 3 + Math.floor(Math.random() * 4); i++)
        this.tone({ dur: 0.035, freq: f, gain: 0.025 * this.nightLevel, bus: 'amb', pos, delay: i * 0.06 });
    }
  }
}
