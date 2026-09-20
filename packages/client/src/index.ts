import { PARTICIPANT_TTL_MS } from '@copresence/protocol';
import type { OutboundMessage, ParticipantSnapshot } from '@copresence/protocol';

import { toViewportSpace } from './capture/coordinates.js';
import { createPointerCapture } from './capture/pointerCapture.js';
import { createScrollCapture } from './capture/scrollCapture.js';
import { readScrollOffset, readViewportMetadata } from './capture/viewport.js';
import { createCursorLayer } from './render/cursorLayer.js';
import { interpolatedPosition } from './render/interpolation.js';
import { createScrollFollow } from './render/scrollFollow.js';
import { createShadowHost } from './render/shadowRoot.js';
import { opacityFor, stalenessOf } from './render/staleness.js';
import { createConnection, parseOutboundFrame } from './transport/connection.js';
import type { Connection, ConnectionStatus, WebSocketLike } from './transport/connection.js';
import {
  buildBye,
  buildCursor,
  buildHello,
  buildPing,
  buildScroll,
  createWireContext,
} from './wire.js';
import type { WireContext } from './wire.js';

/**
 * @copresence/client — the injectable browser SDK. Everything above this
 * file (capture/, transport/, render/) is independently testable in
 * isolation; this is only the wiring between them, plus the two things
 * that genuinely span more than one of those layers:
 *
 * - `visibilitychange`: capture pauses itself, the connection stays
 *   open, and on becoming visible again a fresh `hello` resyncs whatever
 *   the server's TTL reaper may have done in the meantime.
 * - Scroll-follow: capture's own scroll listener is what has to notice a
 *   local scroll and release follow, since it is the one place a real
 *   `scroll` event is already being observed.
 */

const PING_INTERVAL_MS = 15_000;
const HEARTBEAT_CHECK_INTERVAL_MS = Math.max(1_000, Math.floor(PARTICIPANT_TTL_MS / 3));

/** One remote participant, as handed to `onPresenceChange` — a host page's only view into the roster this SDK otherwise keeps to itself. */
export interface RosterParticipant {
  readonly pid: string;
  readonly color: string;
  readonly lastSeenAt: number;
  /** Document-normalised, the same space the wire protocol uses — omitted until this participant has sent a first cursor position. */
  readonly cursor?: { readonly x: number; readonly y: number };
}

export interface CopresenceOptions {
  /** `ws://` or `wss://` URL for the session's WebSocket endpoint, `sid` already included as a query parameter. */
  readonly wsUrl: string;
  readonly sid: string;
  /** Generated via `crypto.randomUUID()` if not supplied. */
  readonly pid?: string;
  readonly doc?: Document;
  readonly win?: Window;
  /** Injectable so tests can drive the whole SDK without a real network connection. */
  readonly createSocket?: (url: string) => WebSocketLike;
  /** Fires with the full remote roster whenever it changes (join/leave/welcome/patch) — everything a host page needs to render its own participant list. */
  readonly onPresenceChange?: (participants: readonly RosterParticipant[]) => void;
  /** Fires with the round-trip time in ms whenever a `pong` answers this SDK's own heartbeat ping. */
  readonly onLatency?: (rttMs: number) => void;
  /**
   * Fires with the followed pid, or `null` once nobody is followed —
   * including the moment a local scroll releases follow on its own (the
   * "local-intent break"), which is otherwise invisible to a host page:
   * nothing else notifies it that `followParticipant` silently stopped
   * applying.
   */
  readonly onFollowChange?: (followingPid: string | null) => void;
}

export interface CopresenceInstance {
  /** This connection's own participant id — generated or given at `init()`, and never present in `onPresenceChange`'s roster (this SDK never renders its own cursor). */
  readonly pid: string;
  connect(): void;
  disconnect(): void;
  status(): ConnectionStatus;
  followParticipant(pid: string): void;
  stopFollowing(): void;
}

interface RemoteCursorPoint {
  readonly x: number;
  readonly y: number;
  readonly t: number;
}

interface RemoteParticipant {
  color: string;
  lastSeenAt: number;
  // Explicitly `| undefined` rather than just optional: shifting
  // `cursorLatest` into `cursorPrev` on a new update is a valid
  // transition even when there was no previous latest yet, and
  // `exactOptionalPropertyTypes` requires that to be spelled out rather
  // than left implicit in the optional `?`.
  cursorPrev?: RemoteCursorPoint | undefined;
  cursorLatest?: RemoteCursorPoint | undefined;
  scroll?: { readonly x: number; readonly y: number };
}

export function init(options: CopresenceOptions): CopresenceInstance {
  const doc = options.doc ?? document;
  const win = options.win ?? window;
  const pid = options.pid ?? crypto.randomUUID();
  const wire: WireContext = createWireContext(options.sid, pid);
  const reducedMotion = win.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;

  const shadowHost = createShadowHost(doc);
  const cursorLayer = createCursorLayer(shadowHost.root, doc);
  const scrollFollow = createScrollFollow();
  const remotes = new Map<string, RemoteParticipant>();

  let renderHandle: number | undefined;
  let pingTimer: ReturnType<typeof setInterval> | undefined;
  let staleSweepTimer: ReturnType<typeof setInterval> | undefined;
  let pointerCaptureActive = false;
  // `patch` carries absolute (last-writer-wins) cursor/scroll values, not
  // deltas, on a real, strictly-increasing server-assigned `seq` (the
  // server's own tick counter — see TickScheduler). A reordered or
  // duplicated network delivery could otherwise apply a stale patch AFTER
  // a newer one, leaving this client frozen on wrong state until the next
  // tick corrects it — or, if movement has already stopped, never. This
  // mirrors the same seq-guard principle `SequenceGuard` already enforces
  // server-side for inbound messages, applied here to outbound ones.
  let lastPatchSeq = -Infinity;

  function currentViewport(): { docWidth: number; docHeight: number; dpr: number } {
    return readViewportMetadata(doc, win);
  }

  const connection: Connection = createConnection({
    url: options.wsUrl,
    onMessage: handleRawMessage,
    onStatusChange: handleStatusChange,
    ...(options.createSocket ? { createSocket: options.createSocket } : {}),
  });

  const pointerCapture = createPointerCapture({
    documentWidth: () => currentViewport().docWidth,
    scrollY: () => readScrollOffset(win).y,
    onCapture: (point) => connection.send(buildCursor(wire, point.x, point.y)),
    target: doc,
  });

  const scrollCapture = createScrollCapture({
    onCapture: (scroll) => {
      connection.send(buildScroll(wire, scroll.x, scroll.y));
      const wasFollowing = scrollFollow.isFollowing();
      scrollFollow.notifyScrollEvent();
      if (wasFollowing && !scrollFollow.isFollowing()) options.onFollowChange?.(null);
    },
    target: win,
    win,
  });

  function handleStatusChange(status: ConnectionStatus): void {
    if (status === 'open') {
      connection.send(buildHello(wire, currentViewport(), doc.visibilityState));
      startPing();
      startStaleSweep();
      return;
    }
    if (status === 'closed') {
      stopPing();
      stopStaleSweep();
    }
  }

  function handleRawMessage(raw: unknown): void {
    const message = parseOutboundFrame(raw);
    if (!message) return;
    routeMessage(message);
  }

  function routeMessage(message: OutboundMessage): void {
    switch (message.t) {
      case 'welcome':
      case 'snapshot':
        seedRoster(message.participants);
        notifyPresenceChange();
        return;
      case 'join':
        upsertRemote(message.participant);
        notifyPresenceChange();
        return;
      case 'leave':
        remotes.delete(message.pid);
        cursorLayer.remove(message.pid);
        notifyPresenceChange();
        return;
      case 'patch':
        if (message.seq <= lastPatchSeq) return; // stale or duplicate — a newer patch already applied
        lastPatchSeq = message.seq;
        for (const patch of message.patches) applyPatch(patch);
        notifyPresenceChange();
        return;
      case 'pong':
        options.onLatency?.(Date.now() - message.pingTs);
        return;
      case 'error':
        return; // nothing to render — see transport/connection.ts for the heartbeat `pong` answers
    }
  }

  function notifyPresenceChange(): void {
    if (!options.onPresenceChange) return;
    const roster: RosterParticipant[] = [];
    for (const [remotePid, participant] of remotes) {
      roster.push({
        pid: remotePid,
        color: participant.color,
        lastSeenAt: participant.lastSeenAt,
        ...(participant.cursorLatest
          ? { cursor: { x: participant.cursorLatest.x, y: participant.cursorLatest.y } }
          : {}),
      });
    }
    options.onPresenceChange(roster);
  }

  function seedRoster(participants: readonly ParticipantSnapshot[]): void {
    const seen = new Set(participants.map((p) => p.pid as string));
    for (const knownPid of remotes.keys()) {
      if (!seen.has(knownPid)) {
        remotes.delete(knownPid);
        cursorLayer.remove(knownPid);
      }
    }
    for (const participant of participants) upsertRemote(participant);
  }

  function upsertRemote(participant: ParticipantSnapshot): void {
    if (participant.pid === pid) return; // never render our own cursor
    const now = Date.now();
    const existing = remotes.get(participant.pid);
    const next: RemoteParticipant = existing ?? { color: participant.color, lastSeenAt: now };
    next.color = participant.color;
    next.lastSeenAt = now;
    if (participant.x !== undefined && participant.y !== undefined) {
      next.cursorPrev = next.cursorLatest;
      next.cursorLatest = { x: participant.x, y: participant.y, t: now };
    }
    if (participant.scrollX !== undefined && participant.scrollY !== undefined) {
      next.scroll = { x: participant.scrollX, y: participant.scrollY };
    }
    remotes.set(participant.pid, next);
  }

  function applyPatch(patch: {
    readonly pid: string;
    readonly x?: number;
    readonly y?: number;
    readonly scrollX?: number;
    readonly scrollY?: number;
  }): void {
    if (patch.pid === pid) return;
    const now = Date.now();
    const existing = remotes.get(patch.pid);
    const next: RemoteParticipant = existing ?? { color: '#888888', lastSeenAt: now };
    next.lastSeenAt = now;
    if (patch.x !== undefined && patch.y !== undefined) {
      next.cursorPrev = next.cursorLatest;
      next.cursorLatest = { x: patch.x, y: patch.y, t: now };
    }
    if (patch.scrollX !== undefined && patch.scrollY !== undefined) {
      next.scroll = { x: patch.scrollX, y: patch.scrollY };
      if (scrollFollow.isFollowing(patch.pid)) followScrollTo(next.scroll);
    }
    remotes.set(patch.pid, next);
  }

  function followScrollTo(target: { readonly x: number; readonly y: number }): void {
    scrollFollow.beginProgrammaticScroll();
    win.scrollTo(target.x, target.y);
    scrollFollow.endProgrammaticScroll();
  }

  function renderFrame(): void {
    const now = Date.now();
    const { docWidth } = currentViewport();
    const scrollY = readScrollOffset(win).y;

    for (const [remotePid, participant] of remotes) {
      const staleness = stalenessOf(participant.lastSeenAt, now);
      if (staleness === 'expired') {
        remotes.delete(remotePid);
        cursorLayer.remove(remotePid);
        continue;
      }

      if (participant.cursorLatest) {
        const documentPoint = reducedMotion
          ? participant.cursorLatest
          : interpolatedPosition(participant.cursorPrev, participant.cursorLatest, now);
        const viewportPoint = toViewportSpace(documentPoint, docWidth, scrollY);
        cursorLayer.upsert(remotePid, viewportPoint.x, viewportPoint.y, participant.color);
      }
      cursorLayer.setOpacity(remotePid, opacityFor(staleness));
    }

    renderHandle = win.requestAnimationFrame(renderFrame);
  }

  function startPing(): void {
    if (pingTimer) return;
    pingTimer = setInterval(() => connection.send(buildPing(wire)), PING_INTERVAL_MS);
  }

  function stopPing(): void {
    if (!pingTimer) return;
    clearInterval(pingTimer);
    pingTimer = undefined;
  }

  function startStaleSweep(): void {
    // Keeps cursors fading/disappearing even if no patch arrives at all
    // (e.g. the sender's own connection dropped) — renderFrame already
    // handles this per-frame, this is just a safety net that does not
    // depend on rAF still running if, for some reason, it has stalled.
    if (staleSweepTimer) return;
    staleSweepTimer = setInterval(() => {
      const now = Date.now();
      for (const [remotePid, participant] of remotes) {
        if (stalenessOf(participant.lastSeenAt, now) !== 'expired') continue;
        remotes.delete(remotePid);
        cursorLayer.remove(remotePid);
      }
    }, HEARTBEAT_CHECK_INTERVAL_MS);
  }

  function stopStaleSweep(): void {
    if (!staleSweepTimer) return;
    clearInterval(staleSweepTimer);
    staleSweepTimer = undefined;
  }

  function handleVisibilityChange(): void {
    if (doc.visibilityState === 'hidden') {
      if (pointerCaptureActive) {
        pointerCapture.stop();
        pointerCaptureActive = false;
      }
      return;
    }
    if (!pointerCaptureActive) {
      pointerCapture.start();
      pointerCaptureActive = true;
    }
    if (connection.status() === 'open') {
      connection.send(buildHello(wire, currentViewport(), 'visible'));
    }
  }

  function connect(): void {
    connection.connect();
    if (!pointerCaptureActive) {
      pointerCapture.start();
      pointerCaptureActive = true;
    }
    scrollCapture.start();
    doc.addEventListener('visibilitychange', handleVisibilityChange);
    renderHandle ??= win.requestAnimationFrame(renderFrame);
  }

  function disconnect(): void {
    connection.send(buildBye(wire));
    connection.disconnect();
    pointerCapture.stop();
    pointerCaptureActive = false;
    scrollCapture.stop();
    doc.removeEventListener('visibilitychange', handleVisibilityChange);
    if (renderHandle !== undefined) {
      win.cancelAnimationFrame(renderHandle);
      renderHandle = undefined;
    }
    stopPing();
    stopStaleSweep();
  }

  return {
    pid,
    connect,
    disconnect,
    status: () => connection.status(),
    followParticipant: (targetPid: string) => {
      scrollFollow.enable(targetPid);
      options.onFollowChange?.(targetPid);
    },
    stopFollowing: () => {
      scrollFollow.disable();
      options.onFollowChange?.(null);
    },
  };
}
