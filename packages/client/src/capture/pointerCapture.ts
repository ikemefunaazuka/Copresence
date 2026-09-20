import type { DocumentPoint, ViewportPoint } from './coordinates.js';
import { toDocumentSpace } from './coordinates.js';
import { exceedsDeadBand } from './deadBand.js';
import { createRafScheduler } from './rafScheduler.js';
import type { RafScheduler } from './rafScheduler.js';

export interface PointerCaptureOptions {
  /** Current document width and scroll offset — read fresh on every flush, not cached at construction. */
  readonly documentWidth: () => number;
  readonly scrollY: () => number;
  readonly onCapture: (point: DocumentPoint) => void;
  readonly target?: EventTarget;
  readonly rafScheduler?: RafScheduler;
  readonly deadBandPx?: number;
}

export interface PointerCapture {
  start(): void;
  stop(): void;
}

/**
 * `mousemove` fires up to ~240 Hz on a high-polling mouse. `requestAnimationFrame`
 * bounds this to the display refresh rate and — the part that matters
 * most — to zero the moment the tab is backgrounded, since rAF simply
 * stops firing then. Passive and capture-phase: this must never block
 * the host page's own scrolling, and it must not depend on the host page
 * failing to call `stopPropagation()` on the bubble phase.
 */
export function createPointerCapture(options: PointerCaptureOptions): PointerCapture {
  const target = options.target ?? window;
  const scheduler = options.rafScheduler ?? createRafScheduler();
  let lastEmitted: ViewportPoint | undefined;
  let latest: ViewportPoint | undefined;

  function flush(): void {
    if (!latest) return;
    const point = latest;
    if (!exceedsDeadBand(lastEmitted, point, options.deadBandPx)) return;
    lastEmitted = point;
    options.onCapture(toDocumentSpace(point, options.documentWidth(), options.scrollY()));
  }

  function handleMove(event: Event): void {
    const mouseEvent = event as MouseEvent;
    latest = { x: mouseEvent.clientX, y: mouseEvent.clientY };
    scheduler.schedule(flush);
  }

  function start(): void {
    target.addEventListener('mousemove', handleMove, { passive: true, capture: true });
  }

  function stop(): void {
    target.removeEventListener('mousemove', handleMove, { capture: true });
    scheduler.cancel();
    latest = undefined;
  }

  return { start, stop };
}
