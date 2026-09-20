# 0008 — Closed Shadow DOM for all injected UI

## Status

Accepted

## Context

This SDK is injected into a page it does not control — a single `<script>` tag pasted into someone else's HTML. Two failure directions exist simultaneously: the host page's CSS reaching in and corrupting the cursor overlay's layout (a global `* { all: unset }` or `* { position: relative !important }` reset is not a hypothetical, it is a common pattern in CSS resets and component libraries), and this SDK's own styles or markup leaking out and corrupting the host page. Anything less than full encapsulation means every future host page is a new integration risk.

## Decision

Everything this SDK renders lives inside one `attachShadow({ mode: 'closed' })` root (`render/shadowRoot.ts`), hung off a single `<div data-copresence-root>` appended to `document.body`. `closed` rather than `open`: an open root still exposes `element.shadowRoot` to any host-page script that goes looking for it, and there is no legitimate reason for a host page to reach into this SDK's internals — `closed` removes that surface entirely rather than relying on convention not to use it.

The host element's own inline style is where the real adversarial-CSS defense lives, and it is the one part of this design that is _not_ inside the shadow boundary — the host element itself is a normal light-DOM node, so it is exactly as exposed to the page's stylesheets as anything else on the page. `position: fixed`, full-viewport `inset: 0`, and `pointer-events: none` are what make the overlay behave correctly, and each is set with `!important`. This is not defensive redundancy: CSS's cascade ranks a plain inline declaration in the same "author normal" tier as an ordinary stylesheet rule, so an author stylesheet rule that itself uses `!important` (`* { position: relative !important }`) outranks a plain inline style and wins, silently breaking the overlay's positioning. An inline `!important` declaration moves the comparison into the "author important" tier, where inline style's implicit higher specificity settles it in this SDK's favor regardless of what the host page's stylesheet does. This was found, not assumed: an early version of `shadowRoot.ts` set the inline style without `!important`, and the test written to prove the "aggressive global CSS" exit criterion passed anyway — because `jsdom` does not implement CSS cascade resolution, so a test only checking `host.style.position` proved nothing about a real browser. The test now additionally asserts `host.style.getPropertyPriority('position') === 'important'`, which at least proves the defense mechanism is present in code, since `jsdom`'s lack of a layout/cascade engine means no unit test can fully stand in for a real browser here — the honest gap is that this exit criterion is properly closed only by a real-browser check (Playwright, arriving with the demo-harness build), not by `jsdom` alone.

## Consequences

The host page can throw arbitrary global CSS at itself — resets, `!important` chains, `all: unset` — without the cursor overlay's own layout breaking, and nothing this SDK renders is selectable or inspectable as DOM by host-page script past the closed boundary. The cost is that debugging this SDK from the host page's own devtools is harder than an open root would be (closed shadow roots are still visible in the Elements panel, just not reachable via `element.shadowRoot` from script) — an acceptable trade for a toy explicitly built to demonstrate defensive injection, not to be debugged by the pages it's injected into.
