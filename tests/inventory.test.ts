import { describe, it, expect } from 'vitest';
import { Inventory, BASE_SLOTS } from '../src/inventory';
import { RECIPES, knows } from '../src/crafting';

describe('inventory carry slots, weight and spoilage', () => {
  it('fills slots by stack and refuses what does not fit', () => {
    const inv = new Inventory();
    expect(inv.slots()).toBe(BASE_SLOTS);
    expect(inv.add('stone', 85)).toBe(80); // 8 slots x 10
    expect(inv.add('fiber', 1)).toBe(0);
    inv.add('fiber_pouch');
    expect(inv.slots()).toBe(BASE_SLOTS + 4);
    expect(inv.add('fiber', 200)).toBe(120);
    expect(inv.add('spear')).toBe(1); // tools never take slots
  });
  it('gets heavier and slower', () => {
    const inv = new Inventory();
    expect(inv.load_().name).toBe('Light');
    inv.add('stone', 50);
    expect(inv.load_().speed).toBeLessThan(1);
  });
  it('spoils the oldest meat first and eats oldest first', () => {
    const inv = new Inventory();
    inv.add('raw_meat', 1, 500); inv.add('raw_meat', 1);
    expect(inv.freshness('raw_meat')).toBe(100);
    expect(inv.tick(120)).toEqual(['raw_meat']);
    expect(inv.counts.raw_meat).toBe(1);
    inv.add('cooked_meat', 2); inv.take({ cooked_meat: 1 });
    expect(inv.ages.cooked_meat.length).toBe(1);
  });
  it('learns recipes from held items; old saves know everything', () => {
    const inv = new Inventory();
    inv.load(undefined);
    expect(RECIPES.some((r) => knows(r, inv.seen))).toBe(false);
    inv.add('fiber');
    expect(knows(RECIPES[0], inv.seen)).toBe(true);
    const old = new Inventory();
    old.load({ stone: 3 });
    expect(knows(RECIPES.find((r) => r.id === 'spear')!, old.seen)).toBe(true);
  });
});
