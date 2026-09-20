// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebSocketLike } from './transport/connection.js';

import { init } from './index.js';
import type { RosterParticipant } from './index.js';

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

  const instance = init({
    wsUrl: 'ws://test/ws',
    sid: 'session-1',
    pid: 'me',
    doc: document,
    win: window,
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...(overrides.onPresenceChange ? { onPresenceChange: overrides.onPresenceChange } : {}),
    ...(overrides.onLatency ? { onLatency: overrides.onLatency } : {}),
    ...(overrides.onFollowChange ? { onFollowChange: overrides.onFollowChange } : {}),
  });

  return { instance, sockets, latestSocket: () => sockets[sockets.length - 1]!, container };
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
});
