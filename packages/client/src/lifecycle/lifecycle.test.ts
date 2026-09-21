// @vitest-environment jsdom
import type { AuditMessage } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import type { Beacon } from '../beacon/beacon.js';
import type { Outbox } from '../outbox/outbox.js';
import { createWireContext } from '../wire.js';

import { createLifecycle } from './lifecycle.js';

function fakeDoc(initialState: DocumentVisibilityState): {
  doc: Document;
  setVisibility: (state: DocumentVisibilityState) => void;
  fireVisibilityChange: () => void;
} {
  const target = new EventTarget();
  let state = initialState;
  const doc = {
    get visibilityState() {
      return state;
    },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Document;
  return {
    doc,
    setVisibility: (next) => {
      state = next;
    },
    fireVisibilityChange: () => target.dispatchEvent(new Event('visibilitychange')),
  };
}

function fakeWin(): { win: Window; firePageHide: (persisted: boolean) => void } {
  const target = new EventTarget();
  const win = {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
  } as unknown as Window;
  return {
    win,
    firePageHide: (persisted) => {
      const event = new Event('pagehide') as Event & { persisted: boolean };
      Object.defineProperty(event, 'persisted', { value: persisted });
      target.dispatchEvent(event);
    },
  };
}

function fakeOutbox(): Outbox & {
  entries: Map<string, string>;
  flushCallCount: () => number;
} {
  const entries = new Map<string, string>();
  let flushCallCount = 0;
  return {
    entries,
    flushCallCount: () => flushCallCount,
    add: (eventId, payload) => {
      entries.set(eventId, payload);
      return Promise.resolve();
    },
    confirm: (eventId) => {
      entries.delete(eventId);
      return Promise.resolve();
    },
    flushPending: async (send) => {
      flushCallCount += 1;
      for (const [eventId, payload] of [...entries]) {
        const confirmed = await send(payload);
        if (confirmed) entries.delete(eventId);
      }
    },
  };
}

function fakeBeacon(overrides: { confirmable?: boolean; bestEffort?: boolean } = {}): Beacon & {
  confirmableCalls: string[];
  bestEffortCalls: string[];
} {
  const confirmableCalls: string[] = [];
  const bestEffortCalls: string[] = [];
  return {
    confirmableCalls,
    bestEffortCalls,
    sendBestEffort: (payload) => {
      bestEffortCalls.push(payload);
      return overrides.bestEffort ?? true;
    },
    sendConfirmable: (payload) => {
      confirmableCalls.push(payload);
      return Promise.resolve(overrides.confirmable ?? true);
    },
  };
}

async function flush(): Promise<void> {
  // Lets any pending microtask chains inside lifecycle's fire-and-forget `emit()` calls settle before assertions run.
  await Promise.resolve();
  await Promise.resolve();
}

describe('createLifecycle', () => {
  it('start() with the page already visible opens a session', async () => {
    const { doc } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });

    lifecycle.start();
    await flush();

    expect(sent.map((m) => m.t)).toEqual(['session.start']);
  });

  it('start() with the page already hidden does not open a session', async () => {
    const { doc } = fakeDoc('hidden');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });

    lifecycle.start();
    await flush();

    expect(sent).toEqual([]);
  });

  it('start() always replays the outbox via the confirmable beacon path, regardless of visibility', async () => {
    const { doc } = fakeDoc('hidden');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    outbox.entries.set('stale-1', '{"t":"session.end"}');
    const beacon = fakeBeacon();
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: () => undefined,
      isSocketOpen: () => true,
    });

    lifecycle.start();
    await flush();

    expect(outbox.flushCallCount()).toBe(1);
    expect(beacon.confirmableCalls).toEqual(['{"t":"session.end"}']);
    expect(outbox.entries.has('stale-1')).toBe(false); // confirmed, so cleared
  });

  it('hidden → visible emits visibility.change then opens a new session', async () => {
    const { doc, setVisibility, fireVisibilityChange } = fakeDoc('hidden');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();

    setVisibility('visible');
    fireVisibilityChange();
    await flush();

    expect(sent.map((m) => m.t)).toEqual(['visibility.change', 'session.start']);
  });

  it('visible → hidden emits visibility.change then closes the session with reason "navigate"', async () => {
    const { doc, setVisibility, fireVisibilityChange } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    sent.length = 0; // discard the initial session.start

    setVisibility('hidden');
    fireVisibilityChange();
    await flush();

    expect(sent.map((m) => m.t)).toEqual(['visibility.change', 'session.end']);
    const end = sent.find((m) => m.t === 'session.end');
    expect(end).toMatchObject({ reason: 'navigate' });
  });

  it('a repeated visibilitychange firing with no actual state change emits nothing new', async () => {
    const { doc, fireVisibilityChange } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    const afterStart = sent.length;

    fireVisibilityChange(); // still 'visible' — nothing genuinely changed
    await flush();

    expect(sent.length).toBe(afterStart);
  });

  it('when the socket is open, emit() sends over it and does not touch the beacon', async () => {
    const { doc } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: () => undefined,
      isSocketOpen: () => true,
    });

    lifecycle.start();
    await flush();

    expect(beacon.confirmableCalls).toEqual([]); // only the (empty) start()-time flush touches the beacon
  });

  it('when the socket is closed, emit() persists then delivers via the confirmable beacon and confirms on success', async () => {
    const { doc } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon({ confirmable: true });
    const sentOverSocket: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sentOverSocket.push(m),
      isSocketOpen: () => false,
    });

    lifecycle.start();
    await flush();

    expect(sentOverSocket).toEqual([]);
    expect(beacon.confirmableCalls).toHaveLength(1);
    expect(outbox.entries.size).toBe(0); // confirmed and cleared
  });

  it('handleAck() confirms the matching outbox entry', async () => {
    const { doc } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: () => undefined,
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    const [eventId] = outbox.entries.keys();

    lifecycle.handleAck(eventId!);
    await flush();

    expect(outbox.entries.has(eventId!)).toBe(false);
  });

  it('pagehide with persisted:true flushes via the confirmable beacon path', async () => {
    const { doc } = fakeDoc('hidden');
    const { win, firePageHide } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: () => undefined,
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    beacon.confirmableCalls.length = 0; // discard start()'s own (empty) flush
    // Seeded after start()'s own flush already ran, so it is genuinely still pending when pagehide fires — e.g. a session.end built moments earlier that has not yet been acknowledged.
    outbox.entries.set('evt-1', '{"t":"session.end"}');

    firePageHide(true);
    await flush();

    expect(beacon.confirmableCalls).toContain('{"t":"session.end"}');
    expect(beacon.bestEffortCalls).toEqual([]);
  });

  it('pagehide with persisted:false flushes via the best-effort beacon path only', async () => {
    const { doc } = fakeDoc('hidden');
    const { win, firePageHide } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: () => undefined,
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    beacon.confirmableCalls.length = 0;
    outbox.entries.set('evt-1', '{"t":"session.end"}');

    firePageHide(false);
    await flush();

    expect(beacon.bestEffortCalls).toContain('{"t":"session.end"}');
    expect(beacon.confirmableCalls).toEqual([]);
  });

  it('stop() removes listeners — a subsequent visibilitychange is a no-op', async () => {
    const { doc, setVisibility, fireVisibilityChange } = fakeDoc('visible');
    const { win } = fakeWin();
    const outbox = fakeOutbox();
    const beacon = fakeBeacon();
    const sent: AuditMessage[] = [];
    const lifecycle = createLifecycle({
      doc,
      win,
      wire: createWireContext('s1', 'p1'),
      outbox,
      beacon,
      sendOverSocket: (m) => sent.push(m),
      isSocketOpen: () => true,
    });
    lifecycle.start();
    await flush();
    lifecycle.stop();
    const before = sent.length;

    setVisibility('hidden');
    fireVisibilityChange();
    await flush();

    expect(sent.length).toBe(before);
  });
});
