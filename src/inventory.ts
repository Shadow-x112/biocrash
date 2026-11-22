// Carried resources and tools. Materials fill carry slots (stacks), everything has weight, and meat goes off.
export type ItemId = 'stone' | 'stalkwood' | 'fiber' | 'cordage' | 'chitin' | 'hide' | 'bone' | 'raw_meat' | 'cooked_meat'
  | 'stone_pick' | 'stone_knife' | 'spear' | 'bone_needle' | 'hide_wrap' | 'chitin_spearhead' | 'fiber_pouch' | 'hide_pack'
  /** Placed, never carried: crafting it starts placement. */
  | 'crate' | 'flare' | 'solar'
  /** Station tech gear (learned from data chips). */
  | 'lamp_cell';
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
  fiber_pouch: 'Fiber pouch',
  hide_pack: 'Hide pack',
  crate: 'Storage crate',
  flare: 'Signal flare',
  solar: 'Solar panel',
  lamp_cell: 'Lamp power cell',
  stone_pick: 'Stone pick',
  stone_knife: 'Stone knife',
  spear: 'Spear',
};

/** Materials show in the inventory panel and take carry slots; tools live on the hotbar. */
export const MATERIALS: ItemId[] = ['stone', 'stalkwood', 'fiber', 'cordage', 'chitin', 'hide', 'bone', 'raw_meat', 'cooked_meat'];
export const TOOLS: ItemId[] = ['stone_pick', 'stone_knife', 'spear'];
/** Kept for good once made (never dropped on death): worn or fitted gear, the needle and the bags. */
export const GEAR: ItemId[] = ['bone_needle', 'hide_wrap', 'chitin_spearhead', 'fiber_pouch', 'hide_pack', 'lamp_cell'];

/** How many of a material share one carry slot. */
export const STACK: Partial<Record<ItemId, number>> = {
  stone: 10, stalkwood: 10, fiber: 30, cordage: 15, chitin: 8, hide: 5, bone: 10, raw_meat: 5, cooked_meat: 5,
};
/** Kilograms each. Tools and bags count too; the needle and wrap are too light to matter. */
export const WEIGHT: Partial<Record<ItemId, number>> = {
  stone: 1.0, stalkwood: 0.7, fiber: 0.05, cordage: 0.1, chitin: 0.5, hide: 0.8, bone: 0.3, raw_meat: 0.6, cooked_meat: 0.45,
  stone_pick: 1.6, stone_knife: 0.4, spear: 1.3, fiber_pouch: 0.2, hide_pack: 0.9, lamp_cell: 0.3,
};
/** Uses before a tool breaks: a dig stroke, a cut, a harvest or a hit each count one. */
export const DURABILITY: Partial<Record<ItemId, number>> = { stone_pick: 500, stone_knife: 160, spear: 120 };
export const BASE_SLOTS = 8;
/** Slots each bag adds. */
export const BAG_SLOTS: Partial<Record<ItemId, number>> = { fiber_pouch: 4, hide_pack: 4 };
/** Seconds until carried meat spoils (a day is 20 minutes): raw by the next half-day, cooked lasts two days. */
export const SHELF_LIFE: Partial<Record<ItemId, number>> = { raw_meat: 600, cooked_meat: 2400 };
export type Perishable = 'raw_meat' | 'cooked_meat';
export const PERISHABLE: Perishable[] = ['raw_meat', 'cooked_meat'];

/** Soft weight bands: you can always carry what fits, it just costs speed. */
export const LOAD_BANDS = [
  { name: 'Light', kg: 0, speed: 1 },
  { name: 'Laden', kg: 30, speed: 0.88 },
  { name: 'Heavy', kg: 45, speed: 0.74 },
  { name: 'Overloaded', kg: 60, speed: 0.55 },
] as const;

export class Inventory {
  readonly counts: Record<ItemId, number> = {
    stone: 0, stalkwood: 0, fiber: 0, cordage: 0, chitin: 0, hide: 0, bone: 0, raw_meat: 0, cooked_meat: 0,
    stone_pick: 0, stone_knife: 0, spear: 0, bone_needle: 0, hide_wrap: 0, chitin_spearhead: 0, fiber_pouch: 0, hide_pack: 0, crate: 0, flare: 0, solar: 0, lamp_cell: 0,
  };
  /** Age in seconds of each carried piece of meat, oldest first. Always as long as the count. */
  readonly ages: Record<Perishable, number[]> = { raw_meat: [], cooked_meat: [] };
  /** Everything you have ever held: recipes unlock once you've held all their parts. */
  readonly seen = new Set<ItemId>();
  /** Uses already spent on the tool in hand of each kind (spares are always fresh). */
  readonly wear: Partial<Record<ItemId, number>> = {};
  onChange: () => void = () => {};
  /** `base` carry slots before bags (a crate has more and takes no bags). */
  constructor(readonly base = BASE_SLOTS) {}

  slots() { return this.base + GEAR.reduce((s, k) => s + (this.counts[k] > 0 ? BAG_SLOTS[k] ?? 0 : 0), 0); }
  usedSlots() { return MATERIALS.reduce((s, k) => s + Math.ceil(this.counts[k] / (STACK[k] ?? 1)), 0); }
  weight() { return (Object.keys(this.counts) as ItemId[]).reduce((s, k) => s + this.counts[k] * (WEIGHT[k] ?? 0), 0); }
  load_() { const kg = this.weight(); let b: (typeof LOAD_BANDS)[number] = LOAD_BANDS[0]; for (const x of LOAD_BANDS) if (kg >= x.kg) b = x; return b; }

  /** How many more of `id` fit: the rest of its last stack plus every free slot. Tools and gear always fit. */
  room(id: ItemId) {
    const st = STACK[id];
    if (!st) return Infinity;
    const partial = (st - (this.counts[id] % st)) % st;
    return partial + Math.max(0, this.slots() - this.usedSlots()) * st;
  }

  /** Adds up to `n` (as many as fit) and returns how many went in. `age` starts meat part-way through its life. */
  add(id: ItemId, n = 1, age = 0) {
    const k = Math.max(0, Math.min(n, this.room(id)));
    if (k <= 0) return 0;
    this.counts[id] += k;
    this.seen.add(id);
    if (id in this.ages) { const a = this.ages[id as Perishable]; for (let i = 0; i < k; i++) a.push(age); a.sort((x, y) => y - x); }
    this.onChange();
    return k;
  }

  has(cost: Cost) {
    return (Object.keys(cost) as ItemId[]).every((k) => this.counts[k] >= (cost[k] ?? 0));
  }

  /** Uses up `cost`. Meat goes oldest first. */
  take(cost: Cost) {
    if (!this.has(cost)) return false;
    for (const k of Object.keys(cost) as ItemId[]) {
      const n = cost[k] ?? 0;
      this.counts[k] -= n;
      if (k in this.ages) this.ages[k as Perishable].splice(0, n);
    }
    this.onChange();
    return true;
  }

  /** Ages carried meat; returns what spoiled (already removed). */
  tick(dt: number) {
    const spoiled: Perishable[] = [];
    for (const k of PERISHABLE) {
      const a = this.ages[k], life = SHELF_LIFE[k] ?? Infinity;
      for (let i = 0; i < a.length; i++) a[i] += dt;
      while (a.length && a[0] >= life) { a.shift(); this.counts[k]--; spoiled.push(k); }
    }
    if (spoiled.length) this.onChange();
    return spoiled;
  }

  /** 0..1 condition of the tool of this kind you'd use next (1 = fresh), or null without one. */
  condition(id: ItemId) { const d = DURABILITY[id]; return d && this.counts[id] > 0 ? 1 - (this.wear[id] ?? 0) / d : null; }

  /** Spends one use of a tool. 'low' the first time it drops under 15%, 'broke' when it breaks (one fewer of them). */
  wearOut(id: ItemId, n = 1): 'ok' | 'low' | 'broke' {
    const d = DURABILITY[id];
    if (!d || this.counts[id] <= 0) return 'ok';
    const before = this.wear[id] ?? 0, after = before + n;
    if (after >= d) { this.wear[id] = 0; this.counts[id]--; this.onChange(); return 'broke'; }
    this.wear[id] = after;
    return before < d * 0.85 && after >= d * 0.85 ? 'low' : 'ok';
  }

  /** Moves up to `n` of `id` into `to` (as many as fit there), keeping meat ages. Returns how many moved. */
  moveTo(to: Inventory, id: ItemId, n: number) {
    const k = Math.min(n, this.counts[id], to.room(id));
    if (k <= 0) return 0;
    const ages = id in this.ages ? this.ages[id as Perishable].slice(0, k) : [];
    this.counts[id] -= k;
    if (id in this.ages) this.ages[id as Perishable].splice(0, k);
    to.counts[id] += k; to.seen.add(id);
    // A worn tool travels with the last one moved (spares go first), so storing it can't make it new.
    if (DURABILITY[id] && this.counts[id] === 0 && this.wear[id]) { to.wear[id] = Math.max(to.wear[id] ?? 0, this.wear[id]!); this.wear[id] = 0; }
    if (id in to.ages) { const a = to.ages[id as Perishable]; a.push(...ages); a.sort((x, y) => y - x); }
    this.onChange(); to.onChange();
    return k;
  }

  /** Seconds until the oldest piece of `k` spoils, or null when you carry none. */
  freshness(k: Perishable) { const a = this.ages[k]; return a.length ? Math.max(0, (SHELF_LIFE[k] ?? 0) - a[0]) : null; }

  load(c: Partial<Record<string, number>> | undefined, ages?: Partial<Record<string, number[]>>, seen?: string[], wear?: Partial<Record<string, number>>) {
    if (c) for (const k of Object.keys(this.counts) as ItemId[]) this.counts[k] = c[k] ?? 0;
    for (const k of Object.keys(DURABILITY) as ItemId[]) this.wear[k] = Math.min(Math.max(0, wear?.[k] ?? 0), (DURABILITY[k] ?? 1) - 1);
    for (const k of PERISHABLE) {
      const a = (ages?.[k] ?? []).slice(0, this.counts[k]).sort((x, y) => y - x);
      while (a.length < this.counts[k]) a.push(0);
      this.ages[k].splice(0, Infinity, ...a);
    }
    this.seen.clear();
    // Saves from before recipe discovery: everything that existed counts as known, so no one loses recipes.
    const known = seen ?? (c ? MATERIALS.concat(TOOLS) : []);
    for (const k of known) if (k in this.counts) this.seen.add(k as ItemId);
    for (const k of Object.keys(this.counts) as ItemId[]) if (this.counts[k] > 0) this.seen.add(k);
    this.onChange();
  }
}
