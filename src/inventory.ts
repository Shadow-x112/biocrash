// Carried resources and tools. M1 keeps it to stack counts; slots, weight and storage come later.
export type ItemId = 'stone' | 'stalkwood' | 'fiber' | 'cordage' | 'chitin' | 'hide' | 'bone' | 'raw_meat' | 'cooked_meat'
  | 'stone_pick' | 'stone_knife' | 'spear' | 'bone_needle' | 'hide_wrap' | 'chitin_spearhead';
export type Cost = Partial<Record<ItemId, number>>;

export const ITEM_NAMES: Record<ItemId, string> = {
  stone: 'Stone',
  stalkwood: 'Stalkwood',
  fiber: 'Fiber',
  cordage: 'Cordage',
  chitin: 'Chitin',
  hide: 'Hide',
  bone: 'Bone',
  raw_meat: 'Raw meat',
  cooked_meat: 'Cooked meat',
  bone_needle: 'Bone needle',
  hide_wrap: 'Hide wrap',
  chitin_spearhead: 'Chitin spearhead',
  stone_pick: 'Stone pick',
  stone_knife: 'Stone knife',
  spear: 'Spear',
};

/** Materials show in the inventory panel; tools live on the hotbar. */
export const MATERIALS: ItemId[] = ['stone', 'stalkwood', 'fiber', 'cordage', 'chitin', 'hide', 'bone', 'raw_meat', 'cooked_meat'];
export const TOOLS: ItemId[] = ['stone_pick', 'stone_knife', 'spear'];
/** Kept for good once made (never dropped on death): worn or fitted gear and the needle. */
export const GEAR: ItemId[] = ['bone_needle', 'hide_wrap', 'chitin_spearhead'];

export class Inventory {
  readonly counts: Record<ItemId, number> = {
    stone: 0, stalkwood: 0, fiber: 0, cordage: 0, chitin: 0, hide: 0, bone: 0, raw_meat: 0, cooked_meat: 0,
    stone_pick: 0, stone_knife: 0, spear: 0, bone_needle: 0, hide_wrap: 0, chitin_spearhead: 0,
  };
  onChange: () => void = () => {};

  add(id: ItemId, n = 1) { this.counts[id] += n; this.onChange(); }

  has(cost: Cost) {
    return (Object.keys(cost) as ItemId[]).every((k) => this.counts[k] >= (cost[k] ?? 0));
  }

  take(cost: Cost) {
    if (!this.has(cost)) return false;
    for (const k of Object.keys(cost) as ItemId[]) this.counts[k] -= cost[k] ?? 0;
    this.onChange();
    return true;
  }

  load(c: Partial<Record<string, number>> | undefined) {
    if (c) for (const k of Object.keys(this.counts) as ItemId[]) this.counts[k] = c[k] ?? 0;
    this.onChange();
  }
}
