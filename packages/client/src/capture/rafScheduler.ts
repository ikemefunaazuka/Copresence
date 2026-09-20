/**
 * Coalesces however many calls happen within one frame into a single
 * "latest wins" invocation fired once per `requestAnimationFrame` — the
 * same reasoning as the server's own tick coalescing, one layer down:
 * `mousemove` can fire far faster than any consumer needs to react to it,
 * and there is never a reason to process more than the newest value.
 *
 * `requestFrame`/`cancelFrame` are injectable so tests can drive frames
 * deterministically instead of racing the real browser's frame timing.
 */
export interface RafScheduler {
  /** Replaces whatever callback was already pending for the next frame. */
  schedule(callback: () => void): void;
  cancel(): void;
}

export function createRafScheduler(
  requestFrame: (cb: FrameRequestCallback) => number = (cb) => requestAnimationFrame(cb),
  cancelFrame: (handle: number) => void = (handle) => cancelAnimationFrame(handle),
): RafScheduler {
  let handle: number | undefined;
  let pending: (() => void) | undefined;

  function schedule(callback: () => void): void {
    pending = callback;
    if (handle !== undefined) return; // a frame is already scheduled; this call's callback just replaces the pending one
    handle = requestFrame(() => {
      handle = undefined;
      const callbackToRun = pending;
      pending = undefined;
      callbackToRun?.();
    });
  }

  function cancel(): void {
    if (handle !== undefined) cancelFrame(handle);
    handle = undefined;
    pending = undefined;
  }

  return { schedule, cancel };
}
