import { BACKPRESSURE_BYTES, PROTOCOL_VERSION, classify } from '@copresence/protocol';
import type { InboundMessage, OutboundMessage } from '@copresence/protocol';

import { backoffDelayMs } from './backoff.js';
import { createOutboundQueue } from './outboundQueue.js';
import type { OutboundQueue } from './outboundQueue.js';

/**
 * A minimal shape of the real browser `WebSocket` — just what this module
 * touches — so tests can inject a fake one instead of opening a real
 * network connection. `decodeInbound`/`InboundMessage` are named that way
 * from the server's perspective; from here, on the wire, they are what
 * this module *sends*, and `OutboundMessage` is what it *receives* — the
 * two ends of the same channel looking at the same envelope from
 * opposite sides.
 */
export interface WebSocketLike {
  readyState: number;
  bufferedAmount: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(
    type: string,
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
  removeEventListener(
    type: string,
    listener: (event: MessageEvent | CloseEvent | Event) => void,
  ): void;
}

export type ConnectionStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

const OPEN = 1;

export interface ConnectionOptions {
  readonly url: string;
  readonly onMessage: (message: unknown) => void;
  readonly onStatusChange?: (status: ConnectionStatus) => void;
  /** Injectable so tests never open a real socket. */
  readonly createSocket?: (url: string) => WebSocketLike;
  readonly backpressureBytes?: number;
  readonly random?: () => number;
  readonly setTimeoutFn?: (cb: () => void, ms: number) => ReturnType<typeof setTimeout>;
  readonly clearTimeoutFn?: (handle: ReturnType<typeof setTimeout>) => void;
}

export interface Connection {
  connect(): void;
  /** Deliberate, permanent — no reconnect follows. Idempotent. */
  disconnect(): void;
  send(message: InboundMessage): void;
  status(): ConnectionStatus;
}

/**
 * Owns one WebSocket's whole lifecycle: connecting, reconnecting with
 * backoff and full jitter, and the outbound queue's class-based drop
 * policy under backpressure. Two things this deliberately does not own,
 * both coordinated one layer up in index.ts instead:
 *
 * - `visibilitychange` handling (pause capture, keep this connection
 *   open, resend `hello` on resume) spans capture and transport
 *   together, so it belongs to neither alone.
 * - The periodic application-level `ping` (this SDK's heartbeat
 *   responder counterpart, distinct from the raw WebSocket protocol
 *   ping/pong every browser answers automatically with no code needed)
 *   needs `sid`/`pid`/`seq` to build a real message, state this module
 *   never holds — constructing protocol messages is not this module's
 *   job, only sending and receiving already-built ones is.
 */
export function createConnection(options: ConnectionOptions): Connection {
  const backpressureBytes = options.backpressureBytes ?? BACKPRESSURE_BYTES;
  const random = options.random ?? Math.random;
  const setTimeoutFn = options.setTimeoutFn ?? ((cb, ms) => setTimeout(cb, ms));
  const clearTimeoutFn = options.clearTimeoutFn ?? ((handle) => clearTimeout(handle));
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));

  const queue: OutboundQueue = createOutboundQueue();
  let socket: WebSocketLike | undefined;
  let currentStatus: ConnectionStatus = 'idle';
  let reconnectAttempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let intentionalDisconnect = false;

  function setStatus(next: ConnectionStatus): void {
    if (currentStatus === next) return;
    currentStatus = next;
    options.onStatusChange?.(next);
  }

  function isBackpressured(): boolean {
    return (socket?.bufferedAmount ?? 0) > backpressureBytes;
  }

  function flushQueue(): void {
    if (socket?.readyState !== OPEN) return;
    const pending = queue.drain();
    for (let i = 0; i < pending.length; i += 1) {
      if (isBackpressured()) {
        // Stop sending; re-queue what's left, applying the same
        // backpressure drop policy as everywhere else: lossy frames are
        // discarded outright rather than queued to wait, since a newer
        // one will exist by the time there is room again.
        for (let j = i; j < pending.length; j += 1) {
          const remaining = pending[j]!;
          if (classify(remaining.t) === 'lossy') continue;
          queue.enqueue(remaining);
        }
        return;
      }
      socket.send(JSON.stringify(pending[i]));
    }
  }

  function clearReconnectTimer(): void {
    if (reconnectTimer === undefined) return;
    clearTimeoutFn(reconnectTimer);
    reconnectTimer = undefined;
  }

  function scheduleReconnect(): void {
    if (intentionalDisconnect) return;
    setStatus('reconnecting');
    const delay = backoffDelayMs(reconnectAttempt, undefined, random);
    reconnectAttempt += 1;
    reconnectTimer = setTimeoutFn(() => {
      reconnectTimer = undefined;
      openSocket();
    }, delay);
  }

  function handleOpen(): void {
    reconnectAttempt = 0;
    setStatus('open');
    flushQueue();
  }

  function handleMessage(event: MessageEvent | CloseEvent | Event): void {
    const data = (event as MessageEvent).data as unknown;
    if (typeof data !== 'string') return; // this protocol never sends binary frames
    options.onMessage(data);
  }

  function handleClose(): void {
    detachSocket();
    if (intentionalDisconnect) {
      setStatus('closed');
      return;
    }
    scheduleReconnect();
  }

  function detachSocket(): void {
    if (!socket) return;
    socket.removeEventListener('open', handleOpen);
    socket.removeEventListener('message', handleMessage);
    socket.removeEventListener('close', handleClose);
    socket.removeEventListener('error', handleClose);
    socket = undefined;
  }

  function openSocket(): void {
    setStatus(currentStatus === 'idle' ? 'connecting' : 'reconnecting');
    const next = createSocket(options.url);
    socket = next;
    next.addEventListener('open', handleOpen);
    next.addEventListener('message', handleMessage);
    next.addEventListener('close', handleClose);
    next.addEventListener('error', handleClose);
  }

  function connect(): void {
    // Idempotent: already connecting/open/reconnecting is a no-op —
    // never opens a second socket underneath an existing one.
    if (
      currentStatus === 'connecting' ||
      currentStatus === 'open' ||
      currentStatus === 'reconnecting'
    )
      return;
    intentionalDisconnect = false;
    reconnectAttempt = 0;
    openSocket();
  }

  function disconnect(): void {
    if (currentStatus === 'closed' || currentStatus === 'idle') return;
    intentionalDisconnect = true;
    clearReconnectTimer();
    if (socket) {
      socket.close(1000, 'client disconnect');
    } else {
      setStatus('closed');
    }
  }

  function send(message: InboundMessage): void {
    queue.enqueue(message);
    flushQueue();
  }

  return {
    connect,
    disconnect,
    send,
    status: () => currentStatus,
  };
}

/**
 * Parses a raw server→client frame, or `undefined` for anything
 * malformed. There is no zod schema for `OutboundMessage` to lean on
 * here (it is server-authored and hand-typed — see docs/adr/0002) so
 * this is a lighter structural check: a valid envelope, current
 * protocol version. Good enough to keep a corrupted frame from crashing
 * the client, which is the actual job.
 */
export function parseOutboundFrame(raw: unknown): OutboundMessage | undefined {
  if (typeof raw !== 'string') return undefined;
  try {
    const parsed = JSON.parse(raw) as { readonly v?: unknown; readonly t?: unknown };
    if (parsed.v !== PROTOCOL_VERSION || typeof parsed.t !== 'string') return undefined;
    return parsed as unknown as OutboundMessage;
  } catch {
    return undefined;
  }
}
