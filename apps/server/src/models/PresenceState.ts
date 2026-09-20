export interface ScrollPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * Document-normalised cursor position — see docs/adr/0005. The conversion
 * to and from real screen coordinates is a client-side concern
 * (packages/client/src/capture/coordinates.ts); this model only stores
 * the already-normalised shape, so it declares that shape itself rather
 * than importing from the client package (server never depends on
 * client).
 */
export interface CursorPosition {
  readonly x: number;
  readonly y: number;
}

/**
 * One participant's last-known presence, with per-field last-writer-wins
 * ordering by SERVER-assigned sequence — never by client `ts` (docs/adr/0004:
 * clocks are skewed, adjustable mid-session, and trivially forgeable).
 *
 * Deliberately knows nothing about transport, ticking or broadcast — it is
 * the pure reduction target for `applyEvent`, nothing else.
 */
export interface PresenceState {
  readonly cursor?: CursorPosition;
  readonly cursorSeq?: number;
  readonly scroll?: ScrollPosition;
  readonly scrollSeq?: number;
}

export const EMPTY_PRESENCE: PresenceState = {};

/**
 * Applies a cursor observation at server-assigned `seq`. Last-writer-wins:
 * a seq no newer than what is already recorded for this field is a true
 * no-op — returns the exact same object reference, which is what lets
 * callers detect "nothing changed" with `===` instead of a deep-equal
 * check (see `applyEvent`'s tick-skipping).
 */
export function withCursor(state: PresenceState, point: CursorPosition, seq: number): PresenceState {
  if (state.cursorSeq !== undefined && seq <= state.cursorSeq) return state;
  return { ...state, cursor: point, cursorSeq: seq };
}

/** Same last-writer-wins contract as {@link withCursor}, for scroll position. */
export function withScroll(
  state: PresenceState,
  scroll: ScrollPosition,
  seq: number,
): PresenceState {
  if (state.scrollSeq !== undefined && seq <= state.scrollSeq) return state;
  return { ...state, scroll, scrollSeq: seq };
}
