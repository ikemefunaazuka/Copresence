import { defineConfig, devices } from '@playwright/test';

/**
 * Only wired up and proven to work cold so far (e2e/smoke.spec.ts). The
 * real two-browser co-browsing suite, and the webServer block that boots
 * apps/server before it, land once the client SDK and demo page exist.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }]] : 'list',
  use: {
    trace: 'on-first-retry',
    video: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
