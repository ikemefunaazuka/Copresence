import { describe, expect, it } from 'vitest';

import { createCorsMiddleware } from './cors.js';

describe('createCorsMiddleware', () => {
  it('returns a middleware function for the wildcard origin', () => {
    expect(typeof createCorsMiddleware('*')).toBe('function');
  });

  it('returns a middleware function for an explicit origin', () => {
    expect(typeof createCorsMiddleware('https://example.com')).toBe('function');
  });
});
