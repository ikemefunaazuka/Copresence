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
import type { Connection, ConnectionStatus } from './transport/connection.js';
import { buildBye, buildCursor, buildHello, buildPing, buildScroll, createWireContext } from './wire.js';
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

export interface CopresenceOptions {
  /** `ws://` or `wss://` URL for the session's WebSocket endpoint, `sid` already included as a query parameter. */
  readonly wsUrl: string;
  readonly sid: string;
  /** Generated via `crypto.randomUUID()` if not supplied. */
  readonly pid?: string;
  readonly doc?: Document;
  readonly win?: Window;
}

export interface CopresenceInstance {
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

  function currentViewport(): { docWidth: number; docHeight: number; dpr: number } {
    return readViewportMetadata(doc, win);
  }

  const connection: Connection = createConnection({
    url: options.wsUrl,
    onMessage: handleRawMessage,
    onStatusChange: handleStatusChange,
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
      scrollFollow.notifyScrollEvent();
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
        return;
      case 'join':
        upsertRemote(message.participant);
        return;
      case 'leave':
        remotes.delete(message.pid);
        cursorLayer.remove(message.pid);
        return;
      case 'patch':
        for (const patch of message.patches) applyPatch(patch);
        return;
      case 'pong':
      case 'error':
        return; // nothing to render for either — see transport/connection.ts for the heartbeat this answers
    }
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
    if (renderHandle === undefined) renderHandle = win.requestAnimationFrame(renderFrame);
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
    connect,
    disconnect,
    status: () => connection.status(),
    followParticipant: (targetPid: string) => scrollFollow.enable(targetPid),
    stopFollowing: () => scrollFollow.disable(),
  };
}
