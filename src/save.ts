// Saves = world seed + only the chunks the player has edited, in IndexedDB.
// Browsers can evict site data, so we ask for persistent storage and offer a file export.
import { GEN_VERSION, SAVE_VERSION } from './config';

export interface SaveMeta {
  saveVersion: number;
  genVersion: number;
  seed: string;
  player: { x: number; y: number; z: number; yaw: number; pitch: number } | null;
  savedAt: number;
  /** 0..1 time of day; optional so older saves still load. */
  timeOfDay?: number;
}

interface ExportFile extends SaveMeta {
  chunks: Record<string, string>; // key -> base64 Float32Array
}

const DB_NAME = 'biocrash';
const META = 'meta';
const CHUNKS = 'chunks';

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
    tx.onabort = () => reject(tx.error);
  });

const request = <T>(r: IDBRequest<T>) =>
  new Promise<T>((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });

export class SaveStore {
  private constructor(private db: IDBDatabase) {}

  static async open() {
    // Ask the browser not to evict our data (Safari wipes idle sites after 7 days otherwise).
    try { await navigator.storage?.persist?.(); } catch { /* not supported */ }
    return new SaveStore(await openDb());
  }

  async loadMeta(): Promise<SaveMeta | null> {
    const tx = this.db.transaction(META, 'readonly');
    const meta = (await request(tx.objectStore(META).get('meta'))) as SaveMeta | undefined;
    if (!meta) return null;
    if (meta.saveVersion !== SAVE_VERSION || meta.genVersion !== GEN_VERSION) {
      console.warn('Save from an older version; starting a new world.', meta);
      return null;
    }
    return meta;
  }

  async loadChunks(): Promise<Map<string, Float32Array>> {
    const out = new Map<string, Float32Array>();
    const tx = this.db.transaction(CHUNKS, 'readonly');
    const store = tx.objectStore(CHUNKS);
    const [keys, values] = await Promise.all([request(store.getAllKeys()), request(store.getAll())]);
    keys.forEach((k, i) => out.set(String(k), new Float32Array(values[i] as ArrayBuffer)));
    return out;
  }

  async save(meta: SaveMeta, dirty: Map<string, Float32Array>) {
    const tx = this.db.transaction([META, CHUNKS], 'readwrite');
    tx.objectStore(META).put(meta, 'meta');
    const chunks = tx.objectStore(CHUNKS);
    for (const [k, v] of dirty) chunks.put(v.buffer.slice(0), k);
    await done(tx);
  }

  async clear() {
    const tx = this.db.transaction([META, CHUNKS], 'readwrite');
    tx.objectStore(META).clear();
    tx.objectStore(CHUNKS).clear();
    await done(tx);
  }

  async exportFile(meta: SaveMeta, edits: Map<string, Float32Array>): Promise<Blob> {
    const chunks: Record<string, string> = {};
    for (const [k, v] of edits) chunks[k] = toBase64(new Uint8Array(v.buffer));
    const file: ExportFile = { ...meta, chunks };
    return new Blob([JSON.stringify(file)], { type: 'application/json' });
  }

  async importFile(text: string) {
    const file = JSON.parse(text) as ExportFile;
    if (file.saveVersion !== SAVE_VERSION || file.genVersion !== GEN_VERSION)
      throw new Error(`This save is from version ${file.saveVersion}/${file.genVersion}; the game is ${SAVE_VERSION}/${GEN_VERSION}.`);
    await this.clear();
    const edits = new Map<string, Float32Array>();
    for (const [k, b64] of Object.entries(file.chunks)) edits.set(k, new Float32Array(fromBase64(b64).buffer));
    const { chunks: _unused, ...meta } = file;
    void _unused;
    await this.save(meta, edits);
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
