import type { AuditMessage, SessionEndMessage } from '@copresence/protocol';

import type { Beacon } from '../beacon/beacon.js';
import type { Outbox } from '../outbox/outbox.js';
import {
  buildSessionEnd,
  buildSessionStart,
  buildVisibilityChange,
  generateEventId,
} from '../wire.js';
import type { WireContext } from '../wire.js';

export interface LifecycleDeps {
  readonly doc: Document;
  readonly win: Window;
  readonly wire: WireContext;
  readonly outbox: Outbox;
  readonly beacon: Beacon;
  /** The live socket's own send — used whenever the connection is open; an `audit.ack` reply confirms the outbox entry later (see `handleAck`). */
  readonly sendOverSocket: (message: AuditMessage) => void;
  readonly isSocketOpen: () => boolean;
}

export interface Lifecycle {
  /** Reads the page's current visibility, opens a session if it starts visible, and starts listening. Idempotent-adjacent: call once, from `connect()`. */
  start(): void;
  stop(): void;
  /** Wire this to the `audit.ack` case in `index.ts`'s `routeMessage` — clears the matching outbox entry. */
  handleAck(eventId: string): void;
}

/**
 * `visibilitychange` → `hidden` is the end-of-session signal, `pagehide`
 * secondary — never `beforeunload`/`unload`. Neither of those fires when
 * a tab is frozen, discarded or killed by the OS (most of what happens on
 * mobile), and `unload` additionally disqualifies the page from the
 * back/forward cache. See ADR 0011.
 *
 * "Session" here means a period of foreground engagement, not the
 * WebSocket connection — the socket stays open across a hide (see
 * `index.ts`'s own `handleVisibilityChange`, which only pauses capture),
 * so `hidden → visible → hidden` can fire many times against one
 * connection, each its own `session.start`/`session.end` pair.
 */
export function createLifecycle(deps: LifecycleDeps): Lifecycle {
  let sessionOpen = false;
  let lastVisibilityState: DocumentVisibilityState | undefined;

  async function emit(message: AuditMessage): Promise<void> {
    const payload = JSON.stringify(message);
    await deps.outbox.add(message.eventId, payload); // persist before sending, always
    if (deps.isSocketOpen()) {
      deps.sendOverSocket(message);
      return; // acknowledged later via `audit.ack` → handleAck() confirms this entry
    }
    const confirmed = await deps.beacon.sendConfirmable(payload);
    if (confirmed) await deps.outbox.confirm(message.eventId);
  }

  function openSession(): void {
    if (sessionOpen) return;
    sessionOpen = true;
    void emit(buildSessionStart(deps.wire, generateEventId()));
  }

  // Only 'navigate' is ever self-selected here: a visibility hide cannot
  // tell tab-switch from close apart, and 'crash-recovered' cannot be
  // known at the point of building the message (a crash, by definition,
  // runs no code) — it is reserved for whichever path later classifies a
  // record that way, not produced by this builder. See ADR 0011.
  function closeSession(reason: SessionEndMessage['reason']): void {
    if (!sessionOpen) return;
    sessionOpen = false;
    void emit(buildSessionEnd(deps.wire, generateEventId(), reason));
  }

  function onVisibilityChange(): void {
    const state = deps.doc.visibilityState;
    if (state === lastVisibilityState) return; // no genuine transition
    lastVisibilityState = state;
    void emit(buildVisibilityChange(deps.wire, generateEventId(), state));
    if (state === 'hidden') closeSession('navigate');
    else openSession();
  }

  function onPageHide(event: PageTransitionEvent): void {
    if (event.persisted) {
      // bfcache freeze, not teardown: the page may resume, so the fuller
      // confirmable flow is worth attempting — if the freeze lands
      // mid-flight the entry just stays pending and is retried on the
      // next hide, which is the documented bfcache-duplicate case.
      void deps.outbox.flushPending((payload) => deps.beacon.sendConfirmable(payload));
      return;
    }
    // A real unload can terminate the process before any awaited work
    // resolves, so only a synchronous, fire-and-forget send is attempted
    // here. Anything this misses is exactly what the outbox's own
    // persistence — and the next page load's flush — exists to recover.
    void deps.outbox.flushPending((payload) =>
      Promise.resolve(deps.beacon.sendBestEffort(payload)),
    );
  }

  return {
    start() {
      lastVisibilityState = deps.doc.visibilityState;
      deps.doc.addEventListener('visibilitychange', onVisibilityChange);
      deps.win.addEventListener('pagehide', onPageHide);
      // Replays anything left over from a prior page load — a crash, an
      // OS kill, or a send that was persisted but never confirmed.
      void deps.outbox.flushPending((payload) => deps.beacon.sendConfirmable(payload));
      if (lastVisibilityState === 'visible') openSession();
    },
    stop() {
      deps.doc.removeEventListener('visibilitychange', onVisibilityChange);
      deps.win.removeEventListener('pagehide', onPageHide);
    },
    handleAck(eventId) {
      void deps.outbox.confirm(eventId);
    },
  };
}
