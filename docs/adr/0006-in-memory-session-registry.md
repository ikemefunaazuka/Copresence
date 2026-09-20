# 0006 — In-memory session registry behind a `SessionStore` port; no database

## Status

Accepted

## Context

Presence state — cursor position, scroll offset, the participant roster — has a natural lifetime of exactly one WebSocket connection. It is meaningless a few seconds after it stops changing, and nothing about this project needs it to survive a restart. Reaching for a database here would be adding a network hop to the hottest path in the system, and a second source of truth that has to stay converged with the in-memory model doing the actual work, in exchange for a durability guarantee nobody asked for.

## Decision

`SessionRegistry` is a `Map<SessionId, Session>` wrapped in a class, and it implements a small `SessionStore` interface (`get`, `getOrCreate`, `save`, `delete`, `all`) rather than being consumed as a concrete class directly. The interface is the actual point: `apps/server/src/services/SessionRegistry.ts` documents this store as one considered implementation of that port, not the only possible one. No other implementation is built, because none is needed for what this repository sets out to demonstrate (see the project plan's Data & Persistence section).

The same reasoning extends to the TTL reaper built alongside it: `reapStale` lives on `SessionRegistry` because it is a storage-layer concern (which participants are stale enough to remove from the map), but what a removal _means_ — the `leave` broadcast, the inferred audit record — is deliberately kept out of this class and pushed to a separate `Reaper` service that composes `SessionRegistry`, `BroadcastHub` and `AuditLog` together. The storage decision and the consequence of a removal are two different concerns, and coupling them would have made the store harder to reason about for no benefit.

## Consequences

Zero setup cost for every phase this repository actually ships: no connection string, no migration, no container to keep running alongside the server. `npm run verify` and the integration suite exercise the real code path end to end with nothing to provision.

The honest limit, stated once and not hidden: this does not scale horizontally. A second server process would hold its own, disjoint registry, and two participants in the "same" session connected to different processes would never see each other. The `SessionStore` port is exactly the seam a Redis- or database-backed implementation would fill for that case — a new file behind the existing interface, not a rewrite of every caller — and it is deliberately left undocumented-in-code beyond that seam, because building it is out of scope for a toy (README, "What this is not").

The audit log (`AuditLog`) is a different case from presence data and is not what this ADR is about: an audit record exists precisely so it outlives the session, which is a real argument for durability that presence state does not share. `AuditLog` is in-memory for now anyway, matching the same "no database needed yet" posture, with its own upgrade path (a JSONL-backed implementation behind the same shape) explicitly reserved for later rather than built early against a need that has not arrived yet.
