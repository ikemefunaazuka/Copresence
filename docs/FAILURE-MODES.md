# Failure modes

Every way this system's own tests deliberately break it, what actually catches each one, and how to see it happen yourself. If a failure mode isn't listed here, it isn't a mechanism this project claims to handle — see the README's "What this is not" for the boundary.

Reproduction steps that reference the chaos panel assume the server is running (`npm run dev -w apps/server` or `npm run demo`) and the panel is open at `/chaos`. Steps that reference a specific test name can be run with `npx vitest run <path> -t "<name>"`.

---

## Inbound ordering & integrity (client → server)

### Duplicate message (same seq sent twice)

- **Symptom, if unhandled:** the same cursor/scroll/audit event applied twice — harmless for a pure last-writer-wins field, but a real problem for anything counted or acknowledged once.
- **Mechanism:** `SequenceGuard.accept(seq)` rejects any `seq` at or below the last one seen for that connection; the realtime router drops the message silently (not an error — a duplicate is expected, not adversarial) and records it as a rejected duplicate.
- **Lives in:** `apps/server/src/models/SequenceGuard.ts`, `apps/server/src/routes/realtimeRouter.ts`.
- **Reproduce:** `npx vitest run apps/server/src/testing/realtime.integration.test.ts -t "duplicate"` — sends the same `seq` twice with different payloads and asserts the second never took effect.

### Out-of-order / late message

- **Symptom, if unhandled:** a stale cursor position arriving after a newer one silently overwrites the current, correct position.
- **Mechanism:** the same `SequenceGuard.accept()` check — it does not distinguish "duplicate" from "late" by outcome (both are rejected), but the router does distinguish them for metrics via `lastSeen()`.
- **Lives in:** `apps/server/src/models/SequenceGuard.ts`, `apps/server/src/routes/realtimeRouter.ts`.
- **Reproduce:** `SequenceGuard.test.ts`'s monotonicity property test — asserts the guard never accepts a regression under any shuffled input.

### Malformed JSON / structurally invalid / version-mismatched frame

- **Symptom, if unhandled:** an adversarial or buggy client crashes the connection, or worse, the process.
- **Mechanism:** `decodeInbound()` is total — it never throws, returning a typed error result instead. The router turns that into an `error` frame with a specific code (`malformed-json`, `validation-failed`, `version-mismatch`) and the connection survives.
- **Lives in:** `packages/protocol/src/codec.ts`, `apps/server/src/routes/realtimeRouter.ts`.
- **Reproduce:** `npx vitest run apps/server/src/testing/realtime.integration.test.ts -t "malformed"` and `-t "structurally-invalid"`; the fuzz test (`-t "1000 adversarial"`) throws 1000 adversarial frames at a live connection and asserts the process and connection both survive.

### Oversized frame

- **Symptom, if unhandled:** an attacker (or a bug) sends a huge payload; the server buffers the whole thing before rejecting it, exhausting memory.
- **Mechanism:** `ws`'s own `maxPayload`, set to `MAX_INBOUND_MESSAGE_BYTES` (8 KB), rejects the frame at the transport level before it is ever fully buffered.
- **Lives in:** `apps/server/src/server.ts`, `packages/protocol/src/constants.ts`.
- **Reproduce:** `npx vitest run apps/server/src/testing/realtime.integration.test.ts -t "oversized"`.

### Identity spoofing (a connection claiming a different `pid`)

- **Symptom, if unhandled:** one participant impersonates another on their own connection, corrupting that participant's presence.
- **Mechanism:** the realtime router checks, once, before any dispatch, that every message's `pid` matches the identity this connection established at `hello`. Every controller can assume this already happened.
- **Lives in:** `apps/server/src/routes/realtimeRouter.ts`.
- **Reproduce:** `npx vitest run apps/server/src/testing/realtime.integration.test.ts -t "different pid"`.

---

## Outbound delivery & convergence (server → client)

### Dropped lossy message (`cursor`/`scroll`)

- **Symptom, if unhandled:** none, by design — a single missed cursor update is invisible, since the next one (an absolute position, not a delta) supersedes it.
- **Mechanism:** nothing explicit is needed; this is the payoff of coalescing absolute state rather than streaming deltas (ADR 0003).
- **Lives in:** `apps/server/src/services/TickScheduler.ts`, `apps/server/src/views/presenters.ts` (`toPatch`).
- **Reproduce:** set `dropRate` on `/chaos` to 30–50% and watch cursors keep tracking, just more coarsely.

### Dropped _final_ patch after movement stops

- **Symptom, if unhandled:** the one patch describing where a cursor came to rest is lost, and — because nothing is dirty anymore — nothing ever corrects it. The participant stays visibly wrong indefinitely.
- **Mechanism:** for `PATCH_SETTLE_WINDOW_MS` (750 ms) after a session's last genuinely dirty tick, `TickScheduler` keeps re-broadcasting that same last-known content on every subsequent tick, each with a fresh, higher `seq`. Found by chaos-testing convergence itself, not assumed.
- **Lives in:** `apps/server/src/services/TickScheduler.ts`, `PATCH_SETTLE_WINDOW_MS` in `packages/protocol/src/constants.ts`.
- **Reproduce:** `TickScheduler.test.ts -t "settles by re-confirming"`; live, the convergence test below exercises it under real chaos.

### Reordered outbound patch

- **Symptom, if unhandled:** a patch describing an older position arrives _after_ a newer one and is applied, moving a cursor backwards until the next tick corrects it — or never, if movement has stopped.
- **Mechanism:** the client keeps its own highest-accepted patch `seq` and ignores anything at or below it — the same seq-guard principle `SequenceGuard` applies server-side for inbound messages, mirrored here for outbound ones. `ConvergenceTracker`'s simulation applies the identical rule, so it never reports a false convergence that a real client wouldn't also reach.
- **Lives in:** `packages/client/src/index.ts` (`lastPatchSeq`), `apps/server/src/services/ConvergenceTracker.ts`.
- **Reproduce:** `index.test.ts -t "reordered (stale) patch"` (client); `ConvergenceTracker.test.ts -t "reordered (stale) patch"` (server simulation); live, set `reorderWindow` on `/chaos` to 5–10.

### Duplicated outbound message

- **Symptom, if unhandled:** double-counting, or a flicker if a stale duplicate reorders past a newer message.
- **Mechanism:** `welcome`/`join`/`leave`/`patch` are all naturally idempotent — applying the same one twice is a no-op — so a duplicate is harmless by construction rather than needing explicit dedup. The reordering case is still covered by the seq guard above.
- **Lives in:** `packages/client/src/index.ts` (`seedRoster`/`upsertRemote`/`applyPatch`).
- **Reproduce:** set `duplicateRate` on `/chaos` and watch nothing visibly change versus a clean network.

### Total network partition

- **Symptom, if unhandled:** an extended outage with no special handling looks identical to a very high, sustained drop rate — which this system already tolerates — but a _real_ partition also needs to heal cleanly once connectivity returns, with no manual reconnect.
- **Mechanism:** `ChaosMiddleware.startPartition(durationMs)` drops every outbound send unconditionally for the window, regardless of `dropRate`. Nothing special is needed to heal it — the moment the window ends, normal ticking (plus the settle window above) resynchronises everyone within the next few ticks.
- **Lives in:** `apps/server/src/services/ChaosMiddleware.ts`.
- **Reproduce:** `chaos.integration.test.ts -t "10s partition"`; live, the "Partition for 10s" button on `/chaos`.

---

## Connection & transport lifecycle

### Half-open TCP connection (the client vanished without saying so)

- **Symptom, if unhandled:** a dead connection lingers forever, showing as a ghost cursor to everyone else in the session.
- **Mechanism:** the server pings every connection at a fixed interval over the raw WebSocket protocol (distinct from the application-level `ping`/`pong` used for latency) and terminates it after a configurable number of missed pongs.
- **Lives in:** `apps/server/src/server.ts`.
- **Reproduce:** `npx vitest run apps/server/src/testing/realtime.integration.test.ts -t "stops responding to heartbeat"`.

### Reconnect storm after a server restart

- **Symptom, if unhandled:** every connected client reconnects at the same instant, immediately overwhelming the server that just came back up — a self-inflicted second outage.
- **Mechanism:** exponential backoff with **full** jitter (not proportional or equal jitter) on every reconnect attempt, so simultaneous clients spread their retries across a growing random window instead of retrying in lockstep.
- **Lives in:** `packages/client/src/transport/backoff.ts`.
- **Reproduce:** `backoff.test.ts` — a property test asserting every computed delay falls within `[0, min(cap, base·2^attempt)]` and is not deterministic across calls.

### Reconnecting after any disruption

- **Symptom, if unhandled:** a client that missed an unknown number of updates while disconnected has to guess what it missed, or stays stale.
- **Mechanism:** a fresh `hello` on reconnect is answered with a full-roster `welcome`, not a diff — the reconnecting client converges to current truth in one message.
- **Lives in:** `apps/server/src/controllers/ConnectionController.ts` (`handleHello`), `packages/client/src/index.ts`.
- **Reproduce:** `e2e/copresence.spec.ts -t "A reconnecting recovers"`.

### Slow consumer (backpressure)

- **Symptom, if unhandled:** a client on a slow link falls behind; without a limit, the server's own send buffer for that socket grows without bound.
- **Mechanism:** the client-side outbound queue checks `socket.bufferedAmount` and drops lossy frames outright once it crosses a threshold, rather than queuing them to wait. A slow consumer degrades to a stuttering cursor, never to unbounded memory growth.
- **Lives in:** `packages/client/src/transport/connection.ts`, `packages/client/src/transport/outboundQueue.ts`.
- **Reproduce:** `outboundQueue.test.ts` / `connection.test.ts -t "backpressure"`.

---

## Client-side host-page resilience

### Aggressive host-page CSS

- **Symptom, if unhandled:** a host page's own reset stylesheet (even one using `!important`) repositions or hides the injected cursor overlay.
- **Mechanism:** everything this SDK renders lives inside a closed Shadow DOM root; the one light-DOM element (the shadow host itself) sets every positioning property with `!important`, which is what actually survives a host-page `!important` rule (a plain inline style would not).
- **Lives in:** `packages/client/src/render/shadowRoot.ts`. See ADR 0008.
- **Reproduce:** `shadowRoot.test.ts -t "aggressive"`.

### Host page CSP / bundle weight

- **Symptom, if unhandled:** an injected script that is large, or that pulls in third-party dependencies, is both a performance tax on every host page and a larger supply-chain surface.
- **Mechanism:** the client ships with zero runtime dependencies (verified by `npm ls --omit=dev`) and a CI-enforced 10 KB gzipped budget that fails the build, not just warns.
- **Lives in:** `.size-limit.json`, `packages/client/package.json`. See ADR 0010.
- **Reproduce:** `npm run size`.

---

## Observability of all of the above

Nothing above is a claim in this document alone — `/chaos` lets a reviewer dial in any combination of these conditions live, `/metrics` (Prometheus) and `/api/metrics` (JSON) expose the resulting counters (dropped-by-class, duplicates sent/rejected, out-of-order rejected, resyncs triggered, coalescing ratio, delivery latency percentiles), and `/api/sessions/:sid/convergence` shows, per participant, whether their simulated view of the session has actually converged — the same mechanism the three tests above assert on. See `apps/server/src/testing/chaos.integration.test.ts` for the automated versions of the coalescing-ratio and convergence claims, and `apps/server/src/services/ChaosMiddleware.ts` / `MetricsCollector.ts` / `ConvergenceTracker.ts` for how each is actually computed.
