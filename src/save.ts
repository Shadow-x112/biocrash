// Saves = world seed + only the chunks the player has edited, in IndexedDB.
// Rules: one tab owns the save (Web Locks), old saves are migrated forward where possible,
// imports are fully validated before anything is replaced, and reset/import suppress further saves.
import { CHUNK, GEN_VERSION, SAVE_VERSION } from './config';
import type { CampfireSave } from './campfire';

export interface SaveMeta {
  saveVersion: number;
  genVersion: number;
  seed: string;
  player: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  savedAt: number;
  /** 0..1 time of day; optional so older saves still load. */
  timeOfDay?: number;
  vitals?: { health: number; warmth: number };
  inventory?: Record<string, number>;
  /** Ids of props the player has picked up. */
  picked?: string[];
  campfires?: CampfireSave[];
  /** Times each giant mushroom stalk has been cut. */
  stalks?: Record<string, number>;
  /** Station-core objective reached (first-night tutorial). */
  tutorialStep?: number;
}

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

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS);
    };
    req.onsuccess = () => resolve(req.result);
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

  private constructor(private db: IDBDatabase) {}

  static async open() {
    // Ask the browser not to evict our data (Safari wipes idle sites after 7 days otherwise).
    try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
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
    if (meta.genVersion !== GEN_VERSION || meta.saveVersion > SAVE_VERSION || !this.migrate(meta)) {
      console.warn('Save cannot be upgraded; starting a new world.', meta);
      if (this.owner) await this.clear();
      return null;
    }
    const edits = new Map<string, Float32Array>();
    keys.forEach((k, i) => {
      const buf = values[i] as ArrayBuffer;
      if (buf?.byteLength === EDIT_BYTES) edits.set(String(k), new Float32Array(buf));
    });
    return { meta, edits };
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
    await done(tx);
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
    const { chunks: _unused, ...meta } = file;
    void _unused;
    if (!this.migrate(meta)) throw new Error('This save is too old to load.');
    if (meta.inventory) for (const [k, v] of Object.entries(meta.inventory)) if (!Number.isFinite(v) || v < 0) meta.inventory[k] = 0;

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
