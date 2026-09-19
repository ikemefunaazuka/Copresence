import pino from 'pino';
import type { DestinationStream } from 'pino';

import type { Env } from '../config/env.js';

export type Logger = pino.Logger;

/**
 * Structured logging, framework-free beyond pino itself — services and
 * controllers depend on this; it depends on nothing above it (MILESTONE
 * §2.1, the `lib/` row).
 *
 * `destination` is injectable rather than hardcoded to stdout: pino writes
 * through a lower-level file-descriptor stream by default, which is not
 * mockable via `process.stdout.write` spies. Accepting the stream here
 * makes the logger's own output a real, unit-testable property instead of
 * something only an integration test could observe.
 */
export function createLogger(
  level: Env['LOG_LEVEL'],
  destination: DestinationStream = pino.destination(1),
): Logger {
  return pino(
    {
      level,
      base: { service: 'copresence-server' },
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    destination,
  );
}
