import { expect, test } from '@playwright/test';

/**
 * The inspector's audit trail view (Phase 6's demo moment), against the
 * real server and the real built Vue app — not a mock of either. Seeds
 * audit events the same way a real client would: `POST /audit/beacon`
 * with `text/plain`, sent twice with the identical `eventId` to model the
 * canonical bfcache-duplicate case the milestone explicitly wants shown,
 * not hidden.
 */
test('inspector shows a session.end reported twice by the client, with the duplicate called out', async ({
  page,
}) => {
  const created = (await (await page.request.post('/api/sessions')).json()) as { sid: string };
  const sid = created.sid;

  const auditMessage = {
    v: 1,
    t: 'session.end',
    sid,
    pid: 'inspector-e2e-participant',
    seq: 1,
    ts: Date.now(),
    eventId: 'e2e-duplicate-event',
    reason: 'navigate',
  };
  const beaconOptions = {
    headers: { 'Content-Type': 'text/plain' },
    data: JSON.stringify(auditMessage),
  };
  const first = await page.request.post('/audit/beacon', beaconOptions);
  expect(first.ok()).toBe(true);
  // The page came back from bfcache and fired the same still-unconfirmed beacon again.
  const second = await page.request.post('/audit/beacon', beaconOptions);
  expect(second.ok()).toBe(true);

  await page.goto(`/inspector/?sid=${encodeURIComponent(sid)}`);

  const row = page.locator('tr', { has: page.getByText('session.end') });
  await expect(row).toBeVisible({ timeout: 2000 });
  const cells = row.locator('td');
  await expect(cells.nth(2)).toHaveText('inspector-e2e-participant'); // Participant
  await expect(cells.nth(3).locator('.source-badge.source-client')).toBeVisible(); // First reported by
  const allPaths = cells.nth(4); // All paths
  await expect(allPaths.locator('.source-badge.source-client')).toBeVisible();
  await expect(allPaths.getByText(/2 reports total/)).toBeVisible();
});
