/**
 * The offline till's disk: a thin, guarded promise wrapper over IndexedDB.
 *
 * ## Why this is hand-written
 *
 * For the same reason `public/sw.js` is. Which bytes may be persisted, under
 * what key, and what happens when the store cannot be opened are product
 * decisions on a till that has to survive a power cut holding unsynced sales —
 * not something to inherit from a library's defaults. The whole surface this app
 * needs is get/put/delete/getAll over two object stores, which is less code than
 * the dependency's install step and none of its surprises.
 *
 * ## Why every entry point is guarded
 *
 * `indexedDB` is absent during a server render, in jsdom (see `src/test/setup.ts`),
 * in some private-browsing modes, and on a browser old enough that none of this
 * matters. `idbAvailable()` is the one question callers ask; when the answer is
 * no they fall back to memory rather than throwing. A till that crashed on boot
 * because the tablet's storage was blocked would be an absurd thing to debug at a
 * counter — the same reasoning `browserRefreshTokenStorage` follows for
 * `localStorage`. Nothing here touches `indexedDB` at import time, so importing
 * this module during a server render is inert.
 *
 * ## Why writes wait for the transaction, not the request
 *
 * An IndexedDB `put` fires `onsuccess` before the transaction has committed. On a
 * queue holding money, resolving at `onsuccess` and then losing the tab would
 * report a sale as queued that the disk never kept. Writes therefore resolve on
 * `tx.oncomplete`; reads resolve on the request, whose result is final the moment
 * it succeeds.
 */

const DB_NAME = 'ab-chemist-offline';

/**
 * Bumped only when a store or an index is added. Version 1 creates the two
 * stores the offline till needs and nothing else.
 */
const DB_VERSION = 1;

/** Keyed by a caller-chosen string (`catalogue`, `taxSettings`, `session`). */
export const CACHE_STORE = 'cache';

/** Keyed by `clientSaleId`, which is already the sale's idempotency key. */
export const QUEUE_STORE = 'queue';

/** Whether this environment can persist offline at all. Never throws. */
export function idbAvailable(): boolean {
  try {
    return typeof indexedDB !== 'undefined' && indexedDB !== null;
  } catch {
    // Some browsers throw on *accessing* `indexedDB` when storage is blocked,
    // which is the same answer as it not existing: nothing can be persisted.
    return false;
  }
}

/** The one open database, or the one in-flight attempt to open it. */
let opening: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (opening !== null) return opening;

  opening = new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      // Guarded by `contains` so a future version bump that adds a store does not
      // throw on the ones that already exist — `createObjectStore` on an existing
      // name aborts the upgrade and leaves the database unopennable.
      if (!db.objectStoreNames.contains(CACHE_STORE)) {
        db.createObjectStore(CACHE_STORE, { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains(QUEUE_STORE)) {
        db.createObjectStore(QUEUE_STORE, { keyPath: 'clientSaleId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error('The offline store is blocked by another tab still using the old version'));
  });

  // A failed open is forgotten rather than cached, so the next call retries
  // instead of handing every later caller the same rejected promise forever. A
  // tablet that briefly could not open its disk during a storage-pressure moment
  // recovers on the next sale rather than staying broken until a reload.
  opening = opening.catch((error: unknown) => {
    opening = null;
    throw error;
  });

  return opening;
}

/** Resolves with a read request's result, which is final once it succeeds. */
function readRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Runs one readwrite operation and resolves only once it has committed.
 *
 * The operation is issued synchronously inside the transaction; awaiting
 * `tx.oncomplete` afterwards is what makes a resolved write a durable one.
 */
async function writeTransaction(
  store: string,
  issue: (objectStore: IDBObjectStore) => void
): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, 'readwrite');
  issue(tx.objectStore(store));
  await new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error ?? new Error('The offline write was aborted'));
  });
}

/** One record by key, or `undefined` when the store holds none. */
export async function idbGet<T>(store: string, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return readRequest<T | undefined>(
    db.transaction(store, 'readonly').objectStore(store).get(key) as IDBRequest<T | undefined>
  );
}

/** Every record in a store. Used to hydrate the queue at boot. */
export async function idbGetAll<T>(store: string): Promise<T[]> {
  const db = await openDb();
  return readRequest<T[]>(
    db.transaction(store, 'readonly').objectStore(store).getAll() as IDBRequest<T[]>
  );
}

/** Inserts or replaces one record, keyed by its own `keyPath` field. */
export async function idbPut(store: string, value: unknown): Promise<void> {
  await writeTransaction(store, (objectStore) => {
    objectStore.put(value);
  });
}

/** Removes one record by key. Deleting an absent key is not an error. */
export async function idbDelete(store: string, key: IDBValidKey): Promise<void> {
  await writeTransaction(store, (objectStore) => {
    objectStore.delete(key);
  });
}

/**
 * Empties a store.
 *
 * Used on sign-out, so one cashier's cached catalogue, tax settings and queued
 * sales are not left for the next person at the counter to inherit or replay.
 */
export async function idbClear(store: string): Promise<void> {
  await writeTransaction(store, (objectStore) => {
    objectStore.clear();
  });
}
