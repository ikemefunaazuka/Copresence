import { describe, expect, it } from 'vitest';

import { VERSION } from './index.js';

describe('client package boundary', () => {
  it('exposes a semver version marker', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
