import { defineConfig, devices } from '@playwright/test';

const PORT = 4100;
const BASE_URL = `http://127.0.0.1:${PORT}`;

/**
 * The real two-browser co-browsing suite lives in e2e/copresence.spec.ts,
 * against the actual server (built protocol + client already required by
 * `test:e2e`'s own script) on a fixed port distinct from the dev default,
 * so this never collides with a `npm run dev`/`npm run demo` left running
 * locally. A short `PARTICIPANT_TTL_MS` keeps the reaper-driven parts of
 * the suite fast without changing anything about the mechanism under test.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: BASE_URL,
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  webServer: {
    command: 'npx tsx apps/server/src/index.ts',
    url: `${BASE_URL}/healthz`,
    reuseExistingServer: !process.env.CI,
    env: {
      PORT: String(PORT),
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      PARTICIPANT_TTL_MS: '3000',
    },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
