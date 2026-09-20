/**
 * Pure document-space ⇄ viewport-space coordinate conversion — no DOM, no
 * globals, no ambient state. See docs/adr/0005: cursors travel on the wire
 * in document-normalised space so that two browsers at different window
 * sizes, zoom levels and `devicePixelRatio` place a cursor on the same
 * paragraph, not the same pixel offset.
 *
 * This used to live in the server's domain model, on the theory that
 * coordinate math is domain logic. In practice the server never calls
 * either function — it stores and relays `{x, y}` as opaque numbers, and
 * the only real callers are capture (converting a raw mouse event before
 * sending) and render (converting a received position back to screen
 * coordinates). Moved here, to where it is actually consumed, rather
 * than left unused in the server or duplicated.
 *
 * The caller is responsible for reading real DOM values (its own
 * scrollY, its own document width) and passing them in; this module
 * never assumes whose numbers they are, which is exactly what lets the
 * same function convert on the way in and on the way back out.
 */

export interface Viewport {
  readonly width: number;
  readonly height: number;
  readonly dpr: number;
}

/** Wire-space: `x` is 0..1 of document width, `y` is absolute document px. */
export interface DocumentPoint {
  readonly x: number;
  readonly y: number;
}

/** Screen-space: pixels relative to the visible viewport. */
export interface ViewportPoint {
  readonly x: number;
  readonly y: number;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function nonNegativeFinite(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, value);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

/**
 * Subtracting two individually-finite doubles can itself overflow to
 * ±Infinity (e.g. a value near -Number.MAX_VALUE minus a value near
 * +Number.MAX_VALUE) — sanitising the inputs is not enough on its own, the
 * result of the arithmetic needs checking too. Property-tested by
 * coordinates.test.ts, which is what first found this.
 */
function finiteDifferenceOr(a: number, b: number, fallback: number): number {
  const result = finiteOr(a, fallback) - finiteOr(b, fallback);
  return Number.isFinite(result) ? result : fallback;
}

/**
 * Converts a point captured in a local viewport into document-normalised
 * space for transmission. Total for any finite or non-finite input —
 * never throws, degenerate input (e.g. `documentWidth <= 0`) clamps to a
 * safe value rather than dividing by zero or producing NaN.
 */
export function toDocumentSpace(
  viewportPoint: ViewportPoint,
  documentWidth: number,
  scrollY: number,
): DocumentPoint {
  const safeWidth = Number.isFinite(documentWidth) && documentWidth > 0 ? documentWidth : 0;
  const x = safeWidth > 0 ? clamp01(viewportPoint.x / safeWidth) : 0;
  const y = nonNegativeFinite(viewportPoint.y + (Number.isFinite(scrollY) ? scrollY : 0));
  return { x, y };
}

/**
 * The inverse conversion, using the RECEIVING browser's own document width
 * and scroll offset — not the sender's. Two browsers rendering the same
 * layout will agree closely; a genuinely different layout is a documented
 * limitation (README "What this is not"), not something this function can
 * paper over.
 */
export function toViewportSpace(
  documentPoint: DocumentPoint,
  documentWidth: number,
  scrollY: number,
): ViewportPoint {
  const safeWidth = Number.isFinite(documentWidth) && documentWidth > 0 ? documentWidth : 0;
  const x = clamp01(documentPoint.x) * safeWidth;
  // Unlike document space, viewport y may legitimately be negative (a
  // point above the current scroll position) — so degenerate or
  // overflowing input is sanitised to 0 rather than clamped to non-negative.
  const y = finiteDifferenceOr(documentPoint.y, scrollY, 0);
  return { x, y };
}
