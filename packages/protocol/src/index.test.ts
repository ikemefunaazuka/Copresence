import { describe, expect, it } from 'vitest';

import { PROTOCOL_VERSION } from './index.js';

describe('protocol package boundary', () => {
  it('exposes a stable, numeric protocol version', () => {
    expect(PROTOCOL_VERSION).toBe(1);
    expect(Number.isInteger(PROTOCOL_VERSION)).toBe(true);
  });
});
