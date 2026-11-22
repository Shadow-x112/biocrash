// Primitive crafting. Chains stay shallow (max 3 steps): fiber -> cordage -> tool.
import type { Cost, ItemId } from './inventory';

export interface Recipe {
  id: string;
  makes: ItemId;
  amount: number;
  cost: Cost;
  /** Tools go on the hotbar; you can make spares to store. */
  tool?: boolean;
  /** Items you must own (not used up), e.g. the needle for stitching. */
  needs?: ItemId[];
  /** One is all you'll ever need (gear). */
  unique?: boolean;
  /** Built in the world rather than carried: crafting starts placement, the cost is paid when it's placed. */
  place?: boolean;
  /** Learned by scanning this creature with the wrist link, not by holding the parts. */
  scan?: 'tuko' | 'oomi' | 'chip_cell' | 'chip_flare' | 'chip_solar';
  /** Needs a lit fire close by (curing hide, hardening chitin): night work at the camp. */
  heat?: boolean;
  blurb: string;
}

export const RECIPES: Recipe[] = [
  { id: 'cordage', makes: 'cordage', amount: 1, cost: { fiber: 3 }, blurb: 'Twisted fiber for binding tools.' },
  { id: 'stone_knife', makes: 'stone_knife', amount: 1, tool: true, cost: { stone: 1, cordage: 1 },
    blurb: 'Cuts twice the fiber from each tuft, and harvests hunted creatures.' },
  { id: 'stone_pick', makes: 'stone_pick', amount: 1, tool: true, cost: { stone: 2, stalkwood: 1, cordage: 1 },
    blurb: 'Digs and shapes terrain far faster than bare hands.' },
  { id: 'spear', makes: 'spear', amount: 1, tool: true, cost: { stalkwood: 2, stone: 1, cordage: 1 },
    blurb: 'A reach weapon for hunting and defense.' },
  { id: 'bone_needle', makes: 'bone_needle', amount: 1, unique: true, cost: { bone: 1 },
    blurb: 'A splinter of bone, ground to a point. For stitching hide.' },
  { id: 'hide_wrap', makes: 'hide_wrap', amount: 1, unique: true, heat: true, cost: { hide: 2, cordage: 2 }, needs: ['bone_needle'],
    blurb: 'Hide cured over a fire, worn under the suit. You lose body heat 25% slower.' },
  { id: 'chitin_spearhead', makes: 'chitin_spearhead', amount: 1, unique: true, heat: true, cost: { chitin: 3, cordage: 1 }, needs: ['spear'], scan: 'tuko',
    blurb: 'A Tuko shell plate, hardened in the fire and lashed to your spear: half again the damage.' },
  { id: 'fiber_pouch', makes: 'fiber_pouch', amount: 1, unique: true, cost: { fiber: 10, cordage: 2 },
    blurb: 'A woven sack for the belt: 4 more carry slots.' },
  { id: 'hide_pack', makes: 'hide_pack', amount: 1, unique: true, cost: { hide: 3, cordage: 3, bone: 1 }, needs: ['bone_needle'], scan: 'oomi',
    blurb: 'A stitched hide backpack with a bone frame: 4 more carry slots.' },
  { id: 'crate', makes: 'crate', amount: 1, place: true, cost: { stalkwood: 6, cordage: 3, stone: 2 },
    blurb: 'Lashed stalkwood under a hull-plate lid: 16 slots of storage at camp, and meat keeps twice as long.' },
  // Station tech: each is learned by reading a data chip found around the wreck.
  { id: 'lamp_cell', makes: 'lamp_cell', amount: 1, unique: true, cost: { chitin: 2, cordage: 2, bone: 1 }, scan: 'chip_cell',
    blurb: 'A salvaged power cell wired into your wrist lamp: it drains half as fast and recharges faster.' },
  { id: 'flare', makes: 'flare', amount: 1, place: true, cost: { stalkwood: 1, fiber: 4, chitin: 1 }, scan: 'chip_flare',
    blurb: 'A stake with a chemical head. Burns red for two minutes: light in the dark, and it steadies your nerves.' },
  { id: 'solar', makes: 'solar', amount: 1, place: true, cost: { stalkwood: 6, chitin: 4, cordage: 3 }, scan: 'chip_solar',
    blurb: 'A salvaged cell panel on a stalkwood frame. In daylight it charges your wrist lamp fast while you stand near it.' },
];

/** A recipe is learned once you have held every one of its parts (and the tools it needs). */
export const knows = (r: Recipe, seen: ReadonlySet<ItemId>, scanned: ReadonlySet<string> = new Set()) =>
  r.scan ? scanned.has(r.scan) : (Object.keys(r.cost) as ItemId[]).every((k) => seen.has(k)) && (r.needs ?? []).every((k) => seen.has(k));
