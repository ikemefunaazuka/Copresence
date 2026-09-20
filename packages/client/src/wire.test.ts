import { PROTOCOL_VERSION } from '@copresence/protocol';
import { describe, expect, it } from 'vitest';

import {
  buildBye,
  buildCursor,
  buildHello,
  buildPing,
  buildScroll,
  createWireContext,
} from './wire.js';

describe('createWireContext', () => {
  it('brands the given sid/pid', () => {
    const ctx = createWireContext('s1', 'p1');
    expect(ctx.sid).toBe('s1');
    expect(ctx.pid).toBe('p1');
  });

  it('rejects an empty sid or pid, the same validation the wire schema enforces', () => {
    expect(() => createWireContext('', 'p1')).toThrow();
    expect(() => createWireContext('s1', '')).toThrow();
  });

  it('nextSeq() starts at 1 and increases by exactly 1 each call', () => {
    const ctx = createWireContext('s1', 'p1');
    expect(ctx.nextSeq()).toBe(1);
    expect(ctx.nextSeq()).toBe(2);
    expect(ctx.nextSeq()).toBe(3);
  });

  it('every builder draws from the same shared seq counter, never resetting between message types', () => {
    const ctx = createWireContext('s1', 'p1');
    const viewport = { docWidth: 1000, docHeight: 2000, dpr: 1 };
    const hello = buildHello(ctx, viewport, 'visible');
    const cursor = buildCursor(ctx, 0.5, 100);
    const scroll = buildScroll(ctx, 0, 50);

    expect([hello.seq, cursor.seq, scroll.seq]).toEqual([1, 2, 3]);
  });
});

describe('message builders', () => {
  const ctx = createWireContext('s1', 'p1');

  it('buildHello carries the viewport metadata and visibility state given', () => {
    const message = buildHello(ctx, { docWidth: 800, docHeight: 1600, dpr: 2 }, 'hidden');
    expect(message).toMatchObject({
      v: PROTOCOL_VERSION,
      t: 'hello',
      sid: 's1',
      pid: 'p1',
      docWidth: 800,
      docHeight: 1600,
      dpr: 2,
      visibilityState: 'hidden',
    });
  });

  it('buildCursor carries x/y', () => {
    const message = buildCursor(ctx, 0.25, 400);
    expect(message).toMatchObject({ t: 'cursor', x: 0.25, y: 400 });
  });

  it('buildScroll carries scrollX/scrollY', () => {
    const message = buildScroll(ctx, 10, 900);
    expect(message).toMatchObject({ t: 'scroll', scrollX: 10, scrollY: 900 });
  });

  it('buildPing and buildBye carry only the envelope', () => {
    expect(buildPing(ctx).t).toBe('ping');
    expect(buildBye(ctx).t).toBe('bye');
  });
});
