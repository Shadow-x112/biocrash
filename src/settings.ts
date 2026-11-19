// Player settings: volumes, mouse, view and comfort options. Kept in localStorage (per browser), separate from the world save.

export interface Settings {
  master: number; sfx: number; ambience: number; ui: number; // 0..1
  sensitivity: number; // multiplier on the base mouse speed
  invertY: boolean;
  fov: number;         // degrees
  resolution: number;  // render scale 0.5..1 (of the screen's pixel density, capped at 1.5)
  autoRes: boolean;    // lower the render scale automatically when the frame rate drops
  headBob: boolean;
  shake: boolean;      // camera shake on hits and hard landings
  compass: boolean;
  tutorial: boolean;   // station-core objectives panel
}

export const DEFAULTS: Settings = {
  master: 0.8, sfx: 1, ambience: 0.7, ui: 0.8, sensitivity: 1, invertY: false, fov: 75, resolution: 1, autoRes: true, headBob: true, shake: true, compass: true, tutorial: true,
};

const KEY = 'biocrash-settings';

export function loadSettings(): Settings {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Settings>;
    const s = { ...DEFAULTS };
    for (const k of Object.keys(DEFAULTS) as (keyof Settings)[]) {
      if (typeof raw[k] === typeof DEFAULTS[k]) (s as unknown as Record<string, unknown>)[k] = raw[k];
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
  ] },
  { group: 'View', rows: [
    { key: 'fov', label: 'Field of view', kind: 'range', min: 60, max: 100, step: 1, fmt: (v) => `${v}°` },
    { key: 'resolution', label: 'Resolution', kind: 'range', min: 0.5, max: 1, step: 0.05, fmt: pct },
    { key: 'autoRes', label: 'Lower resolution when slow', kind: 'check' },
    { key: 'headBob', label: 'Head bob', kind: 'check' },
    { key: 'shake', label: 'Camera shake', kind: 'check' },
    { key: 'compass', label: 'Compass', kind: 'check' },
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
