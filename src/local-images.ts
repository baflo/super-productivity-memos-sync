// Reads and writes SP's local image store. This is SP internals, not plugin
// API (see ClipboardImageService in SP): web keeps images in IndexedDB
// `sp-clipboard-images`/`images`, Electron in files `<id>.<ext>` in the
// clipboard image folder, reached through the preload bridge `window.ea`.
import { base64ToBlob, basePathFromFileUrl, blobToBase64, extensionFor } from './images';

const DB_NAME = 'sp-clipboard-images';
const STORE_NAME = 'images';

interface ElectronBridge {
  loadClipboardImage(
    basePath: string,
    imageId: string,
  ): Promise<{ base64: string; mimeType: string } | null>;
  saveClipboardImage(
    basePath: string,
    fileName: string,
    base64Data: string,
    mimeType: string,
  ): Promise<string>;
  getUserDataPath(): Promise<string>;
  isLinux(): boolean;
  isMacOS(): boolean;
}

export interface LocalImage {
  blob: Blob;
  mimeType: string;
}

const electron = (): ElectronBridge | undefined => {
  const ea = (globalThis as { ea?: Partial<ElectronBridge> }).ea;
  return ea?.loadClipboardImage && ea.saveClipboardImage
    ? (ea as ElectronBridge)
    : undefined;
};

// --- Web: IndexedDB ---------------------------------------------------------

let dbPromise: Promise<IDBDatabase> | null = null;

const openDb = (): Promise<IDBDatabase> => {
  // No version: open whatever version SP is at. Only when the database does
  // not exist yet is it created, with the same store layout as SP's.
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME);
    request.onupgradeneeded = (): void => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
      }
    };
    request.onsuccess = (): void => resolve(request.result);
    request.onerror = (): void => {
      dbPromise = null;
      reject(request.error ?? new Error('Failed to open the SP image database'));
    };
  });
  return dbPromise;
};

const idbRequest = <T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> =>
  openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const request = run(db.transaction([STORE_NAME], mode).objectStore(STORE_NAME));
        request.onsuccess = (): void => resolve(request.result);
        request.onerror = (): void => reject(request.error);
      }),
  );

// --- Electron: image folder -------------------------------------------------

let knownBasePath: string | undefined;

/** SP's default image folder, unless a file URL in the notes revealed another. */
const basePath = async (ea: ElectronBridge): Promise<string> => {
  if (knownBasePath) {
    return knownBasePath;
  }
  const sep = !ea.isLinux() && !ea.isMacOS() ? '\\' : '/';
  return `${await ea.getUserDataPath()}${sep}clipboard-images`;
};

/** Remembers the image folder of a `file:///…` image URL seen in the notes. */
export const noteImageUrl = (url: string): void => {
  knownBasePath = basePathFromFileUrl(url) ?? knownBasePath;
};

// --- API --------------------------------------------------------------------

export const readLocalImage = async (id: string): Promise<LocalImage | null> => {
  const ea = electron();
  if (ea) {
    const file = await ea.loadClipboardImage(await basePath(ea), id);
    return file
      ? { blob: base64ToBlob(file.base64, file.mimeType), mimeType: file.mimeType }
      : null;
  }
  const entry = await idbRequest<{ blob?: Blob; mimeType?: string } | undefined>(
    'readonly',
    (store) => store.get(id),
  );
  return entry?.blob
    ? { blob: entry.blob, mimeType: entry.mimeType || entry.blob.type || 'image/png' }
    : null;
};

export const saveLocalImage = async (
  id: string,
  blob: Blob,
  mimeType: string,
): Promise<void> => {
  const ea = electron();
  if (ea) {
    await ea.saveClipboardImage(
      await basePath(ea),
      `${id}.${extensionFor(mimeType)}`,
      await blobToBase64(blob),
      mimeType,
    );
    return;
  }
  await idbRequest('readwrite', (store) =>
    store.put({ id, blob, mimeType, createdAt: Date.now(), size: blob.size }),
  );
};
