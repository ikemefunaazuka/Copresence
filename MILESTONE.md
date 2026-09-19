# Copresence — Milestone Plan

**A toy co-browsing core: two browsers sharing cursor position and scroll state over WebSockets, built to survive duplicate, late, out-of-order and missing messages.**

| | |
|---|---|
| **Owner** | Precious Ikemefuna Azuka |
| **Started** | 19 September 2026 |
| **Target for v1** | 26 September 2026 (Phases 0–5 + 9) |
| **Stack** | TypeScript (strict, ESM) · Node 22 · Express 5 · `ws` · Vue 3 (inspector only) · Vitest · Playwright |
| **Database** | **None required.** See [Data & Persistence](#data--persistence) |
| **Architecture** | MVC on the server, layered SDK on the client |

---

## 1. Why this project exists

This repository is a deliberate, scoped demonstration built against Surfly's actual problem domain: **JavaScript sandboxing, proxy infrastructure, and real-time session collaboration.**

It is not a portfolio filler. It targets one specific claim and proves it in code:

> Real-time session state over WebSockets is the same class of problem as webhook reconciliation — events you cannot trust to arrive once, or in order, or at all, and state that has to converge anyway.

Every phase below exists to make that claim demonstrable rather than assertable. The measure of success is not "cursors move." It is: **with 20% packet loss, 5% duplication, 300 ms jitter and an active reorder window, two independent browsers converge to byte-identical presence state within 500 ms of input stopping** — and there is a test that proves it and a chaos panel a reviewer can toggle themselves.

### Non-goals (stated once, honoured throughout)

This is a **toy core**, and the README says so in its first paragraph. It deliberately does not attempt:

- DOM mutation mirroring or full session replay of the guest page
- WebRTC media, audio or video
- Multi-node horizontal scale-out (single process, in-memory; the seam is documented, not built)
- Production-grade proxy correctness — service workers, cross-origin iframes, CSP nonce reconstruction, cookie partitioning
- Authentication beyond an unguessable session token

Stating the boundary precisely is part of the deliverable. An engineer who can name what they did not build is more trustworthy than one who implies they built everything.

---

## 2. Architecture

### 2.1 MVC on the server

The server follows a strict MVC separation. The rule that keeps it honest: **`models/` imports nothing from Node and nothing from the browser.** It is pure TypeScript. If you cannot unit test a model with no mocks, it is in the wrong folder.

| Layer | Directory | Responsibility | May import |
|---|---|---|---|
| **Model** | `apps/server/src/models/` | Domain entities and the pure state reducer. `Session`, `Participant`, `PresenceState`, `SequenceGuard`. Owns all convergence logic. | `@copresence/protocol` only |
| **View** | `apps/server/src/views/` | Presenters that map domain state → wire DTOs and → HTML. No business logic, no I/O. | models, protocol |
| **Controller** | `apps/server/src/controllers/` | Thin orchestration. Parses input, calls a service, hands the result to a view. Never contains domain rules. | services, views, models |
| *Service* | `apps/server/src/services/` | Stateful coordination: registry, broadcast hub, tick scheduler, metrics, proxy. | models, lib |
| *Route* | `apps/server/src/routes/` | HTTP route table + realtime message router (type → controller method). | controllers |
| *Middleware* | `apps/server/src/middleware/` | Cross-cutting: request id, logging, errors, rate limit, origin guard. | lib |
| *Config* | `apps/server/src/config/` | Schema-validated env, tuning constants. Fails fast at boot. | — |
| *Lib* | `apps/server/src/lib/` | Framework-free utilities: logger, id, clock, backoff, `Result`. | — |

Controllers exist for **both** transports. HTTP controllers take `(req, res)`; realtime controllers take `(ctx: ConnectionContext, msg: InboundMessage)`. The realtime router is a dispatch table, not a `switch` sprawled through the WebSocket handler — the same shape as an HTTP router, for the same reason.

### 2.2 Repository layout

```
copresence/
├── packages/
│   ├── protocol/              # THE wire contract. Shared by client and server.
│   │   └── src/
│   │       ├── messages.ts        # discriminated unions, both directions
│   │       ├── schemas.ts         # zod validators for every inbound message
│   │       ├── codec.ts           # encode/decode + version negotiation
│   │       └── constants.ts       # tick rate, TTLs, budgets, limits
│   └── client/                # Zero-dependency injectable browser SDK
│       └── src/
│           ├── capture/           # pointer + scroll sampling, normalisation
│           ├── transport/         # socket, reconnect, heartbeat, backpressure
│           ├── render/            # shadow-DOM cursor layer, interpolation
│           ├── state/             # local mirror of remote presence
│           └── index.ts           # public API, builds to a single IIFE
├── apps/
│   ├── server/                # Express 5 + ws, MVC (see 2.1)
│   └── inspector/             # Vue 3 + Vite live session inspector
├── e2e/                       # Playwright two-browser-context specs
├── docs/
│   ├── PROTOCOL.md            # normative wire spec
│   ├── ARCHITECTURE.md        # diagrams, data flow, the seams
│   ├── FAILURE-MODES.md       # the catalogue, with repro steps
│   ├── adr/                   # one file per irreversible decision
│   └── assets/                # the GIF that sells the repo
├── .github/workflows/ci.yml
├── README.md
└── MILESTONE.md               # this file
```

**Why a monorepo for a toy?** One reason only, and it is a real one: the wire format must have exactly one definition, and both ends must fail to compile when it changes. `packages/protocol` is not organisational neatness — it is the mechanism that makes a protocol change a type error on both sides instead of a runtime mystery. That justification goes in `docs/adr/0002-shared-protocol-package.md`.

### 2.3 Client SDK layering

The client is **zero-dependency vanilla TypeScript**, bundled to a single IIFE under a hard 10 KB gzipped budget enforced in CI.

That constraint is not aesthetic. The client is designed to be *injected into a page whose source you do not control*, which forces four decisions:

1. **No framework.** You do not get to assume React, Vue, or a module loader exists on the host page.
2. **Shadow DOM for all injected UI.** The host page's CSS must not be able to reach the cursor layer, and the cursor layer must not leak styles into the host page. `attachShadow({ mode: 'closed' })`.
3. **Passive, capture-phase listeners.** Never block the host page's scrolling; never depend on the host page not calling `stopPropagation()`.
4. **No globals beyond one namespaced entry point.** `window.__copresence` and nothing else.

These are the same instincts Webfuse needs at a far harder level, and the README says exactly that — including the parts the toy does not solve.

---

## 3. Data & Persistence

**No database is required to build or run this project.**

Presence state — cursor coordinates, scroll offset, participant roster — is *ephemeral and session-scoped*. It has a natural lifetime of one WebSocket connection. Persisting it to Mongo would be strictly worse: an extra network hop on the hot path, a second source of truth to keep converged, and a durability guarantee nobody asked for on data that is meaningless three seconds after it is written.

So the storage layer is `SessionRegistry`, a `Map<SessionId, Session>` behind an interface, with TTL-based reaping of dead participants. The **interface** is the point — `SessionStore` is defined as a port in Phase 2 so the in-memory implementation is visibly a choice rather than an omission, and so a Redis adapter is a file, not a refactor.

**The audit log is a genuinely different case, and worth naming honestly.** Unlike presence state, an audit record exists precisely so that it *outlives* the session — durability is the feature, not an accident. Phase 6 therefore writes to an append-only JSONL file behind the same port pattern, which is enough to demonstrate every property that matters (idempotent writes, gap repair, three-path reconciliation) with no external dependency. If this were production rather than a demonstration, that store would be a real database. The file store is a scope decision, and the README says so rather than implying the design is finished.

**The one place a database is required — Phase 8 (optional).** Durable event log with timeline scrubbing and full session replay needs MongoDB. It is a clean bolt-on: the reducer is already pure, so replay is `events.reduce(applyEvent, initialState)` with no new domain logic. It also adds real scope and is not needed for v1.

> **Setup required: none for v1.** Phases 0–7 run with no database at all.
> Phase 8 alone needs a MongoDB Atlas free-tier cluster; the connection string goes in `.env` as `MONGODB_URI` and nowhere else.

---

## 4. Phase board

Each phase has **deliverables**, **exit criteria**, and a **demo moment** — the thing you could show someone at the end of it. A phase is not done because the code is written. It is done when the exit criteria are met and `npm run verify` is green.

**Estimates are evening-sized** (2–4 focused hours), assuming this runs alongside a full-time job.

---

### Phase 0 — Foundations · *1 evening*

**Status:** ✅ Complete — 19 September 2026

Toolchain and guardrails first, so that every later phase is protected by the same gate.

**Deliverables**
- npm workspaces monorepo; Node 22 pinned via `.nvmrc` and `engines`
- TypeScript strict: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`, `isolatedModules`, ESM throughout
- ESLint flat config + `@typescript-eslint` (type-aware rules on), Prettier, import ordering
- Vitest configured with coverage thresholds; Playwright installed
- `.env.example` documenting every variable; `config/` validates env with zod **at boot and exits non-zero on failure** — a misconfigured server must not start and serve wrong behaviour quietly
- GitHub Actions CI: `lint → typecheck → test → build → bundle-size` on every push
- MIT `LICENSE`, `CONTRIBUTING.md`, conventional-commit convention
- `docs/adr/0001-record-architecture-decisions.md`

**Exit criteria**
- `npm run verify` runs lint + typecheck + unit tests + build and exits 0
- CI badge green on `main`
- A deliberately introduced type error fails CI (verify the gate actually gates)

**Demo moment** — a reviewer clones, runs `npm i && npm run verify`, and it passes on a cold machine.

**Notes from the actual build:**
- `npm run verify` is green: lint (ESLint + `prettier --check`), typecheck, test with coverage (13 tests, 100% on the three real units — `env.ts`, `logger.ts`, `protocol`/`client` boundaries), build, and the 10 KB bundle-size gate (currently 358 B — real headroom for Phase 3).
- The type-error gate was proven directly, not just asserted: a deliberate error was injected into `env.ts`, `tsc` failed with exit code 2, then it was reverted and confirmed clean (exit 0).
- CI badge can't go green yet — that needs a GitHub push, which per `notes.local.md` waits until Phase 4. `.github/workflows/ci.yml` runs the same five steps `verify` does and is ready for that push.
- Two things came up only once real tooling ran, both fixed: `tsc`'s emitting build was including `*.test.ts` files in `dist/` (split into `tsconfig.json` for typecheck vs `tsconfig.build.json`, which excludes tests, for build), and pino's default destination isn't mockable via `process.stdout.write` spies (fixed by making `createLogger`'s destination stream injectable — better testability, not just a workaround).
- `size-limit` resolved to a version whose peer `@size-limit/file` needed pinning, and the newest `size-limit` major required a Node patch version above what's installed here — pinned both to `12.1.0`, which is mutually compatible and supports Node `^22.0.0`.
- Playwright's Chromium binary is installed locally (`npx playwright install chromium`) and the smoke spec passes headed-off; this isn't part of `verify` and won't be until Phase 4 adds the real suite.

---

### Phase 1 — Protocol & domain model · *1–2 evenings*

The heart of the project. **Pure logic, zero I/O, no server yet.** Everything that makes the system correct under adverse networks is decided here and tested in isolation.

**Deliverables**

`packages/protocol/`
- Versioned envelope: `{ v, t, sid, pid, seq, ts }` on every message
- Inbound (client → server): `hello` · `cursor` · `scroll` · `ack` · `ping` · `bye`
- Outbound (server → client): `welcome` · `join` · `leave` · `patch` · `snapshot` · `pong` · `error`
- Lifecycle/audit events: `session.start` · `session.end` · `participant.join` · `participant.leave` · `visibility.change`, each carrying a client-generated `eventId` (UUID) **and** the per-session monotonic `seq`
- zod schema per inbound type; **parse at the boundary, trust everywhere inside**
- Explicit **message classification**, which is the decision the rest of the system hangs off:

  | Class | Messages | Delivery policy |
  |---|---|---|
  | **Lossy** | `cursor`, `scroll` | May be dropped, coalesced, superseded. Only the newest value matters. |
  | **Lossless** | `hello`, `join`, `leave`, `welcome`, `snapshot` | Must arrive. Never dropped under backpressure. |
  | **Control** | `ping`, `pong`, `ack`, `error` | Out-of-band; never queued behind presence data. |
  | **Audit** | `session.*`, `participant.*`, `visibility.change` | Must arrive *eventually*. Persisted client-side before send, replayed until acknowledged, deduped on `eventId`. Survives the page. |

`apps/server/src/models/`
- `SequenceGuard` — per-participant monotonic `seq`; `accept(seq)` returns `false` for any seq ≤ last seen. **This single primitive gives both idempotency and out-of-order rejection.**
- `SequenceGuard.observedGaps()` — the guard also records *which* sequence numbers never arrived. Holding 1–7 then 9 means 8 was lost, rather than the session simply being quiet. **The message class decides what a gap means**, which is the second job the Phase 1 classification does: a gap on a *lossy* channel is expected and ignored (the frame was superseded anyway), a gap on a *lossless* or *audit* channel triggers repair. The same data structure, two behaviours, chosen by a field that already existed.
- `PresenceState` — last-writer-wins per field, ordered by server-assigned sequence, **never by client `ts`** (clocks lie; see ADR 0004)
- `Participant` — identity, colour assignment, liveness (`lastSeenAt`), viewport metadata
- `Session` — roster, per-participant presence, dirty-field tracking for delta emission
- `applyEvent(state, event) → { state, changed: FieldMask }` — pure, total, returns whether anything actually changed so the broadcaster can skip no-op ticks

**Coordinate normalisation** (`models/coordinates.ts`) — cursors are transmitted in **document-normalised space**, not viewport pixels. Two browsers at different window sizes, zoom levels and `devicePixelRatio` must place the cursor on the *same paragraph*, not the same pixel offset. Transmit `{ x: 0..1 of document width, y: absolute document px }`; resolve on render. This is the single most-missed bug in naive cursor demos and it gets its own ADR.

**Exit criteria**
- ≥95% branch coverage on `models/`
- **Property tests** (fast-check), which are the real proof:
  - *Idempotency* — applying any event N times ≡ applying it once
  - *Order tolerance* — any permutation of a lossy event set converges to the same final state as the in-order sequence
  - *Monotonicity* — `SequenceGuard` never accepts a regression, under any shuffled input
  - *Gap exactness* — for any delivered subset of a sequence, `observedGaps()` returns precisely the missing numbers: no false positives, no misses
  - *Totality* — no input, including malformed and adversarial, throws from a model function
- Zero imports of `node:*` or `dom` lib anywhere under `models/` (enforced by an ESLint `no-restricted-imports` rule, not by discipline)

**Demo moment** — `npm test -- models` shows property tests proving convergence, before a single socket is opened.

---

### Phase 2 — Server, transport & MVC wiring · *2 evenings*

**Deliverables**
- `app.ts` (Express 5, testable, no `listen`) / `server.ts` (composition root, binds HTTP + `ws` on one port, graceful shutdown on SIGTERM draining sockets with close code 1001)
- Middleware: request id → pino structured logging → helmet → CORS/origin allowlist → rate limit → centralised error handler. **Errors are never thrown to the socket layer**; they become `error` frames with a code.
- `SessionRegistry` service implementing the `SessionStore` port; TTL reaper sweeps participants whose `lastSeenAt` exceeds `PARTICIPANT_TTL_MS`
- `BroadcastHub` + `TickScheduler` — **the server does not forward messages as they arrive.** It accumulates into per-session dirty state and flushes on a fixed 20 Hz tick, emitting only the newest value per participant per field.
  *Consequence, and the reason this design is chosen:* inbound bandwidth is bounded by the client's sample rate, and **outbound bandwidth is bounded by the tick rate regardless of how many events arrive.* A participant dragging their mouse at 240 Hz costs the same downstream as one moving it slowly.
- Realtime router: dispatch table `messageType → controller`, mirroring the HTTP router
- Controllers: `SessionController` (create/join/inspect), `HealthController` (`/healthz` liveness, `/readyz` readiness), `ConnectionController` (handshake, `welcome` with full snapshot, disconnect), `PresenceController` (cursor/scroll ingest)
- Views/presenters: `toWelcome`, `toPatch`, `toSnapshot`, `toSessionDTO`
- Heartbeat: server pings every 15 s, terminates after 2 missed pongs — **`ws` does not detect half-open TCP connections for you**, and a dead client that is never reaped is a ghost cursor on everyone else's screen
- `AuditLog` service + `AuditController`, append-only and idempotent on `eventId`. Two write paths feed it — the live socket, and `POST /audit/beacon` (Phase 6) for events that outlive the page — and both land in the same deduplicated log.
- Server-inferred lifecycle events: when the heartbeat reaper kills a participant, the server writes `session.end` itself, tagged `source: 'inferred'` alongside `source: 'client'` and `source: 'socket'`. **The server never waits to be told a session ended**, because a client that vanished cannot tell it.

**Exit criteria**
- Integration tests using a real `ws` client (not a mock) covering: join, two-party mirroring, disconnect → `leave` broadcast, reconnect → `snapshot` resync, malformed JSON → `error` frame + connection survives, oversized frame → rejected without OOM
- A malformed-payload fuzz test (1000 random/adversarial frames) never crashes the process
- Graceful shutdown closes all sockets and exits 0 within 5 s

**Demo moment** — two `wscat` sessions; typing a cursor frame in one produces a coalesced patch in the other.

---

### Phase 3 — Injectable client SDK · *2 evenings*

**Deliverables**

*Capture* (`capture/`)
- Pointer sampling on `requestAnimationFrame`, **not** on every `mousemove`. `mousemove` fires up to ~240 Hz on a high-polling mouse; rAF bounds it to the display refresh and — importantly — to zero when the tab is backgrounded.
- Dead-band filter: suppress deltas under 2 device-independent px
- `scroll` via a passive listener, rAF-coalesced
- Normalisation to document space, plus viewport metadata (`docWidth`, `docHeight`, `dpr`) sent on `hello` and on resize

*Transport* (`transport/`)
- Reconnect with **exponential backoff + full jitter**, capped at 10 s. Jitter is not decoration: without it, a server restart brings every client back simultaneously in a thundering herd, and the second outage is worse than the first.
- Outbound queue with the class-based drop policy from Phase 1 — lossy frames are replaced in place, never queued behind each other
- **Backpressure**: if `socket.bufferedAmount > BACKPRESSURE_BYTES`, drop lossy frames entirely. A slow consumer must degrade to a stuttering cursor, never to unbounded memory growth.
- Heartbeat responder; `visibilitychange` → suspend capture, keep socket, resume with a fresh `hello`. **`hidden` is treated as the end-of-session signal from here on** — never `beforeunload`, never `unload` (Phase 6 covers why, and a code comment states it at the listener so nobody "helpfully" adds one later)
- Idempotent `connect()` / `disconnect()`; no double-socket on rapid toggling

*Render* (`render/`)
- Closed Shadow DOM root; cursor + label per remote participant, deterministic colour from participant id
- **Interpolation on rAF** between the last two received positions. 20 Hz of network updates rendered raw looks broken; interpolated it looks continuous. This is why the tick rate can be low, and the two decisions must be read together.
- Staleness handling: a cursor with no update for 2 s fades to 40% opacity; for 10 s it is removed. Silence is ambiguous — slow network or departed user — and the UI should communicate uncertainty rather than lie in either direction.
- Scroll-follow mode: opt-in, with **local-intent break** — any real scroll input from the local user immediately releases follow. Hijacking someone's scroll and not letting go is the cardinal sin of co-browsing.
- `prefers-reduced-motion` respected (interpolation off)

**Exit criteria**
- Bundle ≤ **10 KB gzipped**, asserted in CI (`size-limit`); the build fails, not warns
- Zero runtime dependencies (`npm ls --omit=dev` is empty for the package)
- Injecting into a page with aggressive global CSS (`* { position: relative !important }`) does not break the cursor layer — there is a fixture page for exactly this
- No uncaught errors across a 5-minute soak with forced disconnect/reconnect every 20 s

**Demo moment** — paste one `<script>` tag into any local HTML file and cursors work.

---

### Phase 4 — Demo page & two-browser harness · *1 evening*

**Deliverables**
- Server-rendered demo page: a long, content-rich scrollable document (so scroll sync is visibly meaningful, not a scrollbar toy)
- Join UI: create session → shareable link with token → participant list with colours and live latency
- `npm run demo` — boots the server and opens two browser windows already joined to the same session
- **Playwright E2E** with two independent browser contexts:
  - cursor moved in A appears in B within 250 ms
  - scroll in A with follow enabled moves B's viewport
  - B closing removes B's cursor from A within TTL
  - A reconnecting recovers full state from `snapshot`
  - follow-break: local scroll in B while following A releases follow within one frame

**Exit criteria**
- E2E suite green headless in CI on every push
- Trace + video artefacts uploaded on failure

**Demo moment** — the GIF for the README. Record here: two windows side by side, cursors tracking, scroll locking, one window killed and rejoining. **This is the single asset that determines whether anyone reads further.**

---

### Phase 5 — Chaos lab & observability · *2 evenings* ⭐

**The phase that makes this repo different from every other cursor demo.** Everything before it is table stakes; this is the argument.

**Deliverables**
- `ChaosMiddleware` in the server transport pipeline, configurable at runtime:

  | Knob | Range | Simulates |
  |---|---|---|
  | `dropRate` | 0–50% | Lossy network / dropped frames |
  | `duplicateRate` | 0–20% | At-least-once delivery, retried sends |
  | `latencyMs` ± `jitterMs` | 0–2000 ± 0–500 | Congestion, mobile networks, distance |
  | `reorderWindow` | 0–10 msgs | Multi-path routing, queue reordering |
  | `partitionMs` | 0–30000 | Total outage, laptop lid closed, tunnel |

- `/chaos` control panel wired to those knobs, **available to the reviewer in the browser** — the failure handling is not a claim in a README, it is a switch they can flip
- **Vue 3 session inspector** (`apps/inspector/`) rendering live:
  - inbound/outbound msgs·s⁻¹ and bytes·s⁻¹
  - **coalescing ratio** — events received vs patches emitted, the number that proves the tick design earns its complexity
  - dropped-by-class, duplicates rejected, out-of-order rejected, resyncs triggered
  - end-to-end latency p50/p95/p99 via echo timestamps
  - per-participant state-hash — **when the two hashes match, the clients have converged, and you can watch them re-converge live after a partition heals**
- `/metrics` in Prometheus text format
- `docs/FAILURE-MODES.md` — each failure, its symptom, the mechanism that handles it, the file it lives in, and **steps to reproduce it yourself**

**Exit criteria — the headline number**
- An automated convergence test runs the full E2E suite with `dropRate=20%`, `duplicateRate=5%`, `latency=300±150ms`, `reorderWindow=5`, and asserts **both clients reach identical state hashes within 500 ms of input stopping.** This test runs in CI.
- A partition test: 10 s full partition, then heal → convergence within 1 s, with zero manual intervention
- Coalescing ratio measurably ≥ 5:1 under continuous mouse movement

> Vue appears here rather than in the injectable client on purpose, and the README says why: the injected SDK cannot assume a framework, so Vue belongs in the operator-facing surface where it is the right tool. Surfly's stack is Vue; this shows it without compromising the design.

**Demo moment** — set drop to 20%, duplication to 5%, partition for 10 s, and watch the state hashes diverge and then snap back together. That is the whole thesis in one screen.

---

### Phase 6 — Session lifecycle & audit delivery · *2 evenings* ⭐

**The problem:** a session needs to record an audit event when the user closes the tab or navigates away. The honest starting point is that **you cannot guarantee the client tells you anything**, so this is designed for that rather than around it.

Placed after the chaos lab deliberately — Phase 5's partition and drop machinery is what makes these paths testable rather than merely asserted.

#### Client — listen to the right signal (`client/lifecycle/`)

- **`visibilitychange` → `hidden` is the end-of-session signal**, with `pagehide` as secondary.
- **Not `beforeunload`, not `unload`.** They are the intuitive choice and the wrong one: they do not fire when a tab is frozen, discarded or killed by the OS, which is most of what happens on mobile — and `unload` additionally disqualifies the page from the back/forward cache. A comment at the listener says so, so nobody adds one back later as a "fix".
- `pagehide` with `event.persisted === true` means the page went to bfcache and may return, rather than being torn down. Different situation, different flush policy — and the distinction is free, so take it.
- The page can *start* hidden (background tab, prerender). Read `visibilityState` at init; never assume a session begins visible.
- `hidden → visible → hidden` can fire many times in one session, so the flush must be **idempotent and cheap**, not a once-per-lifetime special case.

#### Client — send in a way that survives the page (`client/beacon/`)

- `navigator.sendBeacon` as primary; `fetch(url, { keepalive: true })` where the audit endpoint needs an `Authorization` header, which `sendBeacon` cannot set. A normal `fetch` or XHR is cancelled when the document goes away, so neither is an option here.
- **The ~64 KB budget is shared across all in-flight keepalive requests, not granted per request.** Two concurrent flushes can fail each other.
- **`sendBeacon` returns `false`** when the payload will not fit the queue. Check the boolean and fall back to the outbox — the common bug is treating a beacon as fire-and-forget when it is fire-and-*maybe*.
- Content-type: a `Blob` of type `application/json` is not CORS-safelisted, and a request issued on the unload path cannot rely on a preflight completing. Send `text/plain` and parse server-side, with the reason written at the call site.
- **Emit continuously, not at the end.** Audit events stream over the live socket during the session and are acknowledged as they go, so the final flush carries only a short unacknowledged tail. The payload stays under budget *by construction* rather than by truncating the record — which would drop exactly the evidence the audit log exists to hold.

#### Client — the outbox (`client/outbox/`)

- IndexedDB. **Persist before sending; clear only on acknowledgement.** Replay anything unacknowledged on next page load.
- This is the only mechanism that covers the case where *nothing fires at all* — a crash or an OS kill — which no browser event can help with.
- TTL and a hard cap on outbox entries, so a permanently failing endpoint degrades instead of filling the user's storage quota.
- bfcache restore is the canonical duplicate source: the beacon fired on hide, the page came back, it will fire again. The demo shows this happening rather than hiding it.

#### Server

- `POST /audit/beacon` — accepts the beacon content types, **idempotent on `eventId`**, returns an acknowledgement the outbox can clear against.
- Gap detection over the audit sequence: holding 1–7 then 9 means 8 was lost, not that the session was quiet. The server requests replay of the missing events on next connect.
- **An independent reconciliation sweep** — any session holding a `session.start` with no `session.end` from any source past the TTL gets an inferred close with last known state. This is the pass that catches what the happy path silently missed.
- Three independent paths converge on one record: `client` (beacon), `socket` (clean close or heartbeat timeout on the live connection), `inferred` (reconciliation sweep). When more than one reports, the log keeps **one** event and records which paths saw it.

> The architectural point, and the reason this fits here rather than in a separate project: the session already has a live WebSocket, so **the server noticing that socket drop is a more reliable end-of-session signal than anything the page can emit.** The client-side machinery above exists to enrich the record and to cover the window before the server notices — not to be trusted as the source of truth.

#### Inspector

Audit trail view: each event with its reporting source(s), duplicates rejected, gaps detected and repaired, and which of the three paths arrived first.

**Exit criteria**
- **Kill the browser process outright** (no lifecycle event fires at all) → the server still writes a complete `session.end` with last known state within the reaper TTL
- Force a bfcache duplicate → **exactly one** event in the log, recording that the client reported it twice
- Offline at flush time → the event survives in IndexedDB and lands on the next page load
- Drop 100% of beacon requests → the socket and inferred paths still close the record
- **Invariant test across every chaos configuration: the audit log contains no session with a `start` and no `end`**

**Demo moment** — the inspector table showing, for one session end, which of the three independent paths reported it and which arrived first.

---

### Phase 7 — Proxy & injection · *2–3 evenings* — the Surfly-shaped phase

The closest this toy gets to Webfuse's actual core: **co-browsing a page whose source you do not control.**

**Deliverables**
- `ProxyService` + `ProxyController`: fetch an allow-listed third-party URL server-side, rewrite, serve from the proxy origin
- HTML rewriting via a streaming parser (not regex — and `docs/adr/0007` explains why regex-over-HTML is a correctness bug, not a style preference): inject `<base>`, rewrite relative URLs, inject the client IIFE before `</body>`
- Header handling: strip `Content-Security-Policy` / `X-Frame-Options` on proxied responses, **with a loud comment and a README section explaining that this is exactly the security boundary a real product must solve properly rather than remove**
- Strict domain allowlist — the proxy is not, and must not be, an open relay
- Same-origin cookie isolation per session

**Exit criteria**
- Two browsers co-browse an allow-listed static third-party page with working cursors and scroll sync
- A documented, honest list of what breaks: SPA client-side routing, service workers, cross-origin iframes, `srcdoc`, subresource integrity, WebSocket upgrades from the guest page
- Non-allow-listed URL → 403, with a test

---

### Phase 8 — Durability & replay · *2 evenings* — **OPTIONAL, needs MongoDB**

Skip unless you specifically want to show data modelling. The repo is stronger tight than broad.

**Deliverables (if taken)**
- MongoDB append-only `session_events` collection; compound index `{ sessionId: 1, seq: 1 }`
- Write path is **asynchronous and off the hot path** — persistence must never add latency to a cursor frame, and a Mongo outage must degrade recording, not presence
- Replay endpoint + timeline scrubber: `events.reduce(applyEvent, initial)` — no new domain logic, because the reducer was pure from Phase 1. This is the payoff for that constraint and worth stating explicitly.
- TTL index for automatic expiry

**Exit criteria** — a recorded session replays to a state hash identical to the live session's final hash; Mongo being down does not affect live co-browsing (test with the container stopped).

---

### Phase 9 — Documentation, polish & publish · *1–2 evenings*

Do not treat this as cleanup. **For this purpose it is the highest-leverage phase in the plan** — the reader's decision is made in the first thirty seconds.

**Deliverables**
- `README.md` finalised, with the Phase 4 GIF **above the fold**
- `docs/PROTOCOL.md` — normative wire spec with a full message table and sequencing rules
- `docs/ARCHITECTURE.md` — data-flow diagram, the MVC map, the seams left for scale-out
- `docs/FAILURE-MODES.md` — the catalogue with repro steps
- `docs/adr/` — one file per irreversible decision (see §6)
- Deployed live instance (Fly.io or Render, free tier) so a reviewer can try it **without cloning**. Assume they will not clone.
- Repo hygiene: description, topics (`websockets`, `co-browsing`, `realtime`, `typescript`, `distributed-systems`), pinned on your profile
- 60–90 s screencast walking the chaos panel

**Exit criteria**
- A stranger reaches a working two-browser session in under 60 seconds from the README
- Every claim in the README maps to a file or a test
- No TODOs, no commented-out code, no placeholder text in the published tree

---

## 5. Schedule

| Day | Date | Phase | Evening output |
|---|---|---|---|
| 1 | Sat 20 Sep | 0 + start 1 | CI green, protocol types drafted |
| 2 | Sun 21 Sep | 1 | Models + property tests proving convergence |
| 3 | Mon 22 Sep | 2 | Server, two `wscat` clients mirroring |
| 4 | Tue 23 Sep | 3 | Client SDK, cursors visible in two tabs |
| 5 | Wed 24 Sep | 4 | Demo page, Playwright green, **GIF recorded** |
| 6 | Thu 25 Sep | 5 | Chaos lab + inspector, convergence test green |
| 7 | Fri 26 Sep | 9 | Docs, deploy, **v1 published** |
| 8–9 | w/c 29 Sep | 6 | Lifecycle & audit delivery |
| 10–12 | w/c 29 Sep | 7 | Proxy + injection |
| — | later | 8 | Optional replay, only if wanted |

**Phases 0–5 plus 9 constitute v1.** The repository is complete and defensible at that point; Phases 6–8 land afterwards as additive releases, each one a self-contained increment rather than a missing piece.

If a phase slips, **cut 7 and 8 first — never 5 or 9.** Phase 5 is the argument and Phase 9 is the delivery; the rest is scaffolding around them.

---

## 6. Decisions to record as ADRs

Each of these is irreversible enough to deserve a written rationale, and each one is a question an interviewer can open:

| ADR | Decision |
|---|---|
| 0001 | Record architecture decisions |
| 0002 | Shared `protocol` package as the single wire-format source of truth |
| 0003 | Server-side tick coalescing at 20 Hz instead of per-event forwarding |
| 0004 | Server-assigned sequence numbers for ordering; client timestamps are advisory only |
| 0005 | Document-normalised coordinates instead of viewport pixels |
| 0006 | In-memory session registry behind a `SessionStore` port; no database |
| 0007 | Streaming HTML rewriting rather than regex substitution |
| 0008 | Closed Shadow DOM for all injected UI |
| 0009 | Lossy/lossless/control message classification drives every drop decision |
| 0010 | Zero-dependency client, 10 KB gzipped budget enforced in CI |
| 0011 | `visibilitychange → hidden` as the session-end signal; `unload` and `beforeunload` rejected |
| 0012 | Persist-before-send IndexedDB outbox, cleared only on acknowledgement |
| 0013 | Three independent session-end paths reconciled into one idempotent audit record |

---

## 7. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Scope creep into DOM mirroring | Project never ships | Non-goals are fixed in §1 and in the README; DOM mirroring is explicitly out |
| Chaos lab becomes a rabbit hole | Phase 8 gets squeezed | Timebox to 2 evenings; the five knobs in §Phase 5 are the whole feature set |
| Proxy phase breaks on real-world pages | Looks unfinished | Allowlist a small set of known-good static pages; publish the honest breakage list as a deliverable |
| Polish deferred to "later" | Nobody reads past line 10 | Phase 8 is scheduled, not optional; the GIF is a Phase 4 exit artefact |
| Free-tier deploy sleeps and reviewer sees a cold start | Bad first impression | Keep-alive ping + a README note that the demo is on free-tier hosting |

---

## 8. Definition of done

The repository is finished when all of the following are true:

- [ ] A stranger can run two browsers against the live demo in under 60 seconds without cloning
- [ ] Convergence under chaos is demonstrated by a CI test, not asserted in prose
- [ ] Every failure mode in `docs/FAILURE-MODES.md` has a named mechanism and a file reference
- [ ] `models/` is pure, ≥95% branch covered, and provably free of I/O imports
- [ ] The client bundle is under budget and dependency-free, enforced by CI
- [ ] The README states plainly what was not built and why
- [ ] No session in the audit log holds a `start` with no `end`, under any chaos configuration
- [ ] `npm run verify` and the E2E suite are green on `main`

---

*The point of this repository is not that cursors move. It is that they keep agreeing about where they are when the network refuses to cooperate.*
