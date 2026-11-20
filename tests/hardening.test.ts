// Guards added in the hardening pass: bad settings are clamped, dropped packs can't pile up without limit.
import { describe, it, expect, beforeAll } from 'vitest';
import * as THREE from 'three';

beforeAll(() => {
  const store = new Map<string, string>();
  (globalThis as unknown as { localStorage: unknown }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v); },
  };
});

describe('settings', () => {
  it('clamps out-of-range and non-finite values', async () => {
    localStorage.setItem('biocrash-settings', JSON.stringify({ resolution: 0, fov: 5000, uiScale: -1, sensitivity: null, master: 'loud', captions: true }));
    const { loadSettings, DEFAULTS } = await import('../src/settings');
    const s = loadSettings();
    expect(s.resolution).toBe(0.5);
    expect(s.fov).toBe(100);
    expect(s.uiScale).toBe(0.8);
    expect(s.sensitivity).toBe(DEFAULTS.sensitivity);
    expect(s.master).toBe(DEFAULTS.master);
    expect(s.captions).toBe(true);
  });
});

describe('packs', () => {
  it('caps at 20 by merging the oldest pack into the newest', async () => {
    const { Packs } = await import('../src/packs');
    const p = new Packs();
    for (let i = 0; i < 25; i++) p.add(new THREE.Vector3(i, 0, 0), { stone: 1 });
    expect(p.list.length).toBe(20);
    const total = p.list.reduce((a, pk) => a + (pk.items.stone ?? 0), 0);
    expect(total).toBe(25); // nothing lost
  });
});
