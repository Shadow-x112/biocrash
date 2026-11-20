// Horror director: the event deck must keep cycling for every kind of player, and a sound that isn't ready must never
// play late, outside the pacing.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';

beforeAll(() => {
  const el = () => ({ style: {} as Record<string, string> });
  (globalThis as unknown as { document: unknown }).document = { getElementById: el };
});

/** Fake audio: everything "plays" except lazy sounds that were never prefetched. */
function fakeAudio(lazyReady = false) {
  const decoded = new Set<string>();
  const ctx = { currentTime: 0 };
  const live: { end: number; src: { onended: null | (() => void) } }[] = [];
  const voice = () => {
    const v = { gain: { gain: { value: 1, cancelScheduledValues() {}, setValueAtTime() {}, linearRampToValueAtTime() {} } }, src: { stop() {}, onended: null as null | (() => void) } };
    live.push({ end: ctx.currentTime + 8, src: v.src });
    return v;
  };
  return {
    ctx,
    /** Advance the fake audio clock; sounds end after 8 s. */
    tick(dt: number) {
      ctx.currentTime += dt;
      for (let i = live.length - 1; i >= 0; i--) if (live[i].end <= ctx.currentTime) { live[i].src.onended?.(); live.splice(i, 1); }
    },
    played: [] as string[],
    loop: () => ({ setLevel() {} }),
    setSpace() {}, duck() {},
    ready(id: string) { return lazyReady || decoded.has(id); },
    prefetch(id: string) { decoded.add(id); },
    play(id: string) {
      if (id.startsWith('earth_') && !this.ready(id)) return null;
      this.played.push(id); return voice();
    },
    playAny(p: string) { this.played.push(p); return voice(); },
  };
}

async function run(opts: { nightsTo: number; unease: number | null; seconds: number; camp?: boolean; fireNear?: number }) {
  const { Horror } = await import('../src/horror');
  const audio = fakeAudio();
  const h = new Horror(audio as never, new THREE.Scene());
  const cam = new THREE.PerspectiveCamera();
  const counts: Record<string, number> = {};
  for (let n = 0; n <= opts.nightsTo; n++) {
    h.override = opts.unease;
    for (let t = 0; t < opts.seconds; t += 0.5) {
      h.update({ dt: 0.5, camera: cam, night: 1, daylight: 0, fireNear: opts.fireNear ?? 0, warmth: 80, health: 100, underground: false,
        ground: () => ({ y: 0, ny: 1 }), crashSite: new THREE.Vector3(100, 0, 0), nights: n, running: false, moving: true,
        litFiresNear: 0, fogNear: 20, camp: opts.camp ? new THREE.Vector3(0, 0, 0) : null });
      audio.tick(0.5);
    }
  }
  for (const [k, v] of Object.entries(h.fired)) counts[k] = v;
  counts.finalLevel = h.level;
  return counts;
}

describe('horror deck', () => {
  it('keeps cycling for a cautious player (unease below the strongest cards)', async () => {
    const c = await run({ nightsTo: 9, unease: 0.52, seconds: 600 });
    // memory (0.5) and whisper (0.45) are the only cards this player qualifies for: both must keep coming back.
    expect(c.memory ?? 0).toBeGreaterThan(3);
    expect(c.whisper ?? 0).toBeGreaterThan(3);
  });
  it('plays every unlocked card for a bold player, figure included', async () => {
    const c = await run({ nightsTo: 6, unease: 0.9, seconds: 600 });
    for (const k of ['memory', 'whisper', 'breath', 'voice', 'falseAlarm', 'figure']) expect(c[k] ?? 0, k).toBeGreaterThan(0);
  });
  it('never fires a big event on the first night', async () => {
    const c = await run({ nightsTo: 0, unease: 0.95, seconds: 900 });
    for (const k of ['memory', 'whisper', 'breath', 'voice', 'falseAlarm', 'figure']) expect(c[k] ?? 0, k).toBe(0);
  });
});

describe('camp nights', () => {
  it('keeps some unease and camp events going beside the fire from night 2', async () => {
    const c = await run({ nightsTo: 4, unease: null, seconds: 700, camp: true, fireNear: 1 });
    expect(c.finalLevel).toBeGreaterThan(0.15); // the night floor, even at a full fire
    expect((c.eyes ?? 0) + (c.circle ?? 0) + (c.gutter ?? 0)).toBeGreaterThan(3);
  });
  it('leaves the first night at the fire calm', async () => {
    const c = await run({ nightsTo: 0, unease: null, seconds: 700, camp: true, fireNear: 1 });
    expect((c.eyes ?? 0) + (c.circle ?? 0) + (c.gutter ?? 0)).toBe(0);
  });
});
