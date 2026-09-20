// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { readScrollOffset, readViewportMetadata } from './viewport.js';

describe('readViewportMetadata', () => {
  it('reads scrollWidth/scrollHeight from the document element and dpr from the window', () => {
    const fakeDoc = {
      documentElement: { scrollWidth: 1024, scrollHeight: 4000 },
    } as unknown as Document;
    const fakeWin = { devicePixelRatio: 2 } as unknown as Window;

    expect(readViewportMetadata(fakeDoc, fakeWin)).toEqual({
      docWidth: 1024,
      docHeight: 4000,
      dpr: 2,
    });
  });

  it('falls back to dpr=1 when devicePixelRatio is 0 or missing', () => {
    const fakeDoc = {
      documentElement: { scrollWidth: 100, scrollHeight: 200 },
    } as unknown as Document;
    const fakeWin = { devicePixelRatio: 0 } as unknown as Window;

    expect(readViewportMetadata(fakeDoc, fakeWin).dpr).toBe(1);
  });

  it('reads the real jsdom document by default', () => {
    const metadata = readViewportMetadata();
    expect(typeof metadata.docWidth).toBe('number');
    expect(typeof metadata.docHeight).toBe('number');
    expect(metadata.dpr).toBeGreaterThan(0);
  });
});

describe('readScrollOffset', () => {
  it('reads scrollX/scrollY from the given window', () => {
    const fakeWin = { scrollX: 10, scrollY: 20 } as unknown as Window;
    expect(readScrollOffset(fakeWin)).toEqual({ x: 10, y: 20 });
  });

  it('reads the real jsdom window by default', () => {
    expect(readScrollOffset()).toEqual({
      x: expect.any(Number) as number,
      y: expect.any(Number) as number,
    });
  });
});
