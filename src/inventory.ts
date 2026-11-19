// Carried resources. M1 keeps it to stack counts; slots, weight and storage come later.
export type ItemId = 'stone' | 'stalkwood' | 'fiber';

export const ITEM_NAMES: Record<ItemId, string> = {
  stone: 'Stone',
  stalkwood: 'Stalkwood',
  fiber: 'Fiber',
};

export class Inventory {
  readonly counts: Record<ItemId, number> = { stone: 0, stalkwood: 0, fiber: 0 };
  onChange: () => void = () => {};

  add(id: ItemId, n = 1) { this.counts[id] += n; this.onChange(); }

  has(cost: Partial<Record<ItemId, number>>) {
    return (Object.keys(cost) as ItemId[]).every((k) => this.counts[k] >= (cost[k] ?? 0));
  }

  take(cost: Partial<Record<ItemId, number>>) {
    if (!this.has(cost)) return false;
    for (const k of Object.keys(cost) as ItemId[]) this.counts[k] -= cost[k] ?? 0;
    this.onChange();
    return true;
  }

  load(c: Partial<Record<ItemId, number>> | undefined) {
    if (c) for (const k of Object.keys(this.counts) as ItemId[]) this.counts[k] = c[k] ?? 0;
    this.onChange();
  }
}
