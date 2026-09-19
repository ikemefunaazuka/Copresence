import { describe, expect, it } from 'vitest';

import {
  CursorMessageSchema,
  EventIdSchema,
  HelloMessageSchema,
  InboundMessageSchema,
  ParticipantIdSchema,
  SessionIdSchema,
} from './schemas.js';

const BASE = { v: 1, sid: 'sid-1', pid: 'pid-1', seq: 1, ts: 1_700_000_000_000 };

describe('branded identifiers', () => {
  it('accepts a non-empty string', () => {
    expect(SessionIdSchema.safeParse('sid-1').success).toBe(true);
    expect(ParticipantIdSchema.safeParse('pid-1').success).toBe(true);
    expect(EventIdSchema.safeParse('evt-1').success).toBe(true);
  });

  it('rejects an empty string', () => {
    expect(SessionIdSchema.safeParse('').success).toBe(false);
  });

  it('rejects a non-string', () => {
    expect(SessionIdSchema.safeParse(42).success).toBe(false);
    expect(SessionIdSchema.safeParse(null).success).toBe(false);
    expect(SessionIdSchema.safeParse(undefined).success).toBe(false);
  });
});

describe('CursorMessageSchema', () => {
  it('accepts a valid cursor message at the boundary of x', () => {
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'cursor', x: 0, y: 0 }).success).toBe(true);
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'cursor', x: 1, y: 500 }).success).toBe(
      true,
    );
  });

  it('rejects x outside the normalised 0..1 range', () => {
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'cursor', x: -0.01, y: 0 }).success).toBe(
      false,
    );
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'cursor', x: 1.01, y: 0 }).success).toBe(
      false,
    );
  });

  it('rejects a negative document y', () => {
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'cursor', x: 0.5, y: -1 }).success).toBe(
      false,
    );
  });

  it('rejects a mistyped discriminant', () => {
    expect(CursorMessageSchema.safeParse({ ...BASE, t: 'scroll', x: 0.5, y: 0 }).success).toBe(
      false,
    );
  });
});

describe('HelloMessageSchema', () => {
  it('accepts a valid hello', () => {
    const result = HelloMessageSchema.safeParse({
      ...BASE,
      t: 'hello',
      docWidth: 1024,
      docHeight: 4000,
      dpr: 2,
      visibilityState: 'visible',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-positive document width', () => {
    const result = HelloMessageSchema.safeParse({
      ...BASE,
      t: 'hello',
      docWidth: 0,
      docHeight: 4000,
      dpr: 1,
      visibilityState: 'visible',
    });
    expect(result.success).toBe(false);
  });

  it('rejects an unknown visibilityState value', () => {
    const result = HelloMessageSchema.safeParse({
      ...BASE,
      t: 'hello',
      docWidth: 1024,
      docHeight: 4000,
      dpr: 1,
      visibilityState: 'backgrounded',
    });
    expect(result.success).toBe(false);
  });
});

describe('InboundMessageSchema (the discriminated union)', () => {
  it('routes to the right member for every known type', () => {
    const cursor = InboundMessageSchema.safeParse({ ...BASE, t: 'cursor', x: 0.5, y: 100 });
    expect(cursor.success).toBe(true);

    const ping = InboundMessageSchema.safeParse({ ...BASE, t: 'ping' });
    expect(ping.success).toBe(true);

    const sessionStart = InboundMessageSchema.safeParse({
      ...BASE,
      t: 'session.start',
      eventId: 'evt-1',
    });
    expect(sessionStart.success).toBe(true);
  });

  it('rejects an unknown discriminant rather than throwing', () => {
    const result = InboundMessageSchema.safeParse({ ...BASE, t: 'teleport', x: 1 });
    expect(result.success).toBe(false);
  });

  it('rejects a non-object payload rather than throwing', () => {
    expect(InboundMessageSchema.safeParse(null).success).toBe(false);
    expect(InboundMessageSchema.safeParse('cursor').success).toBe(false);
    expect(InboundMessageSchema.safeParse(42).success).toBe(false);
    expect(InboundMessageSchema.safeParse(undefined).success).toBe(false);
  });

  it('audit messages require eventId, presence messages do not', () => {
    const missingEventId = InboundMessageSchema.safeParse({ ...BASE, t: 'session.start' });
    expect(missingEventId.success).toBe(false);

    const cursorNeedsNoEventId = InboundMessageSchema.safeParse({
      ...BASE,
      t: 'cursor',
      x: 0.1,
      y: 1,
    });
    expect(cursorNeedsNoEventId.success).toBe(true);
  });
});
