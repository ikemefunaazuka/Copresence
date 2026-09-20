// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';

import { createRafScheduler } from './rafScheduler.js';
import { createScrollCapture } from './scrollCapture.js';

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

describe('createScrollCapture', () => {
  it('reports the window scroll offset once a frame fires after a scroll event', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const fakeWin = { scrollX: 0, scrollY: 400 } as unknown as Window;
    const capture = createScrollCapture({
      onCapture,
      target,
      win: fakeWin,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(new Event('scroll'));
    frames.fire();

    expect(onCapture).toHaveBeenCalledTimes(1);
    expect(onCapture).toHaveBeenCalledWith({ x: 0, y: 400 });
  });

  it('coalesces several scroll events within one frame into a single report', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const fakeWin = { scrollX: 0, scrollY: 0 } as unknown as Window;
    const capture = createScrollCapture({
      onCapture,
      target,
      win: fakeWin,
      rafScheduler: scheduler,
    });

    capture.start();
    target.dispatchEvent(new Event('scroll'));
    target.dispatchEvent(new Event('scroll'));
    target.dispatchEvent(new Event('scroll'));
    frames.fire();

    expect(onCapture).toHaveBeenCalledTimes(1);
  });

  it('stop() removes the listener and cancels any pending frame', () => {
    const frames = fakeFrameSource();
    const scheduler = createRafScheduler(frames.requestFrame, frames.cancelFrame);
    const onCapture = vi.fn();
    const target = new EventTarget();
    const capture = createScrollCapture({ onCapture, target, rafScheduler: scheduler });

    capture.start();
    target.dispatchEvent(new Event('scroll'));
    capture.stop();
    frames.fire();

    expect(onCapture).not.toHaveBeenCalled();
  });
});
