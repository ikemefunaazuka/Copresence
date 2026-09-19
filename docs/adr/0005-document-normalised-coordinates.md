# 0005 — Document-normalised coordinates instead of viewport pixels

## Status

Accepted

## Context

The obvious way to transmit a cursor position is the browser's own coordinates: `event.clientX`, `event.clientY`, pixels relative to the visible viewport. It is also wrong the moment two participants have different window sizes, different zoom levels, or a different `devicePixelRatio` — which is the common case, not the exception. Two browsers at different widths showing the same document must place a cursor on the same paragraph, not at the same pixel offset from the top-left corner of two differently-sized windows. This is, by a wide margin, the most commonly missed bug in a naive version of this kind of demo, and it is missed precisely because it does not show up in local testing with two windows the same size.

## Decision

Cursor positions travel on the wire in document-normalised space: `x` as `0..1` of document width, `y` as an absolute document-space pixel value (viewport y plus scroll offset). `apps/server/src/models/coordinates.ts` owns the pure conversion in both directions — `toDocumentSpace` on the way in, `toViewportSpace` on the way out — and neither function assumes whose numbers it is holding: the caller is responsible for supplying its own real DOM values (its own document width, its own scroll offset), which is what makes the same pair of functions correct for both the sending and the receiving side.

## Consequences

Correctness stops depending on window geometry. A cursor sent from a 2000px-wide window renders in roughly the right place in a 400px-wide one, because both ends independently normalise against their own document width rather than trusting a raw pixel value from a window they never saw.

The honest limit: this assumes both browsers are rendering substantially the same layout. Under genuine responsive reflow — a different number of columns, reordered content, a fundamentally different breakpoint — "the same paragraph" stops being a meaningful target, and this normalisation cannot invent a correspondence that was never there. That limitation is named in the README ("What this is not") rather than implied away.

A second, unplanned consequence surfaced only once the property tests ran: converting between the two spaces involves arithmetic (addition, subtraction) on values that can individually be finite but pathologically large, and IEEE 754 doubles overflow on that arithmetic before they overflow on the inputs themselves. Both conversion functions guard the _result_ of their arithmetic, not just the inputs — a distinction that mattered enough to be a real bug, caught by `coordinates.test.ts`'s totality property tests, not a hypothetical one.
