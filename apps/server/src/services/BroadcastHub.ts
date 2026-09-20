import type { ParticipantId, OutboundMessage, SessionId } from '@copresence/protocol';
import { encodeOutbound } from '@copresence/protocol';
import type { WebSocket } from 'ws';

interface Connection {
  readonly pid: ParticipantId;
  readonly sid: SessionId;
  readonly socket: WebSocket;
}

export interface ChaosTransport {
  send(pid: ParticipantId, message: OutboundMessage, rawSend: () => void): void;
}

export interface BroadcastHubOptions {
  /**
   * Optional — when present, every send is routed through it instead of
   * going straight to the socket, so `ChaosMiddleware` can decide whether,
   * when, and how many times a message actually leaves the wire. Omitted
   * entirely by most tests, which want the real, unconditional send this
   * class always did.
   */
  readonly chaos?: ChaosTransport;
}

/**
 * Reaches live connections and sends to them — nothing more. Registering
 * and unregistering connections, sending to one participant, broadcasting
 * to everyone in a session. Deliberately knows nothing about ticking or
 * about `Session`'s dirty-field state; that orchestration is
 * `TickScheduler`'s job, built on top of this one — and, as of the chaos
 * lab, deliberately knows nothing about *how* a send actually reaches the
 * wire either, only that it was handed off to something that will decide.
 *
 * Reused for both kinds of send: the coalesced, lossy `patch` on a tick,
 * and an immediate, lossless `join`/`leave`/`welcome` the moment it
 * happens — see docs/adr/0009.
 */
export class BroadcastHub {
  #connections = new Map<ParticipantId, Connection>();
  #bySession = new Map<SessionId, Set<ParticipantId>>();
  #chaos: ChaosTransport | undefined;

  constructor(options: BroadcastHubOptions = {}) {
    this.#chaos = options.chaos;
  }

  register(connection: Connection): void {
    this.#connections.set(connection.pid, connection);
    const peers = this.#bySession.get(connection.sid) ?? new Set<ParticipantId>();
    peers.add(connection.pid);
    this.#bySession.set(connection.sid, peers);
  }

  unregister(pid: ParticipantId): void {
    const connection = this.#connections.get(pid);
    if (!connection) return;
    this.#connections.delete(pid);
    const peers = this.#bySession.get(connection.sid);
    if (!peers) return;
    peers.delete(pid);
    if (peers.size === 0) this.#bySession.delete(connection.sid);
  }

  isConnected(pid: ParticipantId): boolean {
    return this.#connections.has(pid);
  }

  participantsOf(sid: SessionId): readonly ParticipantId[] {
    return Array.from(this.#bySession.get(sid) ?? []);
  }

  /**
   * `readyState` is checked because a socket can linger in the map
   * between a real-world disconnect and this connection's `close` handler
   * actually firing and calling `unregister` — sending to it would throw
   * or silently vanish into a dead socket otherwise (`ws`'s own send
   * queue does not surface that as an error the caller can act on here).
   */
  sendTo(pid: ParticipantId, message: OutboundMessage): boolean {
    const connection = this.#connections.get(pid);
    if (!connection || connection.socket.readyState !== connection.socket.OPEN) return false;
    const rawSend = (): void => connection.socket.send(encodeOutbound(message));
    if (this.#chaos) {
      this.#chaos.send(pid, message, rawSend);
    } else {
      rawSend();
    }
    return true;
  }

  /** Sends to every participant in `sid` except, optionally, one — the sender, usually. */
  broadcastToSession(sid: SessionId, message: OutboundMessage, exclude?: ParticipantId): void {
    for (const pid of this.participantsOf(sid)) {
      if (pid === exclude) continue;
      this.sendTo(pid, message);
    }
  }
}
