# 0004 — Server-assigned sequence numbers for ordering; client timestamps are advisory only

## Status

Accepted

## Context

Presence state needs a way to decide which of two conflicting updates is newer. The obvious candidate is the timestamp each client already attaches to its own messages — it is right there, it is cheap, and it looks like exactly the right kind of value for this job.

It is also not trustworthy. A client's clock can be skewed by any amount, adjusted mid-session by the OS or the user, and is trivially forgeable by anyone who can reach the WebSocket at all. Ordering presence updates by client `ts` means the correctness of the whole convergence story rests on every participant's local clock being honest and synchronised, which is not a property this system — or most systems — can assume.

## Decision

Ordering uses a sequence number the **server** assigns (or, for inbound per-participant sequencing, validates as strictly increasing per participant via `SequenceGuard`) — never the client's `ts`. `PresenceState`'s last-writer-wins logic (`withCursor`, `withScroll`) compares on `seq`, full stop. The client's `ts` is still carried on every message, but its only sanctioned use is latency measurement (comparing a `pong`'s echoed `ts` against the current time) — it never participates in a correctness decision.

## Consequences

Convergence is provable independent of clock behaviour: two clients with wildly different clocks, or a client with no working clock at all, still converge correctly, because nothing about correctness depends on `ts`. This is directly why `applyEvent`'s idempotency and order-tolerance property tests can be stated and proven without any assumption about time.

The cost is that the server must be the ordering authority, which is a constraint the architecture already accepted — the design is server-mediated end to end (ADR 0002's shared protocol, and eventually a proxy for co-browsing pages this project does not own), never peer-to-peer, so this forecloses nothing that was open. A future multi-node deployment would need per-session sequence assignment to be consistent across nodes (a single owner node per session, or a coordinated counter) — noted as the scale-out seam this repository documents but does not build (README, "What this is not").
