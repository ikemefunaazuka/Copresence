# 0013 — Three independent session-end paths reconciled into one idempotent audit record

## Status

Accepted

## Context

"The client will tell the server when a session ends" is not a premise this system is willing to build on — ADR 0011 already establishes that the client-side signal is a best effort, not a guarantee. Given that, a session's end has to be detectable by at least one path that does not depend on the client cooperating at all, and preferably by more than one, since each individually degrades under different failure modes:

- **`client`** — a `session.end` audit message, over the live socket or the `POST /audit/beacon` fallback. Richest detail, but only exists if the page got the chance to run and reach the network.
- **`socket`** — the server observing its own WebSocket connection close without a preceding `bye`. Needs no client cooperation beyond the TCP/WS layer tearing down normally, but misses a connection that goes silent without ever closing (a frozen tab, a lost network with no FIN).
- **`inferred`** — `Reaper`'s heartbeat-TTL sweep, and `AuditReconciler`'s independent sweep for any `session.start` with no `session.end` past a TTL. Catches everything the other two miss, including a process killed hard enough that no close frame is ever sent — at the cost of only detecting the end up to a TTL late.

Each path was built independently (`AuditController`, `ConnectionController.handleDisconnect`, `Reaper`, `AuditReconciler`), and each generates its own `eventId` when it writes — there is no shared identifier a `client` report and a `socket` report could ever coincidentally share. Naive idempotency-on-`eventId` alone (as used for a literal retry of the _same_ report — see ADR 0012's bfcache case) does nothing to stop the _same real session ending_ from being recorded three separate times, once per path that happened to notice it.

## Decision

`AuditLog.record` treats `session.end` specially. Beyond the existing `eventId`-based idempotency (an exact retry of the same report), a `session.end` also converges onto an existing record when it closes the _same still-open instance_: the one most recently opened by a `session.start` for that `(sid, pid)` with no `session.end` after it yet. Concretely, `AuditLog`'s internal `#openSessionEnd(sid, pid)` finds the latest `session.start` and latest `session.end` on file for that pair; if a `session.end` already closes the latest `session.start` (i.e. no fresher `session.start` has reopened the instance since), a new report for that same close is folded into the _existing_ record's `reports` list instead of becoming an independent one.

The first path to report keeps its `eventId` and content as the canonical record; every subsequent convergent report — regardless of source — only appends an `{ source, recordedAt }` entry to `reports`. This is what lets the inspector (and the exit criteria) answer "which of the three paths reported it, and which arrived first" directly from `reports[0]`, without a separate cross-reference table.

The one case this deliberately does _not_ collapse: a `session.end` reported for an instance a _fresh_ `session.start` has since reopened. That is a genuinely new session, not a late report of the old one's close, and `#openSessionEnd` returns nothing for it — the record it produces is independent, exactly as intended for a reconnect.

`AuditReconciler` runs this same reasoning at a coarser grain — a periodic full sweep for any `(sid, pid)` with an open `session.start` and no `session.end` at all, past a TTL — rather than per-write, since it exists specifically to catch the case where _no_ path reported anything yet.

**A rejected alternative:** a numeric, per-audit-sequence gap detector — "holding 1–7 then 9 means 8 was lost" — was considered and set aside. The wire protocol's `seq` is one shared, monotonic counter per connection across _every_ message type (see ADR 0004), not an audit-specific stream; deriving a second, audit-only sequence would mean either a new field on every audit message or inferring one from arrival order, both adding a real mechanism for a problem the `eventId`-plus-outbox design (ADR 0012) already solves by construction — an event that never arrived is simply still sitting, unconfirmed, in the sender's outbox, and gets replayed on the next flush without the server ever needing to notice a hole in a sequence to ask for it.

## Consequences

The audit log's invariant — no session ever left with a `session.start` and no `session.end` — no longer depends on any single path being reliable, including the client's own. A killed process is caught by the reaper; a socket that closes cleanly without a `bye` is caught immediately; a client that manages to report is caught fastest, and just as correctly folds into whichever of the other two got there first, or is folded into by them. The tradeoff is the same one every idempotency scheme runs into: correctness has been extended from an exact key match to a semantic one, which requires a real invariant to hold — "the current still-open instance is well-defined by (latest start, latest end)" — that a subtler bug (an out-of-order write, a reused `eventId` across truly distinct sessions) could violate in a way a simple `Map.has(eventId)` check never could have. `AuditLog.test.ts`'s convergence-specific cases exist to keep that invariant honest.
