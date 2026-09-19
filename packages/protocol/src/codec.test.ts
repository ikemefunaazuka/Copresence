import { describe, expect, it, vi } from 'vitest';

import { decodeInbound, encodeOutbound } from './codec.js';
import { PROTOCOL_VERSION } from './constants.js';
import type { WelcomeMessage } from './messages.js';

const VALID_CURSOR_JSON = JSON.stringify({
  v: PROTOCOL_VERSION,
  t: 'cursor',
  sid: 'sid-1',
  pid: 'pid-1',
  seq: 1,
  ts: 1_700_000_000_000,
  x: 0.5,
  y: 120,
});

describe('decodeInbound', () => {
  it('decodes a well-formed, current-version message', () => {
    const result = decodeInbound(VALID_CURSOR_JSON);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message.t).toBe('cursor');
      expect(result.message.seq).toBe(1);
    }
  });

  it('never throws on malformed JSON — returns a typed error instead', () => {
    expect(() => decodeInbound('{not json')).not.toThrow();
    const result = decodeInbound('{not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('malformed-json');
  });

  it('stringifies a non-Error throw from JSON.parse rather than assuming .message exists', () => {
    // V8's real JSON.parse only ever throws a SyntaxError, so this branch
    // is unreachable through normal input — it exists as defensive code
    // for any other JSON.parse-compatible implementation that might not
    // honour that. Reached here via a mock, which is the only way to.
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/only-throw-error -- deliberately non-Error, see above
      throw 'not an Error instance';
    });
    try {
      const result = decodeInbound('{"t":"cursor"}');
      expect(result.ok).toBe(false);
      if (!result.ok && result.error.kind === 'malformed-json') {
        expect(result.error.detail).toBe('not an Error instance');
      }
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('never throws on any non-message JSON value', () => {
    for (const raw of ['null', '42', '"a string"', '[]', '{}', 'true']) {
      expect(() => decodeInbound(raw)).not.toThrow();
      expect(decodeInbound(raw).ok).toBe(false);
    }
  });

  it('reports validation-failed with the field-level issues for a bad field', () => {
    const badX = JSON.stringify({
      v: PROTOCOL_VERSION,
      t: 'cursor',
      sid: 'sid-1',
      pid: 'pid-1',
      seq: 1,
      ts: 1,
      x: 5, // out of the 0..1 range
      y: 0,
    });
    const result = decodeInbound(badX);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('validation-failed');
      if (result.error.kind === 'validation-failed') {
        expect(result.error.issues.some((issue) => issue.includes('x'))).toBe(true);
      }
    }
  });

  it('reports validation-failed (root-level) for an unrecognised message type', () => {
    const unknownType = JSON.stringify({
      v: PROTOCOL_VERSION,
      t: 'teleport',
      sid: 'sid-1',
      pid: 'pid-1',
      seq: 1,
      ts: 1,
    });
    const result = decodeInbound(unknownType);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.kind).toBe('validation-failed');
  });

  it('reports version-mismatch distinctly from a generic validation failure', () => {
    const wrongVersion = JSON.stringify({
      v: PROTOCOL_VERSION + 1,
      t: 'cursor',
      sid: 'sid-1',
      pid: 'pid-1',
      seq: 1,
      ts: 1,
      x: 0.5,
      y: 0,
    });
    const result = decodeInbound(wrongVersion);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe('version-mismatch');
      if (result.error.kind === 'version-mismatch') {
        expect(result.error.received).toBe(PROTOCOL_VERSION + 1);
        expect(result.error.expected).toBe(PROTOCOL_VERSION);
      }
    }
  });
});

describe('encodeOutbound', () => {
  it('round-trips a server-authored message through JSON', () => {
    const welcome: WelcomeMessage = {
      v: PROTOCOL_VERSION,
      t: 'welcome',
      sid: 'sid-1' as WelcomeMessage['sid'],
      pid: 'pid-1' as WelcomeMessage['pid'],
      seq: 0,
      ts: 1,
      participants: [],
    };
    const encoded = encodeOutbound(welcome);
    expect(JSON.parse(encoded)).toEqual(welcome);
  });
});
