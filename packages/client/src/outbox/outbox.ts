import type { OutboxStorage } from './storage.js';

/** A permanently failing endpoint must degrade, not fill the user's storage quota. */
export const OUTBOX_MAX_ENTRIES = 200;
/** Past this age, an entry is given up on rather than retried forever. */
export const OUTBOX_TTL_MS = 24 * 60 * 60 * 1000;

export interface Outbox {
  /** Persists `payload` before anything is sent — call this first, always. */
  add(eventId: string, payload: string): Promise<void>;
  /** Clears an entry once its `audit.ack` (or a confirmable beacon response) has arrived. */
  confirm(eventId: string): Promise<void>;
  /**
   * Replays everything still pending through `send`, oldest first —
   * called on init (covers a crash or an OS kill the page never got to
   * react to) and on every reconnect. Expired entries are dropped without
   * being sent. `send` returning `true` clears the entry immediately;
   * `false` leaves it for the next flush.
   */
  flushPending(send: (payload: string) => Promise<boolean>): Promise<void>;
}

export interface OutboxDeps {
  readonly storage: OutboxStorage;
  readonly now?: () => number;
}

export function createOutbox(deps: OutboxDeps): Outbox {
  const now = deps.now ?? (() => Date.now());

  async function prune(): Promise<void> {
    const all = await deps.storage.getAll();
    if (all.length <= OUTBOX_MAX_ENTRIES) return;
    const sorted = [...all].sort((a, b) => a.createdAt - b.createdAt);
    const excess = sorted.slice(0, all.length - OUTBOX_MAX_ENTRIES);
    for (const entry of excess) await deps.storage.delete(entry.eventId);
  }

  return {
    async add(eventId, payload) {
      await deps.storage.put({ eventId, payload, createdAt: now() });
      await prune();
    },

    async confirm(eventId) {
      await deps.storage.delete(eventId);
    },

    async flushPending(send) {
      const all = await deps.storage.getAll();
      const pending = [...all].sort((a, b) => a.createdAt - b.createdAt);

      for (const entry of pending) {
        if (now() - entry.createdAt > OUTBOX_TTL_MS) {
          await deps.storage.delete(entry.eventId); // given up on — too old to matter
          continue;
        }
        const confirmed = await send(entry.payload);
        if (confirmed) await deps.storage.delete(entry.eventId);
      }
    },
  };
}
