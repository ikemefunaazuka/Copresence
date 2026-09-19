# 0009 — Lossy/lossless/control/audit message classification drives every drop decision

## Status

Accepted

## Context

Under load, or under the deliberate packet loss the chaos lab (Phase 5) introduces, something eventually has to give: a slow consumer, a saturated link, a reconnecting client. The system needs a rule for what is allowed to be dropped and what is not — and that rule needs to be decided once, in one place, rather than re-litigated ad hoc at every call site that happens to face backpressure. A `SequenceGuard` gap is also meaningless on its own: whether a gap should trigger repair or be shrugged off depends entirely on what kind of data went missing.

## Decision

Every message type is classified into exactly one of four classes, defined once in `packages/protocol/src/messages.ts` as a `Record` keyed by every member of the message type union (so the compiler — not a runtime check — rejects any new message type that is added without a classification):

- **Lossy** (`cursor`, `scroll`, `patch`) — may be dropped, coalesced, or superseded. Only the newest value matters.
- **Lossless** (`hello`, `bye`, `join`, `leave`, `welcome`, `snapshot`) — must arrive. Never dropped under backpressure.
- **Control** (`ping`, `pong`, `ack`, `error`) — out-of-band. Never queued behind presence data.
- **Audit** (`session.*`, `participant.*`, `visibility.change`) — must arrive _eventually_. Persisted client-side before send, replayed until acknowledged, deduplicated on `eventId`.

`patch` and `bye` are not named explicitly in the classification MILESTONE.md first sketched, and their class here is a considered inference rather than a guess left undocumented: `patch` is the broadcast _output_ of coalescing lossy data, so it inherits lossy's policy — a missed tick is superseded by the next one ~50ms later. `bye` is a clean-disconnect notification in the same family as `hello`/`join`/`leave`; dropping it silently would be indistinguishable from the disconnect never having been announced, so it is lossless.

## Consequences

Backpressure (Phase 3) becomes a two-line policy — shed lossy frames, never anything else — instead of a pile of special cases invented under pressure at 2am. `SequenceGuard`'s gap tracking (Phase 1) reuses the same classification to decide what a gap means: a gap on a lossy channel is expected and ignored; a gap on lossless or audit triggers repair. One `Record`, two different systems built on top of it, neither one needing its own copy of the same decision.

The cost is that the classification has to be right, and — as this repository's own gaps in `patch`/`bye` show — the source document describing the system is not always complete on its first pass. The fix here is not to leave the gap silent; it is to resolve it with reasoning that is written down and can be argued with, which is what this ADR and the comment in `messages.ts` both exist to do.
