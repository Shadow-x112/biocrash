// Primitive crafting. Chains stay shallow (max 3 steps): fiber -> cordage -> tool.
import type { Cost, ItemId } from './inventory';

export interface Recipe {
  id: string;
  makes: ItemId | 'campfire';
  amount: number;
  cost: Cost;
  /** Tools go on the hotbar; you can make spares to store. */
  tool?: boolean;
  blurb: string;
}

export const RECIPES: Recipe[] = [
  { id: 'cordage', makes: 'cordage', amount: 1, cost: { fiber: 3 }, blurb: 'Twisted fiber for binding tools.' },
  { id: 'stone_knife', makes: 'stone_knife', amount: 1, tool: true, cost: { stone: 1, cordage: 1 },
    blurb: 'Cuts twice the fiber from each tuft. Later: harvesting hide and sinew.' },
  { id: 'stone_pick', makes: 'stone_pick', amount: 1, tool: true, cost: { stone: 2, stalkwood: 1, cordage: 1 },
    blurb: 'Digs and shapes terrain far faster than bare hands.' },
  { id: 'spear', makes: 'spear', amount: 1, tool: true, cost: { stalkwood: 2, stone: 1, cordage: 1 },
    blurb: 'A reach weapon for hunting and defense.' },
  { id: 'campfire', makes: 'campfire', amount: 1, cost: { stalkwood: 4, stone: 5 },
    blurb: 'Heat and light for the night. Build it with B while looking at the ground.' },
];
