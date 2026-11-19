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
  { id: 'hide_wrap', makes: 'hide_wrap', amount: 1, unique: true, cost: { hide: 2, cordage: 2 }, needs: ['bone_needle'],
    blurb: 'Worn under the suit. You lose body heat 40% slower.' },
  { id: 'chitin_spearhead', makes: 'chitin_spearhead', amount: 1, unique: true, cost: { chitin: 3, cordage: 1 }, needs: ['spear'],
    blurb: 'A Tuko shell plate lashed to your spear: half again the damage.' },
];
