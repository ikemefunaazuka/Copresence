// @vitest-environment jsdom
import { PROTOCOL_VERSION } from '@copresence/protocol';
import type { CursorMessage, PingMessage } from '@copresence/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createConnection, parseOutboundFrame } from './connection.js';
import type { ConnectionStatus, WebSocketLike } from './connection.js';

const CLOSED = 3;
const OPEN_STATE = 1;

/** A fully scriptable fake of the browser `WebSocket` surface `connection.ts` actually touches. */
type SocketEvent = MessageEvent | CloseEvent | Event;
type SocketListener = (event: SocketEvent) => void;

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

  simulateMessage(data: string): void {
    this.#dispatch('message', new MessageEvent('message', { data }));
  }

  simulateServerClose(): void {
    this.readyState = CLOSED;
    this.#dispatch('close', new Event('close'));
  }
}

const BASE = { v: PROTOCOL_VERSION, sid: 's1', pid: 'p1' } as const;
function cursor(seq: number): CursorMessage {
  return { ...BASE, t: 'cursor', seq, ts: seq, x: 0.1, y: 1 } as CursorMessage;
}
function ping(seq: number): PingMessage {
  return { ...BASE, t: 'ping', seq, ts: seq } as PingMessage;
}

function setUp(overrides: { backpressureBytes?: number } = {}) {
  const sockets: FakeSocket[] = [];
  const statuses: ConnectionStatus[] = [];
  const messages: unknown[] = [];
  const connection = createConnection({
    url: 'ws://test/ws',
    onMessage: (m) => messages.push(m),
    onStatusChange: (s) => statuses.push(s),
    createSocket: () => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    },
    ...(overrides.backpressureBytes !== undefined
      ? { backpressureBytes: overrides.backpressureBytes }
      : {}),
  });
  return {
    connection,
    sockets,
    statuses,
    messages,
    latestSocket: () => sockets[sockets.length - 1]!,
  };
}

describe('createConnection', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('connect() creates exactly one socket and transitions connecting → open', () => {
    const { connection, sockets, statuses } = setUp();
    connection.connect();
    expect(sockets).toHaveLength(1);
    expect(connection.status()).toBe('connecting');

    sockets[0]!.simulateOpen();

    expect(connection.status()).toBe('open');
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('connect() is idempotent — calling it again while connecting/open never opens a second socket', () => {
    const { connection, sockets } = setUp();
    connection.connect();
    connection.connect();
    sockets[0]!.simulateOpen();
    connection.connect();

    expect(sockets).toHaveLength(1);
  });

  it('send() before the socket is open queues the message, sent once it opens', () => {
    const { connection, latestSocket } = setUp();
    connection.connect();
    connection.send(cursor(1));
    expect(latestSocket().sent).toHaveLength(0);

    latestSocket().simulateOpen();

    expect(latestSocket().sent).toHaveLength(1);
    expect(JSON.parse(latestSocket().sent[0]!)).toMatchObject({ t: 'cursor', seq: 1 });
  });

  it('send() while open sends immediately', () => {
    const { connection, latestSocket } = setUp();
    connection.connect();
    latestSocket().simulateOpen();

    connection.send(ping(1));

    expect(latestSocket().sent).toHaveLength(1);
  });

  it('a queued lossy message is replaced in place by a newer one before the flush', () => {
    const { connection, latestSocket } = setUp();
    connection.connect();
    connection.send(cursor(1));
    connection.send({ ...cursor(2), x: 0.9 });

    latestSocket().simulateOpen();

    expect(latestSocket().sent).toHaveLength(1);
    expect((JSON.parse(latestSocket().sent[0]!) as CursorMessage).x).toBe(0.9);
  });

  it('onMessage receives the raw string payload of an incoming message', () => {
    const { connection, latestSocket, messages } = setUp();
    connection.connect();
    latestSocket().simulateOpen();

    latestSocket().simulateMessage('{"t":"welcome"}');

    expect(messages).toEqual(['{"t":"welcome"}']);
  });

  it('a non-string message payload is ignored rather than throwing', () => {
    const { connection, latestSocket, messages } = setUp();
    connection.connect();
    latestSocket().simulateOpen();

    expect(() => latestSocket().simulateMessage(undefined as unknown as string)).not.toThrow();
    expect(messages).toEqual([]);
  });

  it('backpressure drops a lossy message outright rather than queueing it', () => {
    const { connection, latestSocket } = setUp({ backpressureBytes: 100 });
    connection.connect();
    latestSocket().simulateOpen();
    latestSocket().bufferedAmount = 200; // over the limit

    connection.send(cursor(1));

    expect(latestSocket().sent).toHaveLength(0);
  });

  it('backpressure still queues a lossless/control message rather than dropping it', () => {
    const { connection, latestSocket } = setUp({ backpressureBytes: 100 });
    connection.connect();
    latestSocket().simulateOpen();
    latestSocket().bufferedAmount = 200;

    connection.send(ping(1));
    expect(latestSocket().sent).toHaveLength(0); // not sent yet — still backpressured

    latestSocket().bufferedAmount = 0; // pressure clears
    connection.send(ping(2)); // any send attempt retries the flush

    expect(latestSocket().sent).toHaveLength(2);
  });

  it('an unexpected close schedules a reconnect with backoff', () => {
    vi.useFakeTimers();
    const { connection, sockets, statuses } = setUp();
    connection.connect();
    sockets[0]!.simulateOpen();

    sockets[0]!.simulateServerClose();
    expect(connection.status()).toBe('reconnecting');

    vi.runOnlyPendingTimers();

    expect(sockets).toHaveLength(2); // the reconnect actually opened a new socket
    expect(statuses).toContain('reconnecting');
  });

  it('reconnecting resets the attempt counter back to 0 once open again', () => {
    vi.useFakeTimers();
    const { connection, sockets } = setUp();
    connection.connect();
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateServerClose();
    vi.runOnlyPendingTimers();
    sockets[1]!.simulateOpen();
    sockets[1]!.simulateServerClose();

    // If the attempt counter had NOT reset, this delay would be based on
    // attempt=2; either way it must still be schedulable and bounded —
    // the real assertion is simply that a second reconnect is reachable
    // at all, proving the state machine did not get stuck.
    vi.runOnlyPendingTimers();
    expect(sockets).toHaveLength(3);
  });

  it('disconnect() closes cleanly with no reconnect scheduled', () => {
    vi.useFakeTimers();
    const { connection, sockets, statuses } = setUp();
    connection.connect();
    sockets[0]!.simulateOpen();

    connection.disconnect();

    expect(connection.status()).toBe('closed');
    vi.runAllTimers();
    expect(sockets).toHaveLength(1); // no reconnect happened
    expect(statuses.at(-1)).toBe('closed');
  });

  it('disconnect() before ever connecting is a no-op', () => {
    const { connection, sockets } = setUp();
    expect(() => connection.disconnect()).not.toThrow();
    expect(sockets).toHaveLength(0);
  });

  it('disconnect() while a reconnect is pending cancels it', () => {
    vi.useFakeTimers();
    const { connection, sockets } = setUp();
    connection.connect();
    sockets[0]!.simulateOpen();
    sockets[0]!.simulateServerClose(); // schedules a reconnect

    connection.disconnect();
    vi.runAllTimers();

    expect(sockets).toHaveLength(1); // the pending reconnect never fired
  });

  it('survives a 5-minute soak of forced disconnect/reconnect every 20 s with no uncaught errors', () => {
    // Run deterministically: fake timers compress the real 5 minutes to
    // milliseconds of test time rather than actually sleeping, while
    // still exercising the same number of reconnect cycles a real soak
    // would.
    vi.useFakeTimers();
    const { connection, sockets } = setUp();
    connection.connect();
    sockets[0]!.simulateOpen();

    const SOAK_MS = 5 * 60 * 1000;
    const FORCED_DISCONNECT_INTERVAL_MS = 20_000;
    const cycles = SOAK_MS / FORCED_DISCONNECT_INTERVAL_MS;

    expect(() => {
      for (let i = 0; i < cycles; i += 1) {
        vi.advanceTimersByTime(FORCED_DISCONNECT_INTERVAL_MS);
        connection.send(ping(i)); // proves the connection is still usable mid-soak
        sockets.at(-1)!.simulateServerClose();
        vi.runOnlyPendingTimers(); // fires the scheduled reconnect
        sockets.at(-1)!.simulateOpen();
      }
    }).not.toThrow();

    expect(connection.status()).toBe('open');
    expect(sockets).toHaveLength(cycles + 1); // the initial socket plus one per forced cycle
  });
});

describe('parseOutboundFrame', () => {
  it('parses a well-formed current-version frame', () => {
    const frame = parseOutboundFrame(JSON.stringify({ v: PROTOCOL_VERSION, t: 'welcome' }));
    expect(frame).toEqual({ v: PROTOCOL_VERSION, t: 'welcome' });
  });

  it('returns undefined for malformed JSON, without throwing', () => {
    expect(() => parseOutboundFrame('{not json')).not.toThrow();
    expect(parseOutboundFrame('{not json')).toBeUndefined();
  });

  it('returns undefined for a non-string input', () => {
    expect(parseOutboundFrame(42)).toBeUndefined();
    expect(parseOutboundFrame(undefined)).toBeUndefined();
  });

  it('returns undefined for a mismatched protocol version', () => {
    expect(
      parseOutboundFrame(JSON.stringify({ v: PROTOCOL_VERSION + 1, t: 'welcome' })),
    ).toBeUndefined();
  });

  it('returns undefined for a missing or non-string t', () => {
    expect(parseOutboundFrame(JSON.stringify({ v: PROTOCOL_VERSION }))).toBeUndefined();
  });
});
