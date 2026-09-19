import { describe, expect, it } from 'vitest';

import { EnvValidationError, loadEnv } from './env.js';

describe('loadEnv', () => {
  it('applies documented defaults when nothing is set', () => {
    const env = loadEnv({});

    expect(env.NODE_ENV).toBe('development');
    expect(env.PORT).toBe(3000);
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.CORS_ORIGIN).toBe('*');
    expect(env.PARTICIPANT_TTL_MS).toBe(15_000);
    expect(env.TICK_RATE_HZ).toBe(20);
    expect(env.MONGODB_URI).toBeUndefined();
  });

  it('coerces numeric strings from process.env', () => {
    const env = loadEnv({ PORT: '4000', TICK_RATE_HZ: '30' });

    expect(env.PORT).toBe(4000);
    expect(env.TICK_RATE_HZ).toBe(30);
  });

  it('rejects an out-of-range port instead of starting with a bad value', () => {
    expect(() => loadEnv({ PORT: '99999' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown NODE_ENV value', () => {
    expect(() => loadEnv({ NODE_ENV: 'staging' })).toThrow(EnvValidationError);
  });

  it('rejects an unknown LOG_LEVEL value', () => {
    expect(() => loadEnv({ LOG_LEVEL: 'verbose' })).toThrow(EnvValidationError);
  });

  it('rejects a malformed MONGODB_URI when one is provided', () => {
    expect(() => loadEnv({ MONGODB_URI: 'not-a-url' })).toThrow(EnvValidationError);
  });

  it('accepts a well-formed MONGODB_URI', () => {
    const env = loadEnv({ MONGODB_URI: 'mongodb://localhost:27017/copresence' });

    expect(env.MONGODB_URI).toBe('mongodb://localhost:27017/copresence');
  });

  it('lists every problem at once rather than stopping at the first', () => {
    try {
      loadEnv({ NODE_ENV: 'staging', PORT: '-1', TICK_RATE_HZ: '0' });
      expect.unreachable('loadEnv should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(EnvValidationError);
      const message = (error as EnvValidationError).message;
      expect(message).toContain('NODE_ENV');
      expect(message).toContain('PORT');
      expect(message).toContain('TICK_RATE_HZ');
    }
  });
});
