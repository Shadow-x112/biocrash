// Save-layer safety: damaged or hostile data must be cleaned, never crash the game.
import { describe, it, expect } from 'vitest';
import { sanitizeMeta } from '../src/save';

describe('sanitizeMeta', () => {
  it('rejects saves without a usable core', () => {
    expect(sanitizeMeta(null)).toBeNull();
    expect(sanitizeMeta({ seed: 5, saveVersion: 2, genVersion: 1 })).toBeNull();
    expect(sanitizeMeta({ seed: 'a', saveVersion: 'x', genVersion: 1 })).toBeNull();
  });
  it('drops bad fields and clamps numbers', () => {
    const m = sanitizeMeta({
      seed: 'abc', saveVersion: 2, genVersion: 1, savedAt: 1, player: { x: 'q' }, picked: 5, tutorialStep: 'x',
      vitals: { health: NaN, warmth: 500 }, inventory: { stone: -4, fiber: 'lots', toString: 3 },
      campfires: [null, { x: 'a' }, { x: 1, y: 2, z: 3, fuel: 'z', cooking: [1, 'b', 99] }],
      packs: Array.from({ length: 60 }, (_, i) => ({ x: i, y: 0, z: 0, items: { stone: 1 } })),
      lamp: 900, nights: -3, horror: { figureSeen: 'yes', played: ['memory', 7], last: 'figure' },
    })!;
    expect(m.player).toBeNull();
    expect(m.picked).toBeUndefined();
    expect(m.tutorialStep).toBeUndefined();
    expect(m.vitals).toEqual({ health: 100, warmth: 100, fed: 0, afterglow: 0 });
    expect(m.inventory!.stone).toBe(0);
    expect(m.inventory!.fiber).toBeUndefined();
    expect(m.campfires).toEqual([{ x: 1, y: 2, z: 3, fuel: 0, cooking: [1, 60] }]);
    expect(m.packs!.length).toBe(50);
    expect(m.lamp).toBe(100);
    expect(m.nights).toBe(0);
    expect(m.horror).toEqual({ figureSeen: false, figureNight: -1, played: ['memory'], last: 'figure' });
  });
});

describe('crate and food saves', () => {
  it('keeps crates, meat ages and seen items, clamping junk', async () => {
    const { sanitizeMeta } = await import('../src/save');
    const m = sanitizeMeta({ seed: 's', saveVersion: 2, genVersion: 1, crates: [{ x: 1, y: 2, z: 3, rot: 0.5, items: { stone: 4, bad: 'x' }, fresh: { raw_meat: [10, 'q'] } }, null], fresh: { raw_meat: [5] }, seen: ['stone', 7] });
    expect(m?.crates).toEqual([{ x: 1, y: 2, z: 3, rot: 0.5, items: { stone: 4 }, fresh: { raw_meat: [10] } }]);
    expect(m?.fresh).toEqual({ raw_meat: [5] });
    expect(m?.seen).toEqual(['stone']);
  });
});
