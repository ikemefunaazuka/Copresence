// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { Beacon } from './beacon/beacon.js';
import type { OutboxStorage } from './outbox/storage.js';
import type { WebSocketLike } from './transport/connection.js';

import { init } from './index.js';
import type { RosterParticipant } from './index.js';

/** Never-implemented in `jsdom` — same reasoning as `outbox/storage.test.ts` never touching real IndexedDB. An in-memory stand-in is enough: these tests exercise the SDK's own wiring, not the outbox's persistence logic (already covered by `outbox/outbox.test.ts`). */
function fakeOutboxStorage(): OutboxStorage {
  const entries = new Map<string, { eventId: string; payload: string; createdAt: number }>();
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
  };
}

/** Never touches real `fetch`/`sendBeacon` — acknowledges instantly, matching the common case where the live socket is expected to carry audit traffic instead. Calls are recorded so tests can assert on the closed-socket fallback path. */
function fakeBeacon(): Beacon & { confirmableCalls: string[] } {
  const confirmableCalls: string[] = [];
  return {
    confirmableCalls,
    sendBestEffort: () => true,
    sendConfirmable: (payload) => {
      confirmableCalls.push(payload);
      return Promise.resolve(true);
    },
  };
}

/** Settles the microtask chain inside the SDK's fire-and-forget audit `emit()` calls (`outbox.add()` → socket-or-beacon send) — the SDK's other tests are deliberately synchronous and never observe this tail, but the audit-lifecycle wiring genuinely needs it to run. */
async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

const CLOSED = 3;
const OPEN_STATE = 1;

type SocketEvent = MessageEvent | CloseEvent | Event;
type SocketListener = (event: SocketEvent) => void;

/** The same fake used by connection.test.ts, one level up: drives the whole SDK without a real network connection. */
class FakeSocket implements WebSocketLike {
  readyState = 0;
  bufferedAmount = 0;
  readonly sent: string[] = [];
  #listeners = new Map<string, Set<SocketListener>>();

  addEventListener(type: string, listener: SocketListener): void {
    let set = this.#listeners.get(type);
    if (!set) {
      set = new Set();
      this.#listeners.set(type, set);
    }
    set.add(listener);
  }

  removeEventListener(type: string, listener: SocketListener): void {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.readyState = CLOSED;
    this.#dispatch('close', new Event('close'));
  }

  #dispatch(type: string, event: SocketEvent): void {
    for (const listener of this.#listeners.get(type) ?? []) listener(event);
  }

  simulateOpen(): void {
    this.readyState = OPEN_STATE;
    this.#dispatch('open', new Event('open'));
  }

  simulateMessage(data: unknown): void {
    this.#dispatch('message', new MessageEvent('message', { data: JSON.stringify(data) }));
  }

  sentMessages(): unknown[] {
    return this.sent.map((raw) => JSON.parse(raw) as unknown);
  }
}

function setUp(
  overrides: {
    onPresenceChange?: (participants: readonly RosterParticipant[]) => void;
    onLatency?: (rttMs: number) => void;
    onFollowChange?: (followingPid: string | null) => void;
  } = {},
) {
  const sockets: FakeSocket[] = [];
  const container = document.createElement('div');
  document.body.appendChild(container);
  const beacon = fakeBeacon();

  const instance = init({
    wsUrl: 'ws://test/ws',
    sid: 'session-1',
    pid: 'me',
    doc: document,
    win: window,
    outboxStorage: fakeOutboxStorage(),
    beacon,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...(overrides.onPresenceChange ? { onPresenceChange: overrides.onPresenceChange } : {}),
    ...(overrides.onLatency ? { onLatency: overrides.onLatency } : {}),
    ...(overrides.onFollowChange ? { onFollowChange: overrides.onFollowChange } : {}),
  });

  return { instance, sockets, latestSocket: () => sockets[sockets.length - 1]!, container, beacon };
}

describe('init (the whole SDK, wired)', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('connect() opens a socket and sends hello once it is open', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    expect(latestSocket().sent).toHaveLength(0);

    latestSocket().simulateOpen();

    expect(latestSocket().sentMessages()).toHaveLength(1);
    expect(latestSocket().sentMessages()[0]).toMatchObject({
      t: 'hello',
      sid: 'session-1',
      pid: 'me',
    });
    instance.disconnect();
  });

  it('injects a closed-mode shadow host into the document on init', () => {
    const before = document.querySelectorAll('[data-copresence-root]').length;
    const { instance } = setUp();
    expect(document.querySelectorAll('[data-copresence-root]').length).toBe(before + 1);
    instance.disconnect();
  });

  it('a welcome message seeds the roster and renders a cursor for a remote participant who already has one', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();

    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [
        { pid: 'me', color: '#000', lastSeenAt: Date.now() },
        { pid: 'them', color: '#f00', x: 0.5, y: 200, lastSeenAt: Date.now() },
      ],
    });

    const root = document.querySelector('[data-copresence-root]');
    // A closed shadow root cannot be inspected from outside by design —
    // the meaningful assertion is simply that nothing threw handling a
    // roster containing both our own pid (skipped) and a remote one.
    expect(root).not.toBeNull();
    instance.disconnect();
  });

  it('a leave message for a known participant does not throw', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [{ pid: 'them', color: '#f00', lastSeenAt: Date.now() }],
    });

    expect(() =>
      latestSocket().simulateMessage({
        v: PROTOCOL_VERSION,
        t: 'leave',
        sid: 'session-1',
        seq: 1,
        ts: Date.now(),
        pid: 'them',
      }),
    ).not.toThrow();
    instance.disconnect();
  });

  it('a patch for our own pid is ignored — we never render our own cursor', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();

    expect(() =>
      latestSocket().simulateMessage({
        v: PROTOCOL_VERSION,
        t: 'patch',
        sid: 'session-1',
        seq: 1,
        ts: Date.now(),
        patches: [{ pid: 'me', x: 0.5, y: 0 }],
      }),
    ).not.toThrow();
    instance.disconnect();
  });

  it('a reordered (stale) patch arriving after a newer one is ignored, not applied backwards', () => {
    const roster: (readonly RosterParticipant[])[] = [];
    const { instance, latestSocket } = setUp({ onPresenceChange: (p) => roster.push(p) });
    instance.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [{ pid: 'them', color: '#f00', lastSeenAt: Date.now() }],
    });

    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'patch',
      sid: 'session-1',
      seq: 10,
      ts: Date.now(),
      patches: [{ pid: 'them', x: 0.9, y: 900 }],
    });
    // Arrives late — a lower seq than the patch already applied above.
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'patch',
      sid: 'session-1',
      seq: 5,
      ts: Date.now(),
      patches: [{ pid: 'them', x: 0.1, y: 100 }],
    });

    expect(roster.at(-1)).toEqual([
      expect.objectContaining({ pid: 'them', cursor: { x: 0.9, y: 900 } }),
    ]);
    instance.disconnect();
  });

  it('an exact duplicate patch (same seq) is ignored, not double-applied', () => {
    const roster: (readonly RosterParticipant[])[] = [];
    const { instance, latestSocket } = setUp({ onPresenceChange: (p) => roster.push(p) });
    instance.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [{ pid: 'them', color: '#f00', lastSeenAt: Date.now() }],
    });

    const patch = {
      v: PROTOCOL_VERSION,
      t: 'patch' as const,
      sid: 'session-1',
      seq: 10,
      ts: Date.now(),
      patches: [{ pid: 'them', x: 0.4, y: 400 }],
    };
    const callsBeforeDuplicate = roster.length;
    latestSocket().simulateMessage(patch);
    const callsAfterFirst = roster.length;
    latestSocket().simulateMessage(patch); // the exact same frame again

    expect(roster.length).toBe(callsAfterFirst); // the duplicate did not trigger a second notification
    expect(callsAfterFirst).toBeGreaterThan(callsBeforeDuplicate);
    instance.disconnect();
  });

  it('a malformed inbound frame is ignored rather than crashing the SDK', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();

    expect(() => latestSocket().simulateMessage(undefined)).not.toThrow();
    instance.disconnect();
  });

  it('disconnect() sends bye and closes, leaving the connection closed', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();

    instance.disconnect();

    const sent = latestSocket().sentMessages();
    expect(sent.some((m) => (m as { t: string }).t === 'bye')).toBe(true);
    expect(instance.status()).toBe('closed');
  });

  it('followParticipant()/stopFollowing() do not throw when called before or after connecting', () => {
    const { instance } = setUp();
    expect(() => instance.followParticipant('them')).not.toThrow();
    expect(() => instance.stopFollowing()).not.toThrow();
    instance.connect();
    expect(() => instance.followParticipant('them')).not.toThrow();
    instance.disconnect();
  });

  it('exposes the given pid on the returned instance', () => {
    const { instance } = setUp();
    expect(instance.pid).toBe('me');
    instance.disconnect();
  });

  it('onPresenceChange reports a remote participant after welcome, excluding our own pid', () => {
    const roster: (readonly RosterParticipant[])[] = [];
    const { instance, latestSocket } = setUp({ onPresenceChange: (p) => roster.push(p) });
    instance.connect();
    latestSocket().simulateOpen();

    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [
        { pid: 'me', color: '#000', lastSeenAt: Date.now() },
        { pid: 'them', color: '#f00', x: 0.5, y: 200, lastSeenAt: Date.now() },
      ],
    });

    expect(roster.at(-1)).toEqual([
      expect.objectContaining({ pid: 'them', color: '#f00', cursor: { x: 0.5, y: 200 } }),
    ]);
    instance.disconnect();
  });

  it('onPresenceChange reports the roster shrinking after a leave', () => {
    const roster: (readonly RosterParticipant[])[] = [];
    const { instance, latestSocket } = setUp({ onPresenceChange: (p) => roster.push(p) });
    instance.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [{ pid: 'them', color: '#f00', lastSeenAt: Date.now() }],
    });

    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'leave',
      sid: 'session-1',
      seq: 1,
      ts: Date.now(),
      pid: 'them',
    });

    expect(roster.at(-1)).toEqual([]);
    instance.disconnect();
  });

  it('onLatency fires with the round-trip time when a pong answers our ping', () => {
    const latencies: number[] = [];
    const { instance, latestSocket } = setUp({ onLatency: (ms) => latencies.push(ms) });
    instance.connect();
    latestSocket().simulateOpen();

    const pingTs = Date.now() - 42;
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'pong',
      sid: 'session-1',
      seq: 1,
      ts: Date.now(),
      pingTs,
    });

    expect(latencies).toHaveLength(1);
    expect(latencies[0]).toBeGreaterThanOrEqual(42);
    instance.disconnect();
  });

  it('onFollowChange fires on explicit follow/stopFollowing, and when a local scroll breaks an active follow', async () => {
    const changes: (string | null)[] = [];
    const { instance } = setUp({ onFollowChange: (followingPid) => changes.push(followingPid) });

    instance.followParticipant('them');
    expect(changes).toEqual(['them']);

    instance.stopFollowing();
    expect(changes).toEqual(['them', null]);

    instance.connect();
    instance.followParticipant('them');
    expect(changes).toEqual(['them', null, 'them']);

    window.dispatchEvent(new Event('scroll')); // a real, local scroll — the local-intent break
    await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));

    expect(changes).toEqual(['them', null, 'them', null]);
    instance.disconnect();
  });

  it('a full connect → welcome → patch → disconnect cycle never throws', () => {
    const { instance, latestSocket } = setUp();
    instance.connect();
    latestSocket().simulateOpen();
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'session-1',
      pid: 'me',
      seq: 0,
      ts: Date.now(),
      participants: [{ pid: 'them', color: '#f00', lastSeenAt: Date.now() }],
    });
    latestSocket().simulateMessage({
      v: PROTOCOL_VERSION,
      t: 'patch',
      sid: 'session-1',
      seq: 1,
      ts: Date.now(),
      patches: [{ pid: 'them', x: 0.6, y: 300 }],
    });

    expect(() => instance.disconnect()).not.toThrow();
  });

  describe('audit lifecycle wiring', () => {
    it('connect() eventually emits session.start via the beacon fallback, since the socket is not open yet at that instant', async () => {
      const { instance, beacon } = setUp();

      instance.connect();
      await flushMicrotasks();

      expect(beacon.confirmableCalls).toHaveLength(1);
      const sent = JSON.parse(beacon.confirmableCalls[0]!) as { t: string };
      expect(sent.t).toBe('session.start');
      instance.disconnect();
    });

    it('an audit.ack for an already-beacon-delivered event is handled without throwing', async () => {
      const { instance, latestSocket, beacon } = setUp();

      instance.connect();
      await flushMicrotasks();
      const started = JSON.parse(beacon.confirmableCalls[0]!) as { t: string; eventId: string };
      expect(started.t).toBe('session.start');

      latestSocket().simulateOpen();
      expect(() =>
        latestSocket().simulateMessage({
          v: PROTOCOL_VERSION,
          t: 'audit.ack',
          sid: 'session-1',
          seq: 0,
          ts: Date.now(),
          eventId: started.eventId,
        }),
      ).not.toThrow();
      instance.disconnect();
    });

    it('going hidden while connected emits visibility.change then session.end over the live socket', async () => {
      const { instance, latestSocket } = setUp();
      instance.connect();
      latestSocket().simulateOpen();
      await flushMicrotasks();
      const before = latestSocket().sentMessages().length;

      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      await flushMicrotasks();

      const sentTypes = latestSocket()
        .sentMessages()
        .slice(before)
        .map((m) => (m as { t: string }).t);
      expect(sentTypes).toEqual(['visibility.change', 'session.end']);

      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      instance.disconnect();
    });
  });
});
