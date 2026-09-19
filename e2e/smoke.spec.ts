import { expect, test } from '@playwright/test';

/**
 * Phase 0 smoke test only — proves Playwright is installed and configured
 * correctly on a cold machine. The real two-browser co-browsing suite lands
 * in Phase 4 (e2e/copresence.spec.ts) once there is a server to test against.
 */
test('renders a static page and reads its content', async ({ page }) => {
  await page.setContent('<h1>Copresence</h1>');
  await expect(page.getByRole('heading', { name: 'Copresence' })).toBeVisible();
});
