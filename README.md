<div align="center">

# Copresence

**Two browsers, one cursor and scroll state, over WebSockets — built to stay in agreement when the network refuses to cooperate.**

[![CI](https://img.shields.io/badge/CI-pending-lightgrey)](#)
[![TypeScript](https://img.shields.io/badge/TypeScript-strict-3178c6)](#)
[![Client bundle](https://img.shields.io/badge/client-%E2%89%A410KB%20gzipped-success)](#)
[![License](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

<!-- docs/assets/demo.gif — two windows, cursors tracking, scroll locking, one killed and rejoining -->

</div>

## What this is

A deliberately small co-browsing core. Two people open the same session; each sees the other's cursor move across the page and, optionally, follows their scroll.

That is a demo you have seen before. The reason this one exists is the second half:

**It is built on the assumption that messages arrive twice, arrive late, arrive out of order, or never arrive at all — and the two browsers have to end up agreeing anyway.** There is a chaos panel in the running app that lets you break the network yourself and watch the state re-converge.

## What this is not

Named up front, because an engineer who can say what they did not build is easier to trust than one who implies they built everything:

- **Not DOM mirroring.** Presence state only — cursor and scroll. No mutation streaming, no session replay of guest-page DOM.
- **Not WebRTC.** No audio, video or peer-to-peer data channels. This is a server-mediated WebSocket system end to end.
- **Not horizontally scalable.** One process, in-memory state. The seam where a Redis pub/sub adapter would go is defined as an interface and documented — it is not implemented.
- **Not a production proxy.** The proxy phase handles a small allowlist of static pages. Service workers, cross-origin iframes, CSP nonce reconstruction and cookie partitioning are out of scope and listed individually in [`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md).
- **Not authenticated** beyond an unguessable session token.

---

## Quick start

```bash
git clone https://github.com/ikemefunaazuka/copresence.git
cd copresence
npm install
npm run demo          # boots the server and opens two joined browser windows
```

Or open the hosted instance, create a session, and send the link to a second browser. No install, no clone.

```bash
npm run verify        # lint + typecheck + unit tests + build + bundle-size budget
npm run test:e2e      # Playwright, two real browser contexts
npm run test:chaos    # the E2E suite again, with the network deliberately broken
```

---

## The problem this is actually about

A cursor demo looks trivial: read `mousemove`, send `{x, y}`, draw a dot. It stops being trivial the moment you write down what the transport actually guarantees, which is _very little_.

Five things go wrong, and four of them are invisible on localhost:

1. **Volume.** `mousemove` fires up to ~240 Hz on a high-polling mouse. Forwarding each event to each peer is a self-inflicted denial of service that only shows up with more than two participants.
2. **Duplication.** Any retry path — application-level or infrastructure — can deliver the same frame twice.
3. **Reordering.** Frame _N+1_ overtakes frame _N_. Applied naively, the cursor jumps backwards and stays wrong until the next update happens to arrive in order.
4. **Loss and silence.** A dropped frame and a departed participant are indistinguishable from the receiving end. Both look like nothing arriving.
5. **Disagreement.** Two clients that each dropped a _different_ frame now hold different state, and nothing in the system notices.

This is the same shape as webhook reconciliation, which is where the design came from: callbacks that arrive twice, arrive late, arrive out of order, or never arrive — and a reconciliation pass that catches the last case instead of assuming it away. Real-time presence is that problem wearing different clothes. The response here is the same one: **make every write idempotent, make ordering authoritative and server-side, and have an independent path that repairs state when the happy path silently failed.**

---

## How it works

```
   Browser A                       Node server                      Browser B
┌──────────────┐              ┌──────────────────────┐          ┌──────────────┐
│  capture     │              │  Controller          │          │  capture     │
│  rAF-sampled │──cursor─────▶│  validate (zod)      │          │              │
│  dead-banded │   ~60 Hz     │  SequenceGuard       │          │              │
│  normalised  │              │       │              │          │              │
├──────────────┤              │       ▼              │          ├──────────────┤
│  transport   │              │  Model               │          │  transport   │
│  backoff     │              │  applyEvent (pure)   │          │  backoff     │
│  heartbeat   │              │  LWW by server seq   │          │  heartbeat   │
│  backpressure│              │       │              │          │  backpressure│
├──────────────┤              │       ▼              │          ├──────────────┤
│  render      │◀─────patch───│  TickScheduler 20 Hz │──patch──▶│  render      │
│  shadow DOM  │   coalesced  │  newest-value-only   │ coalesced│  shadow DOM  │
│  interpolated│              │  View (presenters)   │          │  interpolated│
└──────────────┘              └──────────────────────┘          └──────────────┘
                                         │
                                  ┌──────┴───────┐
                                  │ ChaosMiddle- │  drop · duplicate · delay
                                  │ ware (dev)   │  reorder · partition
                                  └──────────────┘
```

**Inbound is fast and cheap; outbound is bounded.** The server never forwards an event as it arrives. It folds events into per-session state and flushes on a fixed 20 Hz tick, emitting only the newest value per participant per field. Downstream bandwidth is therefore a function of the tick rate and the participant count — **not** of how fast anyone moves their mouse.

Twenty updates a second rendered raw looks like a stuttering cursor, so the client interpolates between the last two known positions on `requestAnimationFrame`. Those two decisions only make sense together: coalescing buys the bandwidth, interpolation buys the smoothness back.

---

## Failure modes handled

Each row is a real mechanism in the source, not an intention. Reproduction steps for every one are in [`docs/FAILURE-MODES.md`](docs/FAILURE-MODES.md), and the chaos panel lets you trigger them yourself.

| #   | Failure                           | How it presents                                            | Mechanism                                                                                                                                                                                                                                                                                            |
| --- | --------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Duplicate delivery**            | Same frame applied twice                                   | `SequenceGuard` rejects any `seq ≤ lastSeen`. Re-applying is a no-op by construction, proven by a property test.                                                                                                                                                                                     |
| 2   | **Out-of-order arrival**          | Cursor jumps backwards                                     | Same guard. Stale frames are dropped, not applied. Lossy data has no reason to be reordered into place — only the newest value matters.                                                                                                                                                              |
| 3   | **Clock skew**                    | Client timestamps disagree, ordering is wrong              | Ordering uses **server-assigned sequence numbers only**. Client `ts` is carried for latency measurement and never for ordering. Clocks lie; sequence numbers do not.                                                                                                                                 |
| 4   | **Message flood**                 | 240 Hz input saturates the link                            | rAF sampling + 2 px dead-band client-side; 20 Hz newest-value coalescing server-side. Coalescing ratio is on the metrics panel.                                                                                                                                                                      |
| 5   | **Slow consumer**                 | One bad connection grows memory without bound              | `bufferedAmount` backpressure. Over threshold, **lossy** frames are dropped; **lossless** frames never are. Degrades to a stuttering cursor, never to an OOM.                                                                                                                                        |
| 6   | **Disconnect**                    | Peer vanishes; ghost cursor remains                        | Heartbeat ping every 15 s, terminate after 2 missed pongs, TTL reaper sweeps the roster. `ws` will not detect a half-open TCP connection for you.                                                                                                                                                    |
| 7   | **Reconnect**                     | Client returns holding stale state                         | Server sends a full `snapshot` on rejoin. State is repaired by replacing it, not by replaying a backlog — the reconciliation pass, not the happy path.                                                                                                                                               |
| 8   | **Reconnect storm**               | Server restart brings every client back at once            | Exponential backoff with **full jitter**, capped at 10 s. Without jitter the recovery is a second outage.                                                                                                                                                                                            |
| 9   | **Ambiguous silence**             | Slow network and departed user look identical              | Staleness is expressed, not guessed: fade at 2 s, remove at 10 s. The UI communicates uncertainty instead of lying in either direction.                                                                                                                                                              |
| 10  | **Mismatched viewports**          | Cursor lands in the wrong place at a different window size | Coordinates travel in **document-normalised space**, resolved at render against the local viewport and `devicePixelRatio`. The most commonly missed bug in cursor demos.                                                                                                                             |
| 11  | **Hostile host-page CSS**         | Injected UI breaks or leaks styles                         | All injected UI lives in a **closed Shadow DOM**. There is a fixture page with `* { position: relative !important }` that must keep passing.                                                                                                                                                         |
| 12  | **Malformed / adversarial input** | Bad frame crashes the process                              | zod validation at the boundary, size caps, and a 1000-frame fuzz test. Invalid input produces an `error` frame; the connection survives.                                                                                                                                                             |
| 13  | **Scroll hijack**                 | Being dragged around the page with no escape               | Follow mode is opt-in and **breaks on local scroll intent** within one frame.                                                                                                                                                                                                                        |
| 14  | **Silent divergence**             | Two clients quietly hold different state                   | Per-participant **state hashes** on the inspector. When they match, the clients have converged — and you can watch them re-converge after a partition heals.                                                                                                                                         |
| 15  | **Tab closed / navigated away**   | The session-end audit event is never delivered             | `visibilitychange → hidden` as the flush signal — **not `beforeunload` or `unload`**, which do not fire on freeze, discard or OS kill, and where `unload` also disqualifies bfcache. Delivery via `sendBeacon` / `fetch(keepalive)`, which outlive the document where `fetch` and XHR are cancelled. |
| 16  | **Browser or OS kills the tab**   | Nothing fires at all; no event can help                    | Two independent covers: an IndexedDB outbox written **before** send and replayed on next load, and a server-side reconciliation sweep that writes an inferred `session.end` from last known state. The server never waits to be told.                                                                |
| 17  | **bfcache restore**               | The same beacon fires twice                                | The canonical duplicate source, so it is demoed rather than hidden. Deduplication on a client-generated `eventId`; the log keeps one event and records that the client reported it twice.                                                                                                            |
| 18  | **Audit gap**                     | Server holds events 1–7 and 9                              | Gaps are detected, not inferred from silence: 8 was _lost_, the session was not quiet. Replay is requested on next connect. A gap on a _lossy_ channel is expected and ignored — the message class decides what a gap means.                                                                         |

---

## The chaos lab

The part worth actually opening. `/chaos` exposes five knobs on the live server:

| Knob                   | Range          | Simulates                               |
| ---------------------- | -------------- | --------------------------------------- |
| `dropRate`             | 0–50%          | Lossy network, dropped frames           |
| `duplicateRate`        | 0–20%          | At-least-once delivery, retried sends   |
| `latencyMs ± jitterMs` | 0–2000 ± 0–500 | Congestion, mobile networks, distance   |
| `reorderWindow`        | 0–10 msgs      | Multi-path routing, queue reordering    |
| `partitionMs`          | 0–30000        | Total outage, closed laptop lid, tunnel |

The Vue 3 session inspector shows msgs·s⁻¹ in and out, the **coalescing ratio**, drops by message class, duplicates and out-of-order frames rejected, resyncs triggered, end-to-end latency percentiles, and the per-participant state hash.

The headline test in CI runs the full end-to-end suite with **20% loss, 5% duplication, 300 ms ± 150 ms latency and a 5-message reorder window**, and asserts that both clients reach identical state hashes within 500 ms of input stopping. A ten-second full partition must heal to convergence within one second with no manual intervention.

That test is the point of the repository. Everything else is the apparatus that makes it meaningful.

---

## Session lifecycle and the audit trail

When a session ends, that fact has to be recorded. The starting point is that **you cannot guarantee the client tells you anything**, so the design assumes it will not.

Three independent paths report a session ending, and they are reconciled into one record:

| Path         | Signal                                                                      | Covers                                        | Fails when                            |
| ------------ | --------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------- |
| **Client**   | `visibilitychange → hidden`, flushed via `sendBeacon` / `fetch(keepalive)`  | Ordinary tab close, navigation, backgrounding | The process dies before anything runs |
| **Socket**   | Clean close, or heartbeat timeout on the live connection                    | Crash, network loss, OS kill                  | The server itself restarts            |
| **Inferred** | Reconciliation sweep over sessions holding a `start` with no `end` past TTL | Everything the first two missed               | —                                     |

Each event carries a client-generated `eventId` and a per-session sequence number, so the log deduplicates on arrival and **keeps one event while recording which paths reported it**. Gaps are detected rather than inferred from silence: holding 1–7 and then 9 means 8 was lost, not that the session went quiet.

Client-side, events stream over the live socket continuously and are acknowledged as they go, so the final flush carries only a short unacknowledged tail — the payload stays inside the shared ~64 KB keepalive budget _by construction_ rather than by truncating the record, which would discard exactly the evidence the log exists to hold. Anything unacknowledged is written to an IndexedDB outbox **before** the send is attempted and replayed on the next page load, which is the only thing that covers a crash or an OS kill.

The architectural point: this session already has a live WebSocket, so **the server noticing the socket drop is a more reliable end-of-session signal than anything the page can emit.** The client machinery exists to enrich the record and to cover the window before the server notices — not to be the source of truth. The invariant that matters, asserted under every chaos configuration: _no session holds a `start` with no `end`._

---

## Design decisions

The full set lives in [`docs/adr/`](docs/adr/). The five worth arguing about:

**Server-side tick coalescing over per-event forwarding.**
Forwarding is simpler and has lower latency for a single event. It also makes outbound bandwidth a function of input rate, which is unbounded and controlled by the user's hardware. Coalescing caps the cost at `tickRate × participants` and adds at most 50 ms of latency — below the threshold where cursor movement reads as laggy, especially once interpolation is applied. _Trade-off:_ a deliberate 50 ms latency floor. _At scale:_ the tick would move per-session and adapt to observed RTT.

**Server-assigned sequence numbers, not client timestamps.**
Client clocks are wrong — skewed, adjusted mid-session, and trivially forgeable. Any ordering that trusts them is decorative. The server stamps arrival order; client `ts` survives only to measure latency. _Trade-off:_ the server must be the ordering authority, which forecloses peer-to-peer. That was already foreclosed by the proxy architecture.

**Document-normalised coordinates, not viewport pixels.**
Two browsers at different window sizes must place a cursor on the same _paragraph_, not the same pixel offset. Normalising against document width and absolute document height, with `devicePixelRatio` resolved at render, makes correctness independent of window geometry. _Trade-off:_ breaks under responsive reflow where the two viewports render genuinely different layouts, which is documented rather than papered over.

**In-memory state, no database.**
Presence data has a natural lifetime of one connection and is meaningless three seconds after it is written. Persisting it would add a hop to the hot path and a second source of truth to keep converged, in exchange for a durability guarantee nobody needs. The registry sits behind a `SessionStore` port so the choice is visible and a Redis adapter is a file, not a refactor. Optional session _recording_ — a genuinely different requirement — is an append-only event log, and because the reducer is pure, replay is `events.reduce(applyEvent, initial)` with no new domain logic.

**Zero-dependency client, 10 KB gzipped, enforced in CI.**
The client is designed to be injected into a page whose source it does not control. It cannot assume a framework, a module loader, or that the host page will not fight it. So: no dependencies, closed Shadow DOM, passive listeners, one namespaced global. The budget is a build failure, not a warning, because a size budget nobody enforces is a comment.

**Vue only on the operator surface.**
The injected client must be framework-free for the reasons above. The session inspector has no such constraint and is the right place for a real component framework — so it is Vue 3. Two different surfaces, two different correct answers.

---

## Architecture

MVC on the server, with one rule that keeps it honest: **`models/` imports nothing from Node and nothing from the browser.** It is pure TypeScript, enforced by an ESLint `no-restricted-imports` rule rather than by discipline. If a model needs a mock to be tested, it is in the wrong folder.

```
packages/
  protocol/          the wire contract — types, zod schemas, codec, version
                     one definition, both ends fail to compile when it changes
  client/            zero-dependency injectable SDK
    capture/         rAF sampling, dead-band, coordinate normalisation
    transport/       reconnect, heartbeat, backpressure, drop policy
    render/          shadow-DOM cursor layer, interpolation, staleness
apps/
  server/
    models/          Session · Participant · PresenceState · SequenceGuard
                     applyEvent() — pure, total, idempotent
    views/           presenters: domain state → wire DTOs → HTML
    controllers/     http/ and realtime/ — thin, no domain rules
    services/        SessionRegistry · BroadcastHub · TickScheduler · Metrics
    routes/          HTTP route table + realtime dispatch table
    middleware/      requestId · logging · errors · rate limit · origin guard
    config/          zod-validated env; fails fast at boot
  inspector/         Vue 3 + Vite live session inspector
e2e/                 Playwright, two real browser contexts
```

Realtime messages are routed through a dispatch table, not a `switch` sprawled through the socket handler — the same shape as the HTTP router, for the same reason. Full diagrams in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); the normative wire format in [`docs/PROTOCOL.md`](docs/PROTOCOL.md).

---

## The protocol

Every frame carries `{ v, t, sid, pid, seq, ts }`. Messages are classified, and the classification drives every drop decision in the system:

| Class        | Messages                                        | Policy                                                                |
| ------------ | ----------------------------------------------- | --------------------------------------------------------------------- |
| **Lossy**    | `cursor`, `scroll`                              | May be dropped, coalesced, superseded. Only the newest value matters. |
| **Lossless** | `hello`, `join`, `leave`, `welcome`, `snapshot` | Must arrive. Never dropped under backpressure.                        |
| **Control**  | `ping`, `pong`, `ack`, `error`                  | Out-of-band. Never queued behind presence data.                       |

Getting this classification right early is what makes backpressure a two-line policy instead of a pile of special cases: under pressure you shed lossy frames and nothing else, and the roster stays correct even when the cursors stutter.

---

## Testing

| Layer      | Tool                           | What it proves                                                                                                                                                                   |
| ---------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Models     | Vitest + fast-check            | **Property tests**: applying any event N times ≡ once; any permutation of lossy events converges to the same state; `SequenceGuard` never accepts a regression; no input throws. |
| Server     | Vitest + real `ws` client      | Join, mirroring, disconnect, resync, malformed frames, 1000-frame fuzz without a crash.                                                                                          |
| Client     | Vitest + jsdom                 | Backoff timing, drop policy, dead-band, normalisation, hostile-CSS fixture.                                                                                                      |
| End-to-end | Playwright, 2 browser contexts | Cursor mirroring, scroll follow, follow-break, reconnect recovery.                                                                                                               |
| **Chaos**  | Playwright + ChaosMiddleware   | **Convergence under 20% loss, 5% duplication, 300 ms jitter, reorder window 5.**                                                                                                 |

The property tests are the ones that matter. They prove convergence over the whole input space rather than over the handful of orderings a human thought to write down.

---

## Roadmap

**v1**

- [ ] Toolchain, strict TypeScript, CI gate
- [ ] Protocol + pure domain model, property tests
- [ ] Express/`ws` server, MVC, tick coalescing
- [ ] Injectable zero-dependency client SDK
- [ ] Demo page, Playwright two-browser suite
- [ ] Chaos lab, Vue inspector, convergence test
- [ ] Docs, deployed demo, published

**After v1, as additive releases**

- [ ] Session lifecycle & audit delivery
- [ ] Proxy + injection into a page it does not control
- [ ] _(optional)_ Durable event log and replay

---

## Why this exists

I built this while applying to [Surfly](https://surfly.com), whose product is co-browsing built on JavaScript sandboxing and proxy infrastructure. Reading a job description and claiming to understand a problem is cheap. This is the same problem at a much smaller scale, built honestly, including the parts that do not work and the reasons they do not.

The interesting constraint in this domain is adding functionality to an application whose source you do not control. Everything in the client — no dependencies, closed Shadow DOM, passive listeners, one global, a hard size budget — follows from taking that constraint seriously.

---

## License

MIT — see [LICENSE](LICENSE).

**Precious Ikemefuna Azuka** · [github.com/ikemefunaazuka](https://github.com/ikemefunaazuka) · [linkedin.com/in/precious-ikemefuna-azuka](https://linkedin.com/in/precious-ikemefuna-azuka)

---

<div align="center">
<sub>The point is not that the cursors move. It is that they keep agreeing about where they are when the network stops cooperating.</sub>
</div>
