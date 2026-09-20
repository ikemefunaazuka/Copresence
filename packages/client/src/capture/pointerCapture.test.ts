// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { createPointerCapture } from './pointerCapture.js';
import { createRafScheduler } from './rafScheduler.js';

function fakeFrameSource(): {
  requestFrame: (cb: FrameRequestCallback) => number;
  cancelFrame: (h: number) => void;
  fire: () => void;
} {
  let nextHandle = 1;
  const pending = new Map<number, FrameRequestCallback>();
  return {
    requestFrame: (cb) => {
      const handle = nextHandle;
      nextHandle += 1;
      pending.set(handle, cb);
      return handle;
    },
    cancelFrame: (handle) => pending.delete(handle),
    fire: () => {
      const callbacks = Array.from(pending.values());
      pending.clear();
      for (const cb of callbacks) cb(0);
    },
  };
}

describe('createPointerCapture', () => {
  it('emits the first observation in document space, dead-band-exempt', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const capture = createPointerCapture({
      documentWidth: () => 1000,
      scrollY: () => 0,
      onCapture,
      target,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 500, clientY: 100 }));
    frames.fire();

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith({ x: 0.5, y: 100 });
  });

  it('coalesces several moves within one frame into just the latest', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const capture = createPointerCapture({
      documentWidth: () => 1000,
      scrollY: () => 0,
      onCapture,
      target,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 100, clientY: 0 }));
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 200, clientY: 0 }));
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 300, clientY: 0 }));
    frames.fire();

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith({ x: 0.3, y: 0 });
  });

  it('suppresses a move under the dead-band threshold', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const capture = createPointerCapture({
      documentWidth: () => 1000,
      scrollY: () => 0,
      onCapture,
      target,
      rafScheduler: scheduler,
      deadBandPx: 5,
    });

    capture.start();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 100, clientY: 100 }));
    frames.fire();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 101, clientY: 100 })); // 1px, under threshold
    frames.fire();

    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('stop() removes the listener and cancels any pending frame', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const capture = createPointerCapture({
      documentWidth: () => 1000,
      scrollY: () => 0,
      onCapture,
      target,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 100, clientY: 100 }));
    capture.stop();
    frames.fire();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 200, clientY: 200 }));
    frames.fire();

    expect(onCapture).not.toHaveBeenCalled();
  });

  it('reads document width and scrollY fresh on every flush, not once at construction', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    let width = 1000;
    const capture = createPointerCapture({
      documentWidth: () => width,
      scrollY: () => 0,
      onCapture,
      target,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 500, clientY: 0 }));
    frames.fire();
    width = 2000; // window resized between the two moves
    // A genuinely different viewport position for the second move — a
    // dead-band-suppressed repeat of the same position would never reach
    // the width lookup at all, which is not what this test is checking.
    target.dispatchEvent(Object.assign(new Event('mousemove'), { clientX: 1000, clientY: 0 }));
    frames.fire();

    expect(onCapture).toHaveBeenNthCalledWith(1, { x: 0.5, y: 0 });
    expect(onCapture).toHaveBeenNthCalledWith(2, { x: 0.5, y: 0 }); // 1000/2000, not 1000/1000 — proves the width was re-read
  });
});
