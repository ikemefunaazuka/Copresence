import { defineConfig, devices } from '@playwright/test';

/**
 * Phase 0 only wires this up and proves it works cold (e2e/smoke.spec.ts).
 * The real two-browser co-browsing suite, and the webServer block that
 * boots apps/server before it, land in Phase 4.
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
