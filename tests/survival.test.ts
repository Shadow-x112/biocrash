import { describe, it, expect } from 'vitest';
import * as THREE from 'three';
import { Survival } from '../src/survival';

const ctx = (blocked: boolean) => ({
  eye: new THREE.Vector3(0, 1.6, 0), sunDir: new THREE.Vector3(0, -1, 0), daylight: 0, roof: () => false,
  blocked: () => blocked, ground: () => ({ y: 0 }),
});

describe('survival heat', () => {
  it('a fire behind a wall does not warm you', () => {
    for (const wall of [false, true]) {
      const s = new Survival();
      s.heatSources.push({ position: new THREE.Vector3(2, 0.6, 0), radius: 8, heatC: 62 });
      for (let i = 0; i < 200; i++) s.update(0.1, ctx(wall));
      if (wall) expect(s.ambientC).toBeLessThan(-5); else expect(s.ambientC).toBeGreaterThan(20);
    }
  });
});
