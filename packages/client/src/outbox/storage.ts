export interface OutboxEntry {
  readonly eventId: string;
  /** The already-built, JSON-encoded audit message — ready to send exactly as stored, no rebuilding. */
  readonly payload: string;
  readonly createdAt: number;
}

/**
 * What the outbox needs from storage, and nothing more — an injectable
 * seam so `outbox.test.ts` never touches real IndexedDB (which `jsdom`
 * does not implement), matching this SDK's existing pattern of injecting
 * every real browser dependency (`Clock`, `createSocket`, raf functions)
 * rather than reaching for the global directly.
 */
export interface OutboxStorage {
  put(entry: OutboxEntry): Promise<void>;
  delete(eventId: string): Promise<void>;
  getAll(): Promise<readonly OutboxEntry[]>;
}

const DB_NAME = 'copresence-outbox';
const STORE_NAME = 'entries';
const DB_VERSION = 1;

/** `IDBRequest`/`IDBTransaction.error` is `DOMException | null`, not an `Error` — wrap it into one so a rejection is always a real `Error`. */
function toError(domException: DOMException | null, fallback: string): Error {
  return domException ? new Error(domException.message) : new Error(fallback);
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      request.result.createObjectStore(STORE_NAME, { keyPath: 'eventId' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(toError(request.error, 'failed to open the outbox database'));
  });
}

/**
 * Persist-before-send, in practice: this is the one durable record of an
 * audit event that survives a crash or an OS kill — nothing else in this
 * SDK does, since everything else is in-memory and gone the moment the
 * page is. See ADR 0012.
 */
export function createIndexedDbStorage(factory: IDBFactory = indexedDB): OutboxStorage {
  return {
    async put(entry) {
      const db = await openDb(factory);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).put(entry);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(toError(tx.error, 'failed to write to the outbox database'));
      });
    },

    async delete(eventId) {
      const db = await openDb(factory);
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(eventId);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(toError(tx.error, 'failed to delete from the outbox database'));
      });
    },

    async getAll() {
      const db = await openDb(factory);
      return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readonly');
        const request = tx.objectStore(STORE_NAME).getAll();
        request.onsuccess = () => resolve(request.result as OutboxEntry[]);
        request.onerror = () => reject(toError(request.error, 'failed to read from the outbox database'));
      });
    },
  };
}
