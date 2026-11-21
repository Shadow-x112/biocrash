import { BINDINGS, REMAPPABLE, RESERVED, keyName, saveBindings, resetBindings, type Action } from './input';

// Player settings: volumes, mouse, view and comfort options. Kept in localStorage (per browser), separate from the world save.

export interface Settings {
  master: number; sfx: number; ambience: number; ui: number; // 0..1
  sensitivity: number; // multiplier on the base mouse speed
  invertY: boolean;
  fov: number;         // degrees
  quality: number;     // 0 Low (no shadows, no MSAA), 1 Medium (1024 shadow), 2 High (2048 shadow)
  resolution: number;  // render scale 0.5..1 (of the screen's pixel density, capped at 1.5)
  autoRes: boolean;    // lower the render scale automatically when the frame rate drops
  post: boolean;       // bloom, vignette, grain (post-processing)
  headBob: boolean;
  shakeAmt: number;    // 0..1 camera shake on hits and hard landings
  horrorAmt: number;   // 0.5..1.5 how hard the horror layer leans in
  reduceFlash: boolean; // no static flashes, colour splitting or strobing lights
  captions: boolean;   // captions for sounds that carry meaning (whispers, distant calls, the wreck)
  uiScale: number;     // 0.8..1.6 interface size
  runToggle: boolean;  // press run once instead of holding it
  sneakToggle: boolean;
  compass: boolean;
  fullHud: boolean;
  hudDistortion: boolean; // the HUD misbehaves as unease rises (drifting compass, false readings)
  captionSize: number;  // 0.8..1.8 caption text size
  pauseCraft: boolean;  // pause the world while the crafting panel is open (off: it keeps running)    // always show vitals and inventory (instead of only when they change)
  tutorial: boolean;   // station-core objectives panel
}

export const DEFAULTS: Settings = {
  master: 0.8, sfx: 1, ambience: 0.7, ui: 0.8, sensitivity: 1, invertY: false, fov: 75, quality: 1, resolution: 1, autoRes: true, post: true, headBob: true, shakeAmt: 1, horrorAmt: 1, reduceFlash: false, captions: false, uiScale: 1, runToggle: false, sneakToggle: false, compass: true, fullHud: false, hudDistortion: true, captionSize: 1, pauseCraft: false, tutorial: true,
};

const KEY = 'biocrash-settings';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS };
    const ranges = new Map(ROWS.flatMap((g) => g.rows).filter((r) => r.kind === 'range').map((r) => [r.key, r as { min: number; max: number }]));
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      const v = raw[k];
      if (typeof v !== typeof DEFAULTS[k]) continue;
      if (typeof v === 'number') {
        // NaN is a number too, and an edited or older storage entry can hold anything: clamp to the slider's range.
        const r = ranges.get(k);
        if (!Number.isFinite(v)) continue;
        (s as unknown as Record<string, unknown>)[k] = r ? Math.min(r.max, Math.max(r.min, v)) : v;
      } else (s as unknown as Record<string, unknown>)[k] = v;
    }
    return s;
  } catch { return { ...DEFAULTS }; }
}

export function saveSettings(s: Settings) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* storage blocked: settings last for this visit only */ }
}

type Row =
  | { key: keyof Settings; label: string; kind: 'range'; min: number; max: number; step: number; fmt: (v: number) => string }
  | { key: keyof Settings; label: string; kind: 'check' };

const pct = (v: number) => `${Math.round(v * 100)}%`;
const ROWS: { group: string; rows: Row[] }[] = [
  { group: 'Sound', rows: [
    { key: 'master', label: 'Master', kind: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'sfx', label: 'Effects', kind: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'ambience', label: 'Ambience', kind: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'ui', label: 'Interface', kind: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
  ] },
  { group: 'Controls', rows: [
    { key: 'sensitivity', label: 'Mouse sensitivity', kind: 'range', min: 0.25, max: 3, step: 0.05, fmt: (v) => `${v.toFixed(2)}×` },
    { key: 'invertY', label: 'Invert mouse Y', kind: 'check' },
    { key: 'runToggle', label: 'Run: press to toggle', kind: 'check' },
    { key: 'sneakToggle', label: 'Sneak: press to toggle', kind: 'check' },
  ] },
  { group: 'Accessibility', rows: [
    { key: 'uiScale', label: 'Interface size', kind: 'range', min: 0.8, max: 1.6, step: 0.05, fmt: pct },
    { key: 'captions', label: 'Sound captions', kind: 'check' },
    { key: 'captionSize', label: 'Caption size', kind: 'range', min: 0.8, max: 1.8, step: 0.1, fmt: pct },
    { key: 'horrorAmt', label: 'Horror intensity', kind: 'range', min: 0.5, max: 1.5, step: 0.05, fmt: pct },
    { key: 'reduceFlash', label: 'Reduce flashing', kind: 'check' },
  ] },
  { group: 'View', rows: [
    { key: 'fov', label: 'Field of view', kind: 'range', min: 60, max: 100, step: 1, fmt: (v) => `${v}°` },
    { key: 'quality', label: 'Graphics quality', kind: 'range', min: 0, max: 2, step: 1, fmt: (v) => ['Low', 'Medium', 'High'][v] ?? 'Medium' },
    { key: 'resolution', label: 'Resolution', kind: 'range', min: 0.5, max: 1, step: 0.05, fmt: pct },
    { key: 'autoRes', label: 'Lower resolution when slow', kind: 'check' },
    { key: 'post', label: 'Glow, grain and vignette', kind: 'check' },
    { key: 'headBob', label: 'Head bob', kind: 'check' },
    { key: 'shakeAmt', label: 'Camera shake', kind: 'range', min: 0, max: 1, step: 0.05, fmt: pct },
    { key: 'compass', label: 'Compass', kind: 'check' },
    { key: 'fullHud', label: 'Always show vitals and inventory', kind: 'check' },
    { key: 'hudDistortion', label: 'HUD distortion with unease', kind: 'check' },
    { key: 'pauseCraft', label: 'Pause while crafting', kind: 'check' },
    { key: 'tutorial', label: 'Station core objectives', kind: 'check' },
  ] },
];

/** Builds the settings form into `el`. `onChange` runs on every edit (apply live); values are saved as they change. */
export function buildSettingsForm(el: HTMLElement, s: Settings, onChange: (key: keyof Settings) => void) {
  const render = () => {
    el.innerHTML = ROWS.map((g) => `<div class="sgroup">${g.group}</div>` + g.rows.map((r) => {
      const v = s[r.key];
      return r.kind === 'range'
        ? `<label class="srow"><span>${r.label}</span><input type="range" data-k="${r.key}" min="${r.min}" max="${r.max}" step="${r.step}" value="${v}"><output>${r.fmt(v as number)}</output></label>`
        : `<label class="srow"><span>${r.label}</span><input type="checkbox" data-k="${r.key}" ${v ? 'checked' : ''}><output></output></label>`;
    }).join('')).join('') + '<button class="sreset">Reset to defaults</button>';
  };
  render();
  el.addEventListener('input', (e) => {
    const inp = e.target as HTMLInputElement, key = inp.dataset.k as keyof Settings | undefined;
    if (!key) return;
    const row = ROWS.flatMap((g) => g.rows).find((r) => r.key === key)!;
    if (row.kind === 'range') {
      (s as unknown as Record<string, unknown>)[key] = Number(inp.value);
      (inp.nextElementSibling as HTMLOutputElement).textContent = row.fmt(Number(inp.value));
    } else (s as unknown as Record<string, unknown>)[key] = inp.checked;
    saveSettings(s);
    onChange(key);
  });
  el.addEventListener('click', (e) => {
    if (!(e.target as HTMLElement).classList.contains('sreset')) return;
    Object.assign(s, DEFAULTS);
    saveSettings(s);
    render();
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) onChange(k);
  });
}


/** Key remapping: click a key, press the new one (Esc cancels). Mouse buttons stay on dig and fill. */
export function buildKeysForm(el: HTMLElement, onChange: () => void) {
  let waiting: Action | null = null;
  const render = () => {
    el.innerHTML = '<div class="sgroup">Keys</div>' + REMAPPABLE.map(([a, label]) => {
      const keys = BINDINGS[a].filter((k) => !k.startsWith('Mouse')).map(keyName).join(' / ');
      const mouse = BINDINGS[a].filter((k) => k.startsWith('Mouse')).map(keyName).join(' / ');
      return `<div class="srow"><span>${label}</span><button class="kbtn" data-a="${a}">${waiting === a ? 'Press a key\u2026' : keys}</button><output>${mouse}</output></div>`;
    }).join('') + '<button class="kreset">Reset keys</button>';
  };
  render();
  el.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t.classList.contains('kreset')) { resetBindings(); waiting = null; render(); onChange(); return; }
    const a = t.dataset.a as Action | undefined;
    if (a) { waiting = a; render(); }
  });
  window.addEventListener('keydown', (e) => {
    if (!waiting) return;
    // Only while the keys list is actually on screen: a prompt left open when the menu closed must not grab the next
    // gameplay key (it used to rebind W to whatever was waiting).
    if (!el.isConnected || el.getClientRects().length === 0) { waiting = null; render(); return; }
    e.preventDefault(); e.stopImmediatePropagation();
    if (e.code !== 'Escape' && !RESERVED.has(e.code)) {
      // One key, one action: take it off anything else that had it.
      for (const [b] of REMAPPABLE) if (b !== waiting) BINDINGS[b] = BINDINGS[b].filter((k) => k !== e.code);
      const mouse = BINDINGS[waiting].filter((k) => k.startsWith('Mouse'));
      BINDINGS[waiting] = [e.code, ...mouse];
      for (const [b] of REMAPPABLE) if (!BINDINGS[b].length) BINDINGS[b] = ['Unbound'];
      saveBindings();
      onChange();
    }
    waiting = null;
    render();
  }, true);
}
