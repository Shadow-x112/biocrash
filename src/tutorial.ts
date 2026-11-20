// The salvaged station core on your wrist walks you through the first night: fiber, cordage, a knife, wood, stone, fire.
// It is reliable (every objective is real and correct) but its text glitches when the horror layer says so.
import type { Inventory, ItemId } from './inventory';
import { K, type Action } from './input';

/** Puts the player's current keys into a line: {use} -> E. */
const keys = (t: string) => t.replace(/\{(\w+)\}/g, (_, a: string) => K(a as Action));

interface Step {
  say: string;
  goal: string;
  /** Progress as [have, need]; the step is done when have >= need. */
  progress: (g: TutorialState) => [number, number];
}

export interface TutorialState { inv: Inventory; fires: number; t: number }

const owned = (g: TutorialState, ...ids: ItemId[]) => ids.some((id) => g.inv.counts[id] > 0);

const STEPS: Step[] = [
  { say: 'Core online. Hull breach, total. You are the only life sign I can find. Let’s keep it that way.',
    goal: 'Look around', progress: (g) => [Math.min(g.t, 6), 6] },
  { say: 'Those pale tufts are plant fiber. Pick some up. Look at one and press {use}.',
    goal: 'Gather fiber', progress: (g) => owned(g, 'cordage', 'stone_knife') ? [3, 3] : [g.inv.counts.fiber, 3] },
  { say: 'Twist the fiber into cordage. Press {craft} to open crafting.',
    goal: 'Craft cordage', progress: (g) => [owned(g, 'cordage', 'stone_knife') ? 1 : 0, 1] },
  { say: 'Find a loose stone on the ground. Sharp enough to be useful.',
    goal: 'Pick up a stone', progress: (g) => [owned(g, 'stone', 'stone_knife') ? 1 : 0, 1] },
  { say: 'Bind the stone with cordage. A knife. Your first tool on this planet.',
    goal: 'Craft a stone knife ({craft})', progress: (g) => [owned(g, 'stone_knife') ? 1 : 0, 1] },
  { say: 'The giant stalks burn. Cut stalkwood with the knife: look at a stalk, press {use}.',
    goal: 'Cut stalkwood', progress: (g) => [g.fires > 0 ? 4 : g.inv.counts.stalkwood, 4] },
  { say: 'Stone rings the fire and keeps it from spreading. Gather more.',
    goal: 'Collect stone', progress: (g) => [g.fires > 0 ? 5 : g.inv.counts.stone, 5] },
  { say: 'Temperature drops hard after sunset. Build a fire: look at flat ground and press {build}.',
    goal: 'Build a campfire', progress: (g) => [Math.min(g.fires, 1), 1] },
  { say: 'Fire’s lit. Keep feeding it stalkwood. Nights here are cold. And not quiet. Stay near the light.',
    goal: '', progress: (g) => [Math.min(g.t, 12), 12] },
];

const GLYPHS = '#%&@$░▒▓/\\|_';

/** One-off core lines after the first night's objectives, triggered by what happens in play. A goal (if any) is
 *  ticked by `goalMet` from the game. Ids are saved so each line plays once per world. */
export const MILESTONES = {
  first_kill: { say: 'Lifeform down. A knife will get the useful parts off it. Look at it and press {use}.', goal: '' },
  raw_meat: { say: 'Raw meat. Don’t. Cook it over a fire first: look at a lit fire and press {eat}.', goal: 'Cook raw meat at a fire ({eat})' },
  cooked: { say: 'Cooked. Eat it with {eat} when you’re away from a fire. Fed, your body holds heat and heals faster.', goal: 'Eat ({eat})' },
  hide: { say: 'Hide. Shape a bone into a needle and you can stitch a wrap. It’ll hold your heat at night.', goal: 'Craft a hide wrap ({craft})' },
  cold: { say: 'Core temperature dropping. Get to a fire. Shelter only slows it.', goal: '' },
  sunset: { say: 'Sunset in about three minutes. Make sure your fire has wood.', goal: '' },
  dawn: { say: 'Sunrise. You made it through a night here. The wreck’s med bay might still have power. Go and look.', goal: 'Return to the wreck' },
  wreck: { say: 'Med bay is dark. The distress beacon is still transmitting. Nobody has answered. Yet.', goal: '' },
  death: { say: 'I pulled your vitals back at the crash site. What you carried is where you fell: it’s on your compass.', goal: 'Recover your pack' },
} as const;
export type MilestoneId = keyof typeof MILESTONES;
const URGENT = new Set<MilestoneId>(['cold', 'sunset']);

export class Tutorial {
  step = 0;
  enabled = true;
  /** Milestones already shown (saved). */
  readonly seen = new Set<MilestoneId>();
  private t = 0;           // seconds on this step / milestone
  private typed = 0;       // characters of the line shown so far
  private shown = '';
  private greeted = false;
  private queue: { id: MilestoneId; at: number }[] = [];
  /** A time-critical line (cold, sunset) shown at once over anything else for a few seconds. */
  private urgent: { id: MilestoneId; t: number } | null = null;
  private clock = 0;
  private current: MilestoneId | null = null;
  private metAt = -1;
  onLine?: () => void;
  /** Set by the game: is this milestone's goal done right now? */
  goalMet: (id: MilestoneId) => boolean = () => false;

  constructor(private el: HTMLElement, step = 0, seen: string[] = []) {
    this.step = Math.min(step, STEPS.length);
    for (const id of seen) if (id in MILESTONES) this.seen.add(id as MilestoneId);
    this.el.innerHTML = '<div class="tc-h">STATION CORE · WRIST LINK</div><div class="tc-say"></div><div class="tc-goal"></div>';
  }

  get done() { return this.step >= STEPS.length; }

  /** The goal to keep pinned under the vitals after its line fades ('' when there's none). */
  currentGoal(): string {
    if (!this.enabled) return '';
    if (!this.done) return keys(STEPS[this.step].goal);
    if (this.current && MILESTONES[this.current].goal && !this.goalMet(this.current)) return keys(MILESTONES[this.current].goal);
    return '';
  }

  /** Queue a one-off line (ignored if already seen). Milestones wait until the first-night objectives are done. */
  milestone(id: MilestoneId) {
    if (!this.enabled) return; // objectives switched off: don't use up lines the player never saw
    if (this.seen.has(id) || this.queue.some((q) => q.id === id) || this.current === id || this.urgent?.id === id) return;
    if (URGENT.has(id)) { this.urgent = { id, t: 0 }; this.seen.add(id); this.typed = 0; this.onLine?.(); return; }
    this.queue.push({ id, at: this.clock });
  }

  /** Everything the core has said so far, oldest first (for the log in the pause menu). */
  log(): string[] {
    const out = STEPS.slice(0, Math.min(this.step + 1, STEPS.length)).map((s) => s.say);
    for (const id of this.seen) out.push(MILESTONES[id].say);
    return out.map(keys);
  }

  private render(rawText: string, rawGoal: string, glitch: number, dt: number) {
    const text = keys(rawText), goal = keys(rawGoal);
    this.typed = Math.min(text.length, this.typed + dt * 45);
    let line = text.slice(0, Math.floor(this.typed));
    if (glitch > 0) line = [...line].map((c) => (c !== ' ' && Math.random() < 0.25 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : c)).join('');
    const html = `${line}|${goal}`;
    if (html !== this.shown) {
      this.shown = html;
      (this.el.children[1] as HTMLElement).textContent = line;
      (this.el.children[2] as HTMLElement).innerHTML = goal;
    }
  }

  update(dt: number, inv: Inventory, fires: number, glitch: number) {
    if (!this.enabled) { this.el.style.display = 'none'; return; }
    this.clock += dt;
    // Urgent lines interrupt the tutorial and other lines for ~9 s: the slowest players need them most.
    if (this.urgent) {
      if ((this.urgent.t += dt) < 9) {
        this.el.style.display = 'block';
        this.render(MILESTONES[this.urgent.id].say, '', glitch, dt);
        return;
      }
      this.urgent = null; this.typed = 0; this.shown = '';
    }
    this.t += dt;
    if (!this.done) {
      this.el.style.display = 'block';
      const g: TutorialState = { inv, fires, t: this.t };
      // Skip ahead past anything already achieved (an old save, or a player who knows the game).
      let advanced = false;
      if (fires > 0 && this.step > 0 && this.step < STEPS.length - 1) { this.step = STEPS.length - 1; this.t = 0; g.t = 0; this.typed = 0; advanced = true; }
      while (!this.done) {
        const [have, need] = STEPS[this.step].progress(g);
        if (have < need) break;
        this.step++; this.t = 0; g.t = 0; this.typed = 0; advanced = true;
      }
      if (!this.done) {
        if (advanced || !this.greeted) { this.greeted = true; this.onLine?.(); }
        const s = STEPS[this.step];
        const [have, need] = s.progress(g);
        const goal = s.goal ? `<span class="tc-box">${have >= need ? '✓' : ''}</span>${s.goal}${need > 1 && this.step > 0 ? ` <b>${Math.min(have, need)}/${need}</b>` : ''}` : '';
        this.render(s.say, goal, glitch, dt);
        return;
      }
    }
    // Milestones: one at a time; a line stays ~14 s, or until 4 s after its goal is met (up to 90 s).
    // Lines that waited too long are dropped rather than arriving out of context.
    while (this.queue.length && this.clock - this.queue[0].at > 240) this.queue.shift();
    if (!this.current && this.queue.length) {
      this.current = this.queue.shift()!.id;
      this.seen.add(this.current);
      this.t = 0; this.typed = 0; this.metAt = -1;
      this.onLine?.();
    }
    if (!this.current) { this.el.style.display = 'none'; return; }
    const m = MILESTONES[this.current];
    const met = !!m.goal && this.goalMet(this.current);
    if (met && this.metAt < 0) this.metAt = this.t;
    const expired = m.goal ? (this.metAt >= 0 && this.t - this.metAt > 4) || this.t > 90 : this.t > 14;
    if (expired) { this.current = null; this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    this.render(m.say, m.goal ? `<span class="tc-box">${met ? '✓' : ''}</span>${m.goal}` : '', glitch, dt);
  }
}
