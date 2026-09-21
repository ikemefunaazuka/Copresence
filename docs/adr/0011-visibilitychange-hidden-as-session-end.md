# 0011 — `visibilitychange → hidden` as the session-end signal; `unload` and `beforeunload` rejected

## Status

Accepted

## Context

A co-browsing session needs an audit record of when a participant's engagement ends — not just when their WebSocket happens to close, but a signal the client itself can report while it still can. The obvious first instinct is `beforeunload` or `unload`: they sound like exactly "the user is leaving." They are also the wrong choice, and picking them would have been a bug shipped as a feature.

Neither fires when a tab is frozen, discarded, or killed by the OS — which is most of what actually happens to a background tab on mobile, and an increasing share of what happens on desktop as browsers get more aggressive about reclaiming inactive tabs. A handler that only fires on the cooperative, foreground, "user clicked the X" case covers a shrinking minority of real session endings. Worse, registering an `unload` listener has a second cost even when it does fire: it unconditionally disqualifies the page from the back/forward cache (bfcache), making every navigation away from the page slower to return to, as a side effect of trying to record that the navigation happened.

## Decision

`visibilitychange` firing `hidden` is treated as the end-of-session signal. It fires reliably for tab switches, minimization, and the vast majority of real navigations (in every major browser, `visibilitychange` fires before `pagehide` on a foreground tab going away), without the bfcache penalty. `pagehide` is wired as a secondary, best-effort flush trigger for whatever the outbox still has pending at that instant — not a second source of session-boundary events — since by the time it fires, the preceding `hidden` transition has almost always already built and attempted to send the real `session.end`. `pagehide`'s own `event.persisted` flag additionally distinguishes a bfcache freeze (the page may resume) from a genuine teardown, which changes what kind of flush is worth attempting (see `lifecycle.ts`).

`beforeunload`/`unload` are not used anywhere in this SDK. A comment sits at the `visibilitychange` listener itself saying so, specifically to stop a future "fix" that adds one back in the name of catching an edge case `hidden` already covers, at the cost of bfcache for every page that embeds this SDK.

One consequence taken deliberately, not accidentally: a hidden transition cannot distinguish a tab switch from a real close, so the `session.end` it builds always carries `reason: 'navigate'` — the one self-reportable value that doesn't claim more certainty than the client actually has (see `SessionEndMessage['reason']` in `packages/protocol/src/schemas.ts`, and the comment at `closeSession` in `lifecycle.ts`).

"Session" here means a period of foreground engagement, not the WebSocket connection itself — the socket stays open across a hide (`index.ts`'s own, pre-existing `handleVisibilityChange` only pauses capture), so `hidden → visible → hidden` can fire many times against one connection, each its own `session.start`/`session.end` pair. The client must therefore treat this as routine, not a once-per-lifetime special case — see the idempotent-transition guard in `lifecycle.ts`'s `onVisibilityChange`.

## Consequences

Session boundaries are honest about what the client can actually know at the moment it reports them, at the cost of losing the tab-switch/close distinction a real `reason` enum implies is available. The server-side architecture does not depend on this signal being reliable in the first place — see ADR 0013 — so a hidden event that never fires, or a page that dies before it can send one, degrades to the reaper's TTL sweep rather than leaving a permanently open session. This ADR only has to be right about what the client _should attempt_, not about guaranteeing it arrives.
