// One place for keyboard and mouse input. Gameplay reads named actions; when the game is paused or a
// menu is open, `enabled` is false and every gameplay action reads as released. Bindings can be remapped in Settings
// (saved per browser); run and sneak can be held or toggled.
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'run' | 'sneak'
  | 'use' | 'dig' | 'fill' | 'build' | 'eat' | 'lamp' | 'craft' | 'lookLeft' | 'lookRight' | 'lookUp' | 'lookDown';

/** Default bindings. Ctrl is deliberately unused: Ctrl+W would close the browser tab. */
export const DEFAULT_BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'], run: ['ShiftLeft', 'ShiftRight'], sneak: ['KeyC'],
  use: ['KeyE'], dig: ['KeyR', 'Mouse0'], fill: ['KeyF', 'Mouse2'], build: ['KeyB'], eat: ['KeyQ'], lamp: ['KeyL'], craft: ['Tab'],
  lookLeft: ['ArrowLeft'], lookRight: ['ArrowRight'], lookUp: ['ArrowUp'], lookDown: ['ArrowDown'],
};

/** Actions shown in the remapping list, in order, with their labels. */
export const REMAPPABLE: [Action, string][] = [
  ['forward', 'Move forward'], ['back', 'Move back'], ['left', 'Move left'], ['right', 'Move right'], ['jump', 'Jump'],
  ['run', 'Run'], ['sneak', 'Sneak'], ['use', 'Pick up / use'], ['dig', 'Dig / attack'], ['fill', 'Fill'],
  ['build', 'Build campfire'], ['eat', 'Cook / eat'], ['lamp', 'Wrist lamp'], ['craft', 'Crafting'],
];

/** Keys the game keeps for itself (menus, debug, hotbar and recipe numbers). */
export const RESERVED = new Set(['Escape', 'F3', 'F5', 'Digit1', 'Digit2', 'Digit3', 'Digit4', 'Digit5', 'Digit6', 'Digit7',
  ...(import.meta.env.DEV ? ['KeyT'] : [])]);

const KEY = 'biocrash-keys';
export const BINDINGS: Record<Action, string[]> = structuredClone(DEFAULT_BINDINGS);
try {
  const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<Action, unknown>>;
  for (const a of Object.keys(DEFAULT_BINDINGS) as Action[]) {
    const v = saved[a];
    if (Array.isArray(v) && v.length && v.every((k) => typeof k === 'string')) BINDINGS[a] = v as string[];
  }
} catch { /* no saved bindings */ }

export function saveBindings() { try { localStorage.setItem(KEY, JSON.stringify(BINDINGS)); } catch { /* blocked */ } }
export function resetBindings() { Object.assign(BINDINGS, structuredClone(DEFAULT_BINDINGS)); saveBindings(); }

/** Readable name for a key code: KeyE -> E, ShiftLeft -> Shift, Mouse0 -> Left click. */
export function keyName(code: string) {
  if (code.startsWith('Key')) return code.slice(3);
  if (code.startsWith('Digit')) return code.slice(5);
  if (code.startsWith('Numpad')) return 'Num ' + code.slice(6);
  const names: Record<string, string> = {
    Mouse0: 'Left click', Mouse1: 'Middle click', Mouse2: 'Right click', ShiftLeft: 'Shift', ShiftRight: 'R-Shift', Space: 'Space',
    ControlLeft: 'Ctrl', AltLeft: 'Alt', AltRight: 'R-Alt', ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→',
    Tab: 'Tab', CapsLock: 'Caps', Backquote: '`', Minus: '-', Equal: '=', BracketLeft: '[', BracketRight: ']', Semicolon: ';',
    Quote: "'", Comma: ',', Period: '.', Slash: '/', Backslash: '\\', Enter: 'Enter', Backspace: 'Backspace',
  };
  return names[code] ?? code;
}

/** The label of an action's main key, for prompts and hints ("E", "Tab"). */
export function K(a: Action) { return keyName(BINDINGS[a][0]); }

export class Input {
  enabled = false;
  /** False in drag-to-look mode, where the left mouse button turns the camera instead of digging. */
  mouseActions = true;
  /** Actions that toggle on press instead of being held (comfort setting for run and sneak). */
  toggles = new Set<Action>();
  private held = new Set<string>();
  private latched = new Set<Action>();

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
      if (!e.repeat && this.enabled) for (const a of this.toggles) if (BINDINGS[a].includes(e.code)) {
        if (this.latched.has(a)) this.latched.delete(a); else this.latched.add(a);
      }
      this.held.add(e.code);
      // Stop the browser acting on game keys while playing (Space scrolling, Tab focus, F3/F5).
      if (this.enabled && ['Space', 'Tab', 'F3', 'F5', 'ArrowUp', 'ArrowDown'].includes(e.code)) e.preventDefault();
    });
    window.addEventListener('keyup', (e) => this.held.delete(e.code));
    window.addEventListener('blur', () => this.held.clear());
    // Mouse buttons only count while the mouse is captured: the click that recaptures it must not also dig or attack.
    // (In drag-to-look mode mouseActions is false, so mouse buttons never act anyway.)
    target.addEventListener('mousedown', (e) => { if (document.pointerLockElement === target) this.held.add(`Mouse${e.button}`); });
    window.addEventListener('mouseup', (e) => this.held.delete(`Mouse${e.button}`));
    target.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** Is a gameplay action held (or latched on, for toggled actions)? Always false while paused or in a menu. */
  down(a: Action) {
    if (!this.enabled) return false;
    if (this.toggles.has(a)) return this.latched.has(a);
    return BINDINGS[a].some((k) => this.held.has(k) && (this.mouseActions || !k.startsWith('Mouse')));
  }

  /** Does this key code belong to action `a`? (For one-shot actions handled on keydown.) */
  is(code: string, a: Action) { return BINDINGS[a].includes(code); }

  get moving() { return this.down('forward') || this.down('back') || this.down('left') || this.down('right'); }

  /** Forget held keys/buttons (e.g. when a menu opens) so nothing stays stuck down. Toggled actions switch off. */
  release() { this.held.clear(); this.latched.clear(); }
}
