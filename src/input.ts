// One place for keyboard and mouse input. Gameplay reads named actions; when the game is paused or a
// menu is open, `enabled` is false and every gameplay action reads as released.
export type Action =
  | 'forward' | 'back' | 'left' | 'right' | 'jump' | 'run' | 'sneak'
  | 'use' | 'dig' | 'fill' | 'build' | 'lookLeft' | 'lookRight' | 'lookUp' | 'lookDown';

/** Default bindings. Ctrl is deliberately unused: Ctrl+W would close the browser tab. */
export const BINDINGS: Record<Action, string[]> = {
  forward: ['KeyW'], back: ['KeyS'], left: ['KeyA'], right: ['KeyD'],
  jump: ['Space'], run: ['ShiftLeft', 'ShiftRight'], sneak: ['KeyC'],
  use: ['KeyE'], dig: ['KeyR', 'Mouse0'], fill: ['KeyF', 'Mouse2'], build: ['KeyB'],
  lookLeft: ['ArrowLeft'], lookRight: ['ArrowRight'], lookUp: ['ArrowUp'], lookDown: ['ArrowDown'],
};

export class Input {
  enabled = false;
  /** False in drag-to-look mode, where the left mouse button turns the camera instead of digging. */
  mouseActions = true;
  private held = new Set<string>();

  constructor(target: HTMLElement) {
    window.addEventListener('keydown', (e) => {
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

  /** Is a gameplay action held? Always false while paused or in a menu. */
  down(a: Action) {
    return this.enabled && BINDINGS[a].some((k) => this.held.has(k) && (this.mouseActions || !k.startsWith('Mouse')));
  }

  get moving() { return this.down('forward') || this.down('back') || this.down('left') || this.down('right'); }

  /** Forget held keys/buttons (e.g. when a menu opens) so nothing stays stuck down. */
  release() { this.held.clear(); }
}
