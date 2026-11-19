// The salvaged station core on your wrist walks you through the first night: fiber, cordage, a knife, wood, stone, fire.
// It is reliable (every objective is real and correct) but its text glitches when the horror layer says so.
import type { Inventory, ItemId } from './inventory';

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
  { say: 'Those pale tufts are plant fiber. Pick some up. Look at one and press E.',
    goal: 'Gather fiber', progress: (g) => owned(g, 'cordage', 'stone_knife') ? [3, 3] : [g.inv.counts.fiber, 3] },
  { say: 'Twist the fiber into cordage. Press Tab to open crafting.',
    goal: 'Craft cordage', progress: (g) => [owned(g, 'cordage', 'stone_knife') ? 1 : 0, 1] },
  { say: 'Find a loose stone on the ground. Sharp enough to be useful.',
    goal: 'Pick up a stone', progress: (g) => [owned(g, 'stone', 'stone_knife') ? 1 : 0, 1] },
  { say: 'Bind the stone with cordage. A knife. Your first tool on this planet.',
    goal: 'Craft a stone knife (Tab)', progress: (g) => [owned(g, 'stone_knife') ? 1 : 0, 1] },
  { say: 'The giant stalks burn. Cut stalkwood with the knife: look at a stalk, press E.',
    goal: 'Cut stalkwood', progress: (g) => [g.fires > 0 ? 4 : g.inv.counts.stalkwood, 4] },
  { say: 'Stone rings the fire and keeps it from spreading. Gather more.',
    goal: 'Collect stone', progress: (g) => [g.fires > 0 ? 5 : g.inv.counts.stone, 5] },
  { say: 'Temperature drops hard after sunset. Build a fire: look at flat ground and press B.',
    goal: 'Build a campfire', progress: (g) => [Math.min(g.fires, 1), 1] },
  { say: 'Fire’s lit. Keep feeding it stalkwood. Nights here are cold. And not quiet. Stay near the light.',
    goal: '', progress: (g) => [Math.min(g.t, 12), 12] },
];

const GLYPHS = '#%&@$░▒▓/\\|_';

export class Tutorial {
  step = 0;
  enabled = true;
  private t = 0;           // seconds on this step
  private typed = 0;       // characters of the line shown so far
  private shown = '';
  private greeted = false;
  onLine?: () => void;

  constructor(private el: HTMLElement, step = 0) {
    this.step = Math.min(step, STEPS.length);
    this.el.innerHTML = '<div class="tc-h">STATION CORE · WRIST LINK</div><div class="tc-say"></div><div class="tc-goal"></div>';
  }

  get done() { return this.step >= STEPS.length; }

  update(dt: number, inv: Inventory, fires: number, glitch: number) {
    if (this.done || !this.enabled) { this.el.style.display = 'none'; return; }
    this.el.style.display = 'block';
    this.t += dt;
    const g: TutorialState = { inv, fires, t: this.t };
    // Skip ahead past anything already achieved (an old save, or a player who knows the game).
    let advanced = false;
    if (fires > 0 && this.step > 0 && this.step < STEPS.length - 1) { this.step = STEPS.length - 1; this.t = 0; g.t = 0; this.typed = 0; advanced = true; }
    while (!this.done) {
      const [have, need] = STEPS[this.step].progress(g);
      if (have < need) break;
      this.step++; this.t = 0; g.t = 0; this.typed = 0; advanced = true;
    }
    if (this.done) { this.el.style.display = 'none'; return; }
    if (advanced || !this.greeted) { this.greeted = true; this.onLine?.(); }
    const s = STEPS[this.step];
    this.typed = Math.min(s.say.length, this.typed + dt * 45);
    let line = s.say.slice(0, Math.floor(this.typed));
    if (glitch > 0) line = [...line].map((c) => (c !== ' ' && Math.random() < 0.25 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : c)).join('');
    const [have, need] = s.progress(g);
    const goal = s.goal ? `<span class="tc-box">${have >= need ? '✓' : ''}</span>${s.goal}${need > 1 && this.step > 0 ? ` <b>${Math.min(have, need)}/${need}</b>` : ''}` : '';
    const html = `${line}|${goal}`;
    if (html !== this.shown) {
      this.shown = html;
      (this.el.children[1] as HTMLElement).textContent = line;
      (this.el.children[2] as HTMLElement).innerHTML = goal;
    }
  }
}
