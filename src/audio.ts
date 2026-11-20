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
  ambShelf!: BiquadFilterNode;
  private world!: GainNode;
  private pause!: GainNode;          // 0 while a menu is open
  private paused = false;          // sfx + ambience pass through here so they can be ducked under scares
  private reverbIn!: GainNode;       // shared reverb send
  private reverbOpen!: GainNode;     // short, airy tail outdoors
  private reverbCave!: GainNode;     // long, dark tail underground
  private listenerPos = new THREE.Vector3();
  private voices = 0;                // live sample voices (voice limit)
  private perId = new Map<string, number>();
  private windGust = 0.5; private windTarget = 0.5; private windTimer = 0;
  private lastSet = { wind: -1, hum: -1, at: 0 };
  volumes = { master: 0.8, sfx: 1, ambience: 0.7, ui: 0.8 };
  /** Recorded sounds (Ocular Sounds library), decoded once the context exists. */
  private samples = new Map<string, { buf: AudioBuffer; gain: number }>();
  private sampleList: Record<string, { file: string; gain: number; loop: boolean }> | null = null;
  private loops: Loop[] = [];
  private packed = new Map<string, { data: ArrayBuffer; gain: number }>();
  private decoding = new Map<string, Promise<void>>();
  private lastUsed = new Map<string, number>();
  private sweep = 0;

  /** Call from a click handler. Safe to call repeatedly. */
  unlock() {
    if (this.ctx) { void this.ctx.resume(); return; }
    const ctx = new AudioContext();
    this.ctx = ctx;
    this.master = ctx.createGain();
    // Master limiter: catches peaks only, so quiet-to-loud contrast survives (horror needs the dynamic range).
    const lim = ctx.createDynamicsCompressor();
    lim.threshold.value = -3; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.003; lim.release.value = 0.25;
    this.master.connect(lim).connect(ctx.destination);
    // world -> pause -> master: the pause gain silences every game sound (not the UI) without touching the duck automation on world.
    this.pause = ctx.createGain();
    this.world = ctx.createGain(); this.world.connect(this.pause).connect(this.master);
    this.sfx = ctx.createGain(); this.amb = ctx.createGain(); this.ui = ctx.createGain();
    // Ambience low-shelf, flat by default: cutting the drones' low end measured cleaner but sounded thinner and less
    // ominous to Jorge (A/B at matched loudness, 2026-11-19). Keep the weight; adjust here only by ear.
    const ambShelf = this.ambShelf = ctx.createBiquadFilter(); ambShelf.type = 'lowshelf'; ambShelf.frequency.value = 160; ambShelf.gain.value = 0;
    this.sfx.connect(this.world); this.amb.connect(ambShelf).connect(this.world); this.ui.connect(this.master);
    // Shared reverb: two generated impulse responses (no files), crossfaded between open air and caves.
    this.reverbIn = ctx.createGain();
    const mkVerb = (seconds: number, damp: number, level: number) => {
      const conv = ctx.createConvolver();
      conv.buffer = this.impulse(seconds, damp);
      const g = ctx.createGain(); g.gain.value = level;
      this.reverbIn.connect(conv).connect(g).connect(this.world);
      return g;
    };
    this.reverbOpen = mkVerb(1.2, 0.55, 0.5);
    this.reverbCave = mkVerb(3.5, 0.3, 0);
    this.applyVolumes();
    this.pause.gain.value = this.paused ? 0 : 1;
    // One second of white noise, reused by every noisy sound.
    this.noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = this.noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.startAmbience();
    void this.loadSamples();
  }

  /** Fetches and decodes the recorded sounds in the background; the game plays without them until they arrive. */
  private async loadSamples() {
    try {
      const res = await fetch('audio/manifest.json');
      if (!res.ok) return;
      this.sampleList = await res.json();
      // Everything is fetched (6.7 MB compressed) but decoded audio is ~220 MB, two thirds of it in the long beds and
      // memories. Those stay compressed until needed and are dropped again after a minute unused.
      await Promise.all(Object.entries(this.sampleList!).map(async ([id, s]) => {
        try {
          const data = await (await fetch(s.file)).arrayBuffer();
          if (LAZY.test(id)) { this.packed.set(id, { data, gain: s.gain }); return; }
          this.samples.set(id, { buf: await this.ctx!.decodeAudioData(data), gain: s.gain });
        } catch { /* a missing sound just stays silent */ }
      }));
    } catch { /* no recorded sounds in this build */ }
  }

  has(id: string) { return this.samples.has(id) || this.packed.has(id); }

  /** Is this sound decoded and ready to play right now? */
  ready(id: string) { return this.samples.has(id); }

  /** Start decoding a lazy sound so it's ready when needed (keeps it for a minute). */
  prefetch(id: string) { this.buffer(id); }

  /** Decoded buffer for `id`, or null while a lazy sound is still decoding (the decode starts on the first ask). */
  private buffer(id: string) {
    const s = this.samples.get(id);
    if (s) { if (this.packed.has(id)) this.lastUsed.set(id, performance.now()); return s; }
    const p = this.packed.get(id);
    if (p && this.ctx && !this.decoding.has(id)) {
      const job = this.ctx.decodeAudioData(p.data.slice(0)) // decoding detaches its input: keep the packed copy
        .then((buf) => { this.samples.set(id, { buf, gain: p.gain }); this.lastUsed.set(id, performance.now()); })
        .catch(() => { this.packed.delete(id); })
        .finally(() => this.decoding.delete(id));
      this.decoding.set(id, job);
    }
    return null;
  }

  /** Drops decoded lazy sounds unused for a minute (they decode again in ~50 ms when next needed). */
  private evict() {
    const now = performance.now();
    for (const [id, t] of this.lastUsed) if (now - t > 60_000) { this.samples.delete(id); this.lastUsed.delete(id); }
  }
  get sampleCount() { return this.samples.size; }

  /** Plays a recorded sound once. offset/dur play a slice of a longer file. Returns the gain node (for fades) or null. */
  play(id: string, o: { pos?: V3; gain?: number; rate?: number; bus?: 'sfx' | 'ui' | 'amb'; hrtf?: boolean; offset?: number; dur?: number; fadeIn?: number; delay?: number } = {}) {
    const ctx = this.ctx;
    if (!ctx) return null;
    const s = this.buffer(id);
    // A lazy sound that isn't decoded yet starts decoding and this play is skipped: callers that care (the horror
    // director) prefetch ahead instead, so a sound never plays late, outside the pacing that asked for it.
    if (!s) return null;
    // Voice limit: at most 3 of the same sound and 32 overall (the UI is never dropped).
    const base = id.replace(/_\d+$/, '');
    if (o.bus !== 'ui' && ((this.perId.get(base) ?? 0) >= 3 || this.voices >= 32)) return null;
    this.voices++; this.perId.set(base, (this.perId.get(base) ?? 0) + 1);
    const t = ctx.currentTime + (o.delay ?? 0);
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    src.playbackRate.value = o.rate ?? 1;
    const g = ctx.createGain();
    const level = s.gain * (o.gain ?? 1);
    if (o.fadeIn) { g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(Math.max(0.0002, level), t + o.fadeIn); }
    else g.gain.value = level;
    src.connect(g).connect(this.out(o.bus === 'ui' ? this.ui : o.bus === 'amb' ? this.amb : this.sfx, o.pos, o.hrtf));
    // A bad offset/duration (NaN, negative) would throw in start() after the voice was counted, leaking a voice slot for
    // good: clamp, and undo the count if start still fails.
    const offset = Math.min(Math.max(0, Number.isFinite(o.offset) ? o.offset! : 0), Math.max(0, s.buf.duration - 0.01));
    if (o.dur !== undefined && !(o.dur > 0)) o = { ...o, dur: undefined };
    try {
    if (o.dur) {
      const end = t + o.dur / (o.rate ?? 1);
      g.gain.setValueAtTime(level, Math.max(t, end - 0.15));
      g.gain.linearRampToValueAtTime(0, end);
      src.start(t, offset, o.dur + 0.05);
    } else src.start(t, offset);
    } catch {
      this.voices--; this.perId.set(base, (this.perId.get(base) ?? 1) - 1);
      return null;
    }
    src.addEventListener('ended', () => { this.voices--; this.perId.set(base, (this.perId.get(base) ?? 1) - 1); });
    return { gain: g, src };
  }

  /** Picks one of several numbered variants (growl_1..growl_6). */
  playAny(prefix: string, n: number, o: Parameters<Audio['play']>[1] = {}) {
    return this.play(`${prefix}_${1 + Math.floor(Math.random() * n)}`, o);
  }

  /** A seamlessly crossfading loop whose level follows setLevel(). */
  loop(id: string, bus: 'amb' | 'sfx' = 'amb') {
    const l = new Loop(this, id, bus);
    this.loops.push(l);
    return l;
  }

  /** @internal used by Loop */
  startLoopVoice(id: string, out: GainNode, fade: number) {
    const s = this.buffer(id), ctx = this.ctx;
    if (!s || !ctx) return null;
    const src = ctx.createBufferSource();
    src.buffer = s.buf;
    const g = ctx.createGain();
    const t = ctx.currentTime;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(s.gain, t + fade);
    src.connect(g).connect(out);
    const offset = fade > 0.5 ? Math.random() * Math.max(0, s.buf.duration * 0.5) : 0;
    src.start(t, offset);
    return { src, g, startedAt: t, dur: s.buf.duration - offset };
  }

  /** @internal */
  busNode(bus: 'amb' | 'sfx') { return bus === 'amb' ? this.amb : this.sfx; }

  /** Exponentially decaying stereo noise with high frequencies dying faster: a cheap, convincing reverb tail. */
  private impulse(seconds: number, damp: number) {
    const ctx = this.ctx!, n = Math.floor(ctx.sampleRate * seconds);
    const buf = ctx.createBuffer(2, n, ctx.sampleRate);
    for (let c = 0; c < 2; c++) {
      const d = buf.getChannelData(c);
      let lp = 0;
      for (let i = 0; i < n; i++) {
        const t = i / n;
        const k = damp + (1 - damp) * t;            // the tail gets darker as it decays
        lp += (Math.random() * 2 - 1 - lp) * (1 - k * 0.9);
        d[i] = lp * Math.pow(1 - t, 3) * (i < ctx.sampleRate * 0.012 ? i / (ctx.sampleRate * 0.012) : 1);
      }
    }
    return buf;
  }

  /** 0 = open air, 1 = cave: crossfades the reverb character. */
  setSpace(cave: number) {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.reverbOpen.gain.setTargetAtTime(0.5 * (1 - cave), t, 0.8);
    this.reverbCave.gain.setTargetAtTime(0.9 * cave, t, 0.8);
  }

  /** Pulls the whole world (not the UI) down by `db` for a moment: silence before a scare, or under a stinger. */
  duck(db: number, attack: number, hold: number, release: number) {
    if (!this.ctx) return;
    const g = this.world.gain, t = this.ctx.currentTime, low = Math.pow(10, db / 20);
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(low, t + attack);
    g.setValueAtTime(low, t + attack + hold);
    g.linearRampToValueAtTime(1, t + attack + hold + release);
  }

  applyVolumes() {
    if (!this.ctx) return;
    this.master.gain.value = this.volumes.master * 1.75; // +5 dB makeup: measured night mix sat at -28.6 LUFS, target ~-23
    this.sfx.gain.value = this.volumes.sfx;
    this.amb.gain.value = this.volumes.ambience;
    this.ui.gain.value = this.volumes.ui;
  }

  /** Pause/resume with the game (menus mute the world, not the UI). */
  setWorldPaused(paused: boolean) {
    this.paused = paused;
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.pause.gain.cancelScheduledValues(t);
    this.pause.gain.setTargetAtTime(paused ? 0 : 1, t, 0.08);
  }

  /** Tab hidden: stop the audio clock entirely. Visible again: resume (menus stay muted by the pause gain). */
  suspend() { if (this.ctx?.state === 'running') void this.ctx.suspend(); }
  resume() { if (this.ctx && this.ctx.state === 'suspended') void this.ctx.resume(); }

  /** Move the listener with the camera. */
  updateListener(camera: THREE.Camera) {
    if (!this.ctx) return;
    const l = this.ctx.listener, p = camera.position;
    this.listenerPos.copy(p);
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

  /** Routes a voice to its bus. Positioned voices get panning, air absorption (darker with distance) and a reverb send
   *  that grows with distance, so far sounds read as far, not just quiet. HRTF only when asked (it is expensive). */
  private out(bus: GainNode, pos?: V3, hrtf = false) {
    const ctx = this.ctx!;
    if (!pos) return bus;
    const d = this.listenerPos.distanceTo(pos as THREE.Vector3);
    const p = ctx.createPanner();
    p.panningModel = hrtf ? 'HRTF' : 'equalpower';
    p.distanceModel = 'inverse';
    p.refDistance = 2.5; p.rolloffFactor = 1.1;
    p.positionX.value = pos.x; p.positionY.value = pos.y; p.positionZ.value = pos.z;
    p.connect(bus);
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = 18000 * Math.pow(2500 / 18000, Math.min(1, Math.max(0, (d - 5) / 55)));
    f.connect(p);
    if (bus !== this.ui) {
      const send = ctx.createGain();
      send.gain.value = Math.min(0.6, 0.08 + d / 90);
      f.connect(send).connect(this.reverbIn);
    }
    return f;
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

  private lastStep = '';
  /** Recorded foley footsteps (Ocular Carnage, picked by ear): moss = fungal forest floor, gravel = rocky slopes,
   *  soil = dug earth and caves (Nebula Audio dirt, with crouch/run sets). 8 variants each, never the same one twice in a row, small pitch/level variation. */
  footstep(run: boolean, sneak: boolean, surface: 'moss' | 'gravel' | 'soil') {
    if (!this.ctx) return;
    if (this.has(`step_${surface}_1`)) {
      // Surfaces with their own crouch/run recordings (soil: Nebula Audio) use them; gravel/moss (MGW) reuse the walk set.
      const mode = sneak ? 'crouch_' : run ? 'run_' : '';
      const own = mode !== '' && this.has(`step_${surface}_${mode}1`);
      const set = own ? `step_${surface}_${mode}` : `step_${surface}_`;
      let n = 1;
      while (this.has(`${set}${n + 1}`)) n++; // sets have 5 (MGW) or 8 (Nebula) variants
      let id = this.lastStep;
      while (id === this.lastStep && n > 1) id = `${set}${1 + Math.floor(Math.random() * n)}`;
      if (n === 1) id = `${set}1`;
      this.lastStep = id;
      const level = sneak ? (own ? 0.45 : 0.3) : run ? 0.85 : 0.6;
      this.play(id, { gain: level * Math.pow(10, (Math.random() * 2 - 1) * 1.5 / 20), rate: (run && !own ? 1.04 : 1) * (1 + (Math.random() * 2 - 1) * 0.04) });
      return;
    }
    const rocky = surface === 'gravel';
    const g = sneak ? 0.07 : run ? 0.26 : 0.18;
    this.noiseHit({ dur: 0.09, type: 'lowpass', freq: this.vary(rocky ? 1500 : 700), q: 0.8, gain: g });
    if (rocky) this.noiseHit({ dur: 0.03, type: 'bandpass', freq: 2200, q: 1.5, gain: g * 0.15, delay: 0.005 });
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
    if (this.has('tuko_1')) { // a glitchy electronic chitter, pitched up: small and alien
      const v = this.playAny('tuko', 4, { pos, gain: 0.7, rate: 1.7 + Math.random() * 0.7, dur: 0.25 + Math.random() * 0.2 });
      if (v && Math.random() < 0.5) this.playAny('tuko', 4, { pos, gain: 0.5, rate: 2 + Math.random() * 0.5, dur: 0.18, delay: 0.16 });
      return;
    }
    this.tone({ dur: 0.07, freq: this.vary(1900, 0.08), freqEnd: 2700, gain: 0.07, pos, hrtf: true });
    this.tone({ dur: 0.07, freq: this.vary(2100, 0.08), freqEnd: 3000, gain: 0.06, pos, delay: 0.11, hrtf: true });
  }

  oomiHoot(pos: V3, sleepy: boolean) {
    if (this.has('oomi_1')) { // a big, soft, slowed-down horn: large and gentle
      this.playAny('oomi', 3, { pos, gain: sleepy ? 0.6 : 1.1, rate: sleepy ? 0.45 : 0.6 + Math.random() * 0.12, dur: sleepy ? 2.5 : 1.6, fadeIn: 0.15 });
      return;
    }
    this.tone({ dur: sleepy ? 0.9 : 0.55, freq: this.vary(sleepy ? 150 : 230, 0.06), freqEnd: sleepy ? 120 : 170, gain: sleepy ? 0.08 : 0.16, vibrato: 6, attack: 0.08, pos, hrtf: true });
  }

  fireCrackle(pos: V3, strength: number) {
    if (this.voices > 24) return; // several fires crackling must not crowd out the recorded sounds
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

  /** Called each frame by the game to keep loops crossfading. */
  updateLoops() {
    for (const l of this.loops) l.tick();
    if (++this.sweep % 600 === 0) this.evict();
  }

  /** Called each frame: wind follows the time of day and altitude; insects chirp at night. */
  updateAmbience(dt: number, night: number, altitude: number, listener: V3) {
    if (!this.ctx || !this.wind || !this.hum) return;
    const t = this.ctx.currentTime;
    // Gusts wander toward random targets instead of a repeating sine pattern.
    if ((this.windTimer -= dt) <= 0) { this.windTimer = 2 + Math.random() * 6; this.windTarget = Math.random() < 0.15 ? 0.95 : Math.random() * 0.6; }
    this.windGust += (this.windTarget - this.windGust) * Math.min(1, dt * 0.6);
    const gust = this.windGust;
    this.nightLevel = night;
    if (t - this.lastSet.at >= 0.2) { // automation every 0.2 s, not every frame
      this.lastSet.at = t;
      const windLevel = (0.04 + gust * 0.09) * (1 + Math.max(0, altitude - 25) / 40) * (1 - night * 0.4);
      this.wind.gain.gain.setTargetAtTime(windLevel, t, 0.5);
      this.wind.filter.frequency.setTargetAtTime(280 + gust * 600, t, 0.8);
      this.hum.gain.setTargetAtTime(0.02 + night * 0.06, t, 1);
    }
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

/** A looping bed that crossfades into a fresh copy of itself before the file ends, so short recordings never click or gap. */
/** Long, occasional sounds kept compressed until used: ambience beds, Earth memories, cave drips. */
const LAZY = /^(bed_|earth_|drips$)/;

export class Loop {
  private out: GainNode | null = null;
  private voices: { src: AudioBufferSourceNode; g: GainNode; startedAt: number; dur: number }[] = [];
  private level = 0;
  constructor(private audio: Audio, private id: string, private bus: 'amb' | 'sfx') {}

  /** Target level 0..1 (smoothed over `tc` seconds). */
  setLevel(level: number, tc = 1.5) {
    if (this.out && Math.abs(level - this.level) < 0.01) return; // don't pile up automation every frame
    this.level = level;
    const ctx = this.audio.ctx;
    if (!ctx) return;
    if (!this.out) { this.out = ctx.createGain(); this.out.gain.value = 0; this.out.connect(this.audio.busNode(this.bus)); }
    this.out.gain.setTargetAtTime(level, ctx.currentTime, tc);
  }

  tick() {
    const ctx = this.audio.ctx;
    if (!ctx || !this.out) return;
    const now = ctx.currentTime;
    // Silent for a while: stop the voices to save work; they restart when the level comes back.
    if (this.level < 0.002 && this.out.gain.value < 0.002) {
      for (const v of this.voices) v.src.stop();
      this.voices = [];
      return;
    }
    const cur = this.voices[this.voices.length - 1];
    const fade = 2.5;
    if (!cur) {
      const v = this.audio.startLoopVoice(this.id, this.out, 0.1);
      if (v) this.voices.push(v);
      return;
    }
    const remaining = cur.dur - (now - cur.startedAt);
    if (remaining < Math.min(fade, cur.dur / 3)) {
      const f = Math.min(fade, cur.dur / 3);
      cur.g.gain.cancelScheduledValues(now);
      cur.g.gain.setValueAtTime(cur.g.gain.value, now);
      cur.g.gain.linearRampToValueAtTime(0, now + f);
      cur.src.stop(now + f + 0.05);
      const v = this.audio.startLoopVoice(this.id, this.out, f);
      if (v) this.voices.push(v);
      setTimeout(() => { this.voices = this.voices.filter((x) => x !== cur); }, (f + 0.2) * 1000);
    }
  }
}
