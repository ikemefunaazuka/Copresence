import { EnvValidationError, loadEnv } from './config/env.js';
import { createLogger } from './lib/logger.js';

/**
 * Composition root. Phase 0's job for this file is narrow and specific:
 * prove that bad configuration fails the boot loudly and with a non-zero
 * exit, rather than starting the server with wrong behaviour silently.
 *
 * Express, `ws`, routes, controllers and everything else that makes this an
 * actual server lands in Phase 2 — see MILESTONE.
 */
function main(): void {
  let env;

  try {
    env = loadEnv();
  } catch (error) {
    // console is used deliberately here: no logger can exist until config
    // is known to be valid, since the logger's own level comes from it.
    if (error instanceof EnvValidationError) {
      console.error(error.message);
    } else {
      console.error('Unexpected error while loading configuration:', error);
    }
    process.exitCode = 1;
    return;
  }

  const logger = createLogger(env.LOG_LEVEL);
  logger.info(
    { nodeEnv: env.NODE_ENV, port: env.PORT, tickRateHz: env.TICK_RATE_HZ },
    'configuration loaded',
  );
  logger.info('server scaffold ready — HTTP, WebSocket transport and MVC wiring land in Phase 2');
}

main();
