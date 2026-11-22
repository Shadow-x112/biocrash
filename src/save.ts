// Saves = world seed + only the chunks the player has edited, in IndexedDB.
// Rules: one tab owns the save (Web Locks), old saves are migrated forward where possible,
// imports are fully validated before anything is replaced, and reset/import suppress further saves.
import { CHUNK, GEN_VERSION, SAVE_VERSION } from './config';
import type { CampfireSave } from './campfire';
import type { CrateSave } from './crate';

export interface SaveMeta {
  saveVersion: number;
  genVersion: number;
  seed: string;
  player: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  savedAt: number;
  /** 0..1 time of day; optional so older saves still load. */
  timeOfDay?: number;
  vitals?: { health: number; warmth: number; fed?: number; afterglow?: number };
  inventory?: Record<string, number>;
  /** Ids of props the player has picked up. */
  picked?: string[];
  campfires?: CampfireSave[];
  /** Times each giant mushroom stalk has been cut. */
  stalks?: Record<string, number>;
  /** Station-core objective reached (first-night tutorial). */
  tutorialStep?: number;
  /** Station-core milestone lines already shown. */
  milestones?: string[];
  /** Packs of materials dropped where you froze. */
  packs?: PackSave[];
  /** A night has passed since the last dawn line (for the dawn milestone). */
  wasNight?: boolean;
  /** Nights survived: the horror layer unlocks events over the first few. */
  nights?: number;
  horror?: { figureSeen: boolean; figureNight: number; played?: string[]; last?: string | null };
  /** Wrist-lamp charge 0..100. */
  lamp?: number;
  /** Age in seconds of each carried piece of meat. */
  fresh?: Record<string, number[]>;
  /** Items ever held (recipe discovery). Missing on older saves, which then know every recipe. */
  seen?: string[];
  /** Storage crates built at camp, with what's in them. */
  crates?: CrateSave[];
  /** Uses spent on the tool in hand, per tool kind. */
  wear?: Record<string, number>;
  /** Creatures scanned with the wrist link (advanced recipes). */
  scanned?: string[];
}

export interface PackSave { x: number; y: number; z: number; items: Record<string, number> }

interface ExportFile extends SaveMeta {
  chunks: Record<string, string>; // key -> base64 Float32Array
}

const DB_NAME = 'biocrash';
const META = 'meta';
const CHUNKS = 'chunks';
const EDIT_BYTES = CHUNK * CHUNK * CHUNK * 4;
const KEY_RE = /^-?\d+,-?\d+,-?\d+$/;

/** Upgrades from one save version to the next. Each step edits the meta in place. */
const MIGRATIONS: Record<number, (m: SaveMeta) => void> = {
  // v1 -> v2: decorations moved to seeded worker placement, so old pick/cut ids no longer match.
  1: (m) => { delete m.picked; delete m.stalks; },
};

/** Checks and clamps every field of a save's metadata. Never throws: bad fields are dropped or reset to safe values,
 * so a damaged save or import can't crash startup. Returns null only when the core (seed, versions) is unusable. */
export function sanitizeMeta(raw: unknown): SaveMeta | null {
  if (!raw || typeof raw !== 'object') return null;
  const m = raw as Record<string, unknown>;
  const num = (v: unknown, lo: number, hi: number): number | undefined =>
    typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : undefined;
  if (typeof m.seed !== 'string' || !m.seed || typeof m.saveVersion !== 'number' || typeof m.genVersion !== 'number') return null;
  const out: SaveMeta = { saveVersion: m.saveVersion, genVersion: m.genVersion, seed: m.seed.slice(0, 64), savedAt: num(m.savedAt, 0, 1e15) ?? 0, player: null };
  const p = m.player as Record<string, unknown> | null;
  if (p && typeof p === 'object') {
    const [x, y, z, yaw, pitch] = [num(p.x, -1e6, 1e6), num(p.y, -1e4, 1e4), num(p.z, -1e6, 1e6), num(p.yaw, -1e4, 1e4), num(p.pitch, -1.55, 1.55)];
    if (x !== undefined && y !== undefined && z !== undefined) out.player = { x, y, z, yaw: yaw ?? 0, pitch: pitch ?? 0 };
  }
  const tod = num(m.timeOfDay, 0, 1);
  if (tod !== undefined) out.timeOfDay = tod % 1;
  const v = m.vitals as Record<string, unknown> | undefined;
  if (v && typeof v === 'object') out.vitals = { health: num(v.health, 1, 100) ?? 100, warmth: num(v.warmth, 0, 100) ?? 100, fed: num(v.fed, 0, 3600) ?? 0, afterglow: num(v.afterglow, 0, 600) ?? 0 };
  if (m.inventory && typeof m.inventory === 'object') {
    out.inventory = {};
    for (const [k, n] of Object.entries(m.inventory as Record<string, unknown>)) {
      const c = num(n, 0, 1e6);
      if (c !== undefined) out.inventory[k] = Math.floor(c);
    }
  }
  if (Array.isArray(m.picked)) out.picked = m.picked.filter((id): id is string => typeof id === 'string').slice(0, 200_000);
  if (Array.isArray(m.campfires)) {
    out.campfires = [];
    for (const f of m.campfires as Record<string, unknown>[]) {
      if (!f || typeof f !== 'object') continue;
      const [x, y, z] = [num(f.x, -1e6, 1e6), num(f.y, -1e4, 1e4), num(f.z, -1e6, 1e6)];
      const cooking = Array.isArray(f.cooking) ? (f.cooking as unknown[]).map((c) => num(c, 0, 60)).filter((c): c is number => c !== undefined).slice(0, 20) : [];
      if (x !== undefined && y !== undefined && z !== undefined) out.campfires.push({ x, y, z, fuel: num(f.fuel, 0, 1e5) ?? 0, cooking });
    }
    out.campfires = out.campfires.slice(0, 500);
  }
  if (m.stalks && typeof m.stalks === 'object') {
    out.stalks = {};
    for (const [k, n] of Object.entries(m.stalks as Record<string, unknown>)) {
      const c = num(n, 0, 1000);
      if (c !== undefined) out.stalks[k] = Math.floor(c);
    }
  }
  if (Array.isArray(m.milestones)) out.milestones = m.milestones.filter((x): x is string => typeof x === 'string').slice(0, 100);
  if (Array.isArray(m.packs)) {
    out.packs = [];
    for (const pk of m.packs as Record<string, unknown>[]) {
      if (!pk || typeof pk !== 'object') continue;
      const [x, y, z] = [num(pk.x, -1e6, 1e6), num(pk.y, -1e4, 1e4), num(pk.z, -1e6, 1e6)];
      const items: Record<string, number> = {};
      if (pk.items && typeof pk.items === 'object') for (const [k, n] of Object.entries(pk.items as Record<string, unknown>)) { const c = num(n, 0, 1e6); if (c) items[k] = Math.floor(c); }
      if (x !== undefined && y !== undefined && z !== undefined) out.packs.push({ x, y, z, items });
    }
    out.packs = out.packs.slice(0, 50);
  }
  if (typeof m.wasNight === 'boolean') out.wasNight = m.wasNight;
  const lampC = num(m.lamp, 0, 100);
  if (lampC !== undefined) out.lamp = lampC;
  const nights = num(m.nights, 0, 1e5);
  if (nights !== undefined) out.nights = Math.floor(nights);
  const h = m.horror as Record<string, unknown> | undefined;
  if (h && typeof h === 'object') out.horror = {
    figureSeen: h.figureSeen === true, figureNight: Math.floor(num(h.figureNight, -1, 1e5) ?? -1),
    played: Array.isArray(h.played) ? h.played.filter((x): x is string => typeof x === 'string').slice(0, 10) : [],
    last: typeof h.last === 'string' ? h.last.slice(0, 20) : null,
  };
  if (m.fresh && typeof m.fresh === 'object') {
    out.fresh = {};
    for (const [k, a] of Object.entries(m.fresh as Record<string, unknown>))
      if (Array.isArray(a)) out.fresh[k.slice(0, 32)] = a.map((x) => num(x, 0, 1e6)).filter((x): x is number => x !== undefined).slice(0, 1000);
  }
  if (Array.isArray(m.crates)) {
    out.crates = [];
    for (const c of m.crates as Record<string, unknown>[]) {
      if (!c || typeof c !== 'object') continue;
      const [x, y, z] = [num(c.x, -1e6, 1e6), num(c.y, -1e4, 1e4), num(c.z, -1e6, 1e6)];
      const items: Record<string, number> = {};
      if (c.items && typeof c.items === 'object') for (const [k, n] of Object.entries(c.items as Record<string, unknown>)) { const v = num(n, 0, 1e5); if (v) items[k.slice(0, 32)] = Math.floor(v); }
      const fresh: Record<string, number[]> = {};
      if (c.fresh && typeof c.fresh === 'object') for (const [k, a] of Object.entries(c.fresh as Record<string, unknown>))
        if (Array.isArray(a)) fresh[k.slice(0, 32)] = a.map((v) => num(v, 0, 1e6)).filter((v): v is number => v !== undefined).slice(0, 500);
      const wear: Record<string, number> = {};
      if (c.wear && typeof c.wear === 'object') for (const [k, n] of Object.entries(c.wear as Record<string, unknown>)) { const v = num(n, 0, 1e5); if (v) wear[k.slice(0, 32)] = Math.floor(v); }
      if (x !== undefined && y !== undefined && z !== undefined) out.crates.push({ x, y, z, rot: num(c.rot, -10, 10) ?? 0, items, fresh, ...(Object.keys(wear).length ? { wear } : {}) });
    }
    out.crates = out.crates.slice(0, 60);
  }
  if (m.wear && typeof m.wear === 'object') {
    out.wear = {};
    for (const [k, n] of Object.entries(m.wear as Record<string, unknown>)) { const v = num(n, 0, 1e5); if (v !== undefined) out.wear[k.slice(0, 32)] = Math.floor(v); }
  }
  if (Array.isArray(m.scanned)) out.scanned = m.scanned.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 32)).slice(0, 50);
  if (Array.isArray(m.seen)) out.seen = m.seen.filter((x): x is string => typeof x === 'string').map((x) => x.slice(0, 32)).slice(0, 100);
  const step = num(m.tutorialStep, 0, 1000);
  if (step !== undefined) out.tutorialStep = Math.floor(step);
  return out;
}

/** Why a stored save can't be played by this build (it is kept untouched, never deleted). */
export type Incompatible = { reason: string; raw: unknown; edits: Map<string, Float32Array> };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    // Another tab holds an older version of the database open: tell the player instead of hanging on "Loading".
    req.onblocked = () => reject(new Error('Biocrash is open in another tab with an older version. Close it and reload.'));
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer build wants to upgrade the database: let it (this tab stops saving rather than blocking it).
      db.onversionchange = () => { db.close(); SaveStore.onVersionChange?.(); };
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

const done = (tx: IDBTransaction) =>
  new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('Save transaction aborted'));
  });

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export class SaveStore {
  /** False when another tab already has this world open: this tab then never writes. */
  owner = true;
  /** Set before reset/import so the pagehide/autosave can't write the old world back. */
  suppressed = false;
  /** Set when the stored save can't be loaded by this build: the game runs a fresh world without saving over it. */
  incompatible: Incompatible | null = null;
  static onVersionChange?: () => void;

  private constructor(private db: IDBDatabase) {}

  static async open() {
    // Ask the browser not to evict our data (Safari wipes idle sites after 7 days otherwise). Never wait for the answer:
    // Firefox asks the player with a popup, and waiting left "Click to play" dead until it was answered.
    try { void navigator.storage?.persist?.().catch(() => {}); } catch { /* not supported */ }
    const store = new SaveStore(await openDb());
    await store.claim();
    return store;
  }

  /** Hold a Web Lock for the life of the tab; a second tab gets read-only mode. */
  private claim() {
    if (!navigator.locks) return Promise.resolve();
    return new Promise<void>((resolve) => {
      void navigator.locks.request('biocrash-world', { ifAvailable: true }, (lock) => {
        this.owner = !!lock;
        resolve();
        return lock ? new Promise<void>(() => {}) : undefined; // keep it until the tab closes
      });
    });
  }

  /** Load the save, migrating older versions. Returns null for a new world (and clears unusable data). */
  async load(): Promise<{ meta: SaveMeta; edits: Map<string, Float32Array> } | null> {
    const tx = this.db.transaction([META, CHUNKS], 'readonly');
    const meta = (await request(tx.objectStore(META).get('meta'))) as SaveMeta | undefined;
    const store = tx.objectStore(CHUNKS);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    if (!meta) {
      if (keys.length && this.owner) await this.clear(); // orphaned chunks from a discarded world
      return null;
    }
    const edits = new Map<string, Float32Array>();
    keys.forEach((k, i) => {
      const buf = values[i] as ArrayBuffer;
      if (buf?.byteLength === EDIT_BYTES) edits.set(String(k), new Float32Array(buf));
    });
    // Never delete a save we can't read: an old cached build must not wipe a newer world, and a generator change
    // must not wipe everyone's. Keep it, run a fresh world without saving, and offer Export / New world.
    const clean = sanitizeMeta(meta);
    let reason = '';
    if (!clean) reason = 'The saved world is damaged.';
    else if (clean.saveVersion > SAVE_VERSION || clean.genVersion > GEN_VERSION) reason = 'This world was saved by a newer version of Biocrash. Reload to update.';
    else if (clean.genVersion !== GEN_VERSION) reason = 'This world was made by an older world generator and can\u2019t be loaded.';
    else {
      const from = clean.saveVersion;
      if (!this.migrate(clean)) reason = 'This save is too old to load.';
      else if (from < SAVE_VERSION && this.owner) {
        // Keep the pre-upgrade metadata next to the save, just in case.
        const bt = this.db.transaction([META], 'readwrite');
        bt.objectStore(META).put(meta, `meta-backup-v${from}`);
        await done(bt);
      }
    }
    if (reason || !clean) {
      console.warn(reason, meta);
      this.incompatible = { reason, raw: meta, edits };
      this.suppressed = true;
      return null;
    }
    return { meta: clean, edits };
  }

  /** Last-resort export when the game can't even start: whatever is stored, unchecked. */
  static async dumpRaw(): Promise<Blob> {
    const db = await openDb();
    const tx = db.transaction([META, CHUNKS], 'readonly');
    const meta = await request(tx.objectStore(META).get('meta'));
    const store = tx.objectStore(CHUNKS);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    const chunks: Record<string, string> = {};
    keys.forEach((k, i) => { const b = values[i] as ArrayBuffer; if (b instanceof ArrayBuffer) chunks[String(k)] = toBase64(new Uint8Array(b)); });
    return new Blob([JSON.stringify({ ...(meta as object ?? {}), chunks })], { type: 'application/json' });
  }

  /** Last-resort wipe from the startup error screen. */
  static async wipe() {
    // Only if no other tab has this world open: it would re-save its own state on top of the wipe.
    if (navigator.locks) {
      const free = await navigator.locks.request('biocrash-world', { ifAvailable: true }, (lock) => !!lock);
      if (!free) throw new Error('This world is open in another tab. Close it first.');
    }
    const db = await openDb();
    const tx = db.transaction([META, CHUNKS], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(CHUNKS).clear();
    await done(tx);
  }

  /** Export exactly what's stored, unchecked (for a save this build can't load). */
  exportRaw(): Blob | null {
    const inc = this.incompatible;
    if (!inc) return null;
    const chunks: Record<string, string> = {};
    for (const [k, v] of inc.edits) chunks[k] = toBase64(new Uint8Array(v.buffer));
    return new Blob([JSON.stringify({ ...(inc.raw as object), chunks })], { type: 'application/json' });
  }

  private migrate(meta: SaveMeta) {
    while (meta.saveVersion < SAVE_VERSION) {
      const step = MIGRATIONS[meta.saveVersion];
      if (!step) return false;
      step(meta);
      meta.saveVersion++;
    }
    return true;
  }

  /** Write the meta plus changed chunks. Throws on failure so the caller can keep them dirty. */
  async save(meta: SaveMeta, dirty: Map<string, Float32Array>) {
    if (this.suppressed || !this.owner) return false;
    const tx = this.db.transaction([META, CHUNKS], 'readwrite');
    tx.objectStore(META).put(meta, 'meta');
    const chunks = tx.objectStore(CHUNKS);
    for (const [k, v] of dirty) chunks.put(v.buffer.slice(0), k);
    const finished = done(tx);
    tx.commit?.(); // flush now: this may be the last thing the page gets to do before it's hidden or closed
    await finished;
    return true;
  }

  async clear() {
    const tx = this.db.transaction([META, CHUNKS], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(CHUNKS).clear();
    await done(tx);
  }

  /** Delete this world for good (stops all further saving first). */
  async reset() {
    if (!this.owner) throw new Error('This world is open in another tab. Reset it there.');
    this.suppressed = true;
    await this.clear();
  }

  exportFile(meta: SaveMeta, edits: Map<string, Float32Array>): Blob {
    const chunks: Record<string, string> = {};
    for (const [k, v] of edits) chunks[k] = toBase64(new Uint8Array(v.buffer));
    const file: ExportFile = { ...meta, chunks };
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
  }

  /** Validate an export completely, then replace the current world in one transaction. */
  async importFile(text: string) {
    if (!this.owner) throw new Error('This world is open in another tab. Import it there.');
    let file: ExportFile;
    try { file = JSON.parse(text) as ExportFile; } catch { throw new Error('That file is not a Biocrash save.'); }
    if (!file || typeof file !== 'object' || typeof file.seed !== 'string' || typeof file.chunks !== 'object' || file.chunks === null)
      throw new Error('That file is not a Biocrash save.');
    if (file.genVersion !== GEN_VERSION || file.saveVersion > SAVE_VERSION)
      throw new Error(`This save is from a different game version (${file.saveVersion}/${file.genVersion}).`);
    const edits = new Map<string, Float32Array>();
    for (const [k, b64] of Object.entries(file.chunks)) {
      if (!KEY_RE.test(k) || typeof b64 !== 'string') throw new Error('The save file is damaged (bad chunk entry).');
      let bytes: Uint8Array;
      try { bytes = fromBase64(b64); } catch { throw new Error('The save file is damaged (bad chunk data).'); }
      if (bytes.byteLength !== EDIT_BYTES) throw new Error('The save file is damaged (wrong chunk size).');
      const f = new Float32Array(bytes.buffer);
      if (f.some((x) => !Number.isFinite(x))) throw new Error('The save file is damaged (invalid values).');
      edits.set(k, f);
    }
    const { chunks: _unused, ...rawMeta } = file;
    void _unused;
    const meta = sanitizeMeta(rawMeta);
    if (!meta) throw new Error('The save file is damaged.');
    if (!this.migrate(meta)) throw new Error('This save is too old to load.');

    // Everything checked: stop autosaves, then swap the whole world atomically.
    this.suppressed = true;
    try {
      const tx = this.db.transaction([META, CHUNKS], 'readwrite');
      tx.objectStore(META).clear();
      tx.objectStore(CHUNKS).clear();
      tx.objectStore(META).put(meta, 'meta');
      for (const [k, v] of edits) tx.objectStore(CHUNKS).put(v.buffer.slice(0), k);
      await done(tx); // all or nothing: a failure leaves the old world untouched
    } catch (err) {
      this.suppressed = false;
      throw err;
    }
  }
}

function toBase64(bytes: Uint8Array) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

function fromBase64(b64: string) {
  const s = atob(b64);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}
