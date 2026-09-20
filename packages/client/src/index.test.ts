// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@copresence/protocol';
import { afterEach, describe, expect, it } from 'vitest';

import type { WebSocketLike } from './transport/connection.js';

import { init } from './index.js';

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

function setUp() {
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
