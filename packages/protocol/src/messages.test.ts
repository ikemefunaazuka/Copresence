import { describe, expect, it } from 'vitest';

import { MESSAGE_CLASS, classify, isAuditMessage } from './messages.js';
import type { InboundMessage } from './messages.js';

const ALL_MESSAGE_TYPES = Object.keys(MESSAGE_CLASS) as (keyof typeof MESSAGE_CLASS)[];

describe('MESSAGE_CLASS', () => {
  it('classifies every message type named in MILESTONE Phase 1', () => {
    expect(MESSAGE_CLASS.cursor).toBe('lossy');
    expect(MESSAGE_CLASS.scroll).toBe('lossy');

    expect(MESSAGE_CLASS.hello).toBe('lossless');
    expect(MESSAGE_CLASS.join).toBe('lossless');
    expect(MESSAGE_CLASS.leave).toBe('lossless');
    expect(MESSAGE_CLASS.welcome).toBe('lossless');
    expect(MESSAGE_CLASS.snapshot).toBe('lossless');

    expect(MESSAGE_CLASS.ping).toBe('control');
    expect(MESSAGE_CLASS.pong).toBe('control');
    expect(MESSAGE_CLASS.ack).toBe('control');
    expect(MESSAGE_CLASS.error).toBe('control');

    expect(MESSAGE_CLASS['session.start']).toBe('audit');
    expect(MESSAGE_CLASS['session.end']).toBe('audit');
    expect(MESSAGE_CLASS['participant.join']).toBe('audit');
    expect(MESSAGE_CLASS['participant.leave']).toBe('audit');
    expect(MESSAGE_CLASS['visibility.change']).toBe('audit');
  });

  it('gives every entry exactly one of the four classes', () => {
    const validClasses = new Set(['lossy', 'lossless', 'control', 'audit']);
    for (const type of ALL_MESSAGE_TYPES) {
      expect(validClasses.has(MESSAGE_CLASS[type])).toBe(true);
    }
  });

  it('classify() agrees with the MESSAGE_CLASS table for every type', () => {
    for (const type of ALL_MESSAGE_TYPES) {
      expect(classify(type)).toBe(MESSAGE_CLASS[type]);
    }
  });
});

describe('isAuditMessage', () => {
  const base = { v: 1, sid: 's', pid: 'p', seq: 1, ts: 1 } as const;

  it('is true for every audit event kind', () => {
    const auditTypes: InboundMessage['t'][] = [
      'session.start',
      'session.end',
      'participant.join',
      'participant.leave',
      'visibility.change',
    ];
    for (const t of auditTypes) {
      expect(isAuditMessage({ ...base, t, eventId: 'e' } as unknown as InboundMessage)).toBe(true);
    }
  });

  it('is false for a presence message', () => {
    const cursor = { ...base, t: 'cursor', x: 0.5, y: 0 } as unknown as InboundMessage;
    expect(isAuditMessage(cursor)).toBe(false);
  });

  it('is false for a control message', () => {
    const ping = { ...base, t: 'ping' } as unknown as InboundMessage;
    expect(isAuditMessage(ping)).toBe(false);
  });
});
