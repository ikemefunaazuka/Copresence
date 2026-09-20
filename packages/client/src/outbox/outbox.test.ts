import { describe, expect, it } from 'vitest';

import { createOutbox, OUTBOX_MAX_ENTRIES } from './outbox.js';
import type { OutboxEntry, OutboxStorage } from './storage.js';

/** An in-memory stand-in for IndexedDB — `jsdom` does not implement it, and the outbox's own logic does not need a real one to be tested. */
function fakeStorage(): OutboxStorage & { size(): number } {
  const entries = new Map<string, OutboxEntry>();
  return {
    put: (entry) => {
      entries.set(entry.eventId, entry);
      return Promise.resolve();
    },
    delete: (eventId) => {
      entries.delete(eventId);
      return Promise.resolve();
    },
    getAll: () => Promise.resolve(Array.from(entries.values())),
    size: () => entries.size,
  };
}

describe('createOutbox', () => {
  it('add() persists the entry before anything is sent', async () => {
    const storage = fakeStorage();
    const outbox = createOutbox({ storage });

    await outbox.add('evt-1', '{"t":"session.start"}');

    const all = await storage.getAll();
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ eventId: 'evt-1', payload: '{"t":"session.start"}' });
  });

  it('confirm() removes the entry', async () => {
    const storage = fakeStorage();
    const outbox = createOutbox({ storage });
    await outbox.add('evt-1', '{}');

    await outbox.confirm('evt-1');

    expect(await storage.getAll()).toEqual([]);
  });

  it('confirm() for an unknown eventId is a total no-op', async () => {
    const storage = fakeStorage();
    const outbox = createOutbox({ storage });

    await expect(outbox.confirm('ghost')).resolves.not.toThrow();
  });

  it('flushPending() sends every entry, oldest first, and clears only the confirmed ones', async () => {
    const storage = fakeStorage();
    let clock = 0;
    const outbox = createOutbox({ storage, now: () => clock });

    clock = 100;
    await outbox.add('evt-2', 'second');
    clock = 50;
    await outbox.add('evt-1', 'first'); // added later in time, but with an earlier createdAt

    const order: string[] = [];
    await outbox.flushPending((payload) => {
      order.push(payload);
      return Promise.resolve(payload === 'first'); // only confirm one of the two
    });

    expect(order).toEqual(['first', 'second']); // sent oldest (by createdAt) first
    const remaining = await storage.getAll();
    expect(remaining.map((e) => e.eventId)).toEqual(['evt-2']); // only the unconfirmed one is left
  });

  it('flushPending() drops an expired entry without ever attempting to send it', async () => {
    const storage = fakeStorage();
    let clock = 0;
    const outbox = createOutbox({ storage, now: () => clock });
    await outbox.add('evt-old', 'stale');

    clock = 24 * 60 * 60 * 1000 + 1; // just past the 24h TTL
    let sendCalled = false;
    await outbox.flushPending(() => {
      sendCalled = true;
      return Promise.resolve(true);
    });

    expect(sendCalled).toBe(false);
    expect(await storage.getAll()).toEqual([]);
  });

  it('flushPending() with nothing pending never calls send', async () => {
    const storage = fakeStorage();
    const outbox = createOutbox({ storage });

    let called = false;
    await outbox.flushPending(() => {
      called = true;
      return Promise.resolve(true);
    });

    expect(called).toBe(false);
  });

  it('add() prunes the oldest entries once past OUTBOX_MAX_ENTRIES', async () => {
    const storage = fakeStorage();
    let clock = 0;
    const outbox = createOutbox({ storage, now: () => clock });

    for (let i = 0; i < OUTBOX_MAX_ENTRIES + 5; i += 1) {
      clock = i;
      await outbox.add(`evt-${i}`, String(i));
    }

    expect(storage.size()).toBe(OUTBOX_MAX_ENTRIES);
    const remaining = await storage.getAll();
    // The 5 oldest (evt-0..evt-4) were pruned; the newest survive.
    expect(remaining.some((e) => e.eventId === 'evt-0')).toBe(false);
    expect(remaining.some((e) => e.eventId === `evt-${OUTBOX_MAX_ENTRIES + 4}`)).toBe(true);
  });
});
