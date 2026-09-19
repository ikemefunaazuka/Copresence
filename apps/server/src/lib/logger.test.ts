import { Writable } from 'node:stream';

import { describe, expect, it } from 'vitest';

import { createLogger } from './logger.js';

/** An in-memory sink so log output is a plain, synchronous assertion. */
function captureStream(): { stream: Writable; lines: () => string[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString('utf8'));
      callback();
    },
  });
  return { stream, lines: () => chunks };
}

describe('createLogger', () => {
  it('creates a logger at the requested level', () => {
    const { stream } = captureStream();
    const logger = createLogger('debug', stream);

    expect(logger.level).toBe('debug');
  });

  it('tags every line with the service name', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger('info', stream);

    logger.info({ nodeEnv: 'test' }, 'boot');

    expect(lines()).toHaveLength(1);
    const record = JSON.parse(lines()[0]!) as Record<string, unknown>;
    expect(record['service']).toBe('copresence-server');
    expect(record['msg']).toBe('boot');
    expect(record['nodeEnv']).toBe('test');
  });

  it('suppresses lines below the configured level', () => {
    const { stream, lines } = captureStream();
    const logger = createLogger('warn', stream);

    logger.info('should not appear');
    logger.warn('should appear');

    expect(lines()).toHaveLength(1);
    const record = JSON.parse(lines()[0]!) as Record<string, unknown>;
    expect(record['msg']).toBe('should appear');
  });
});
