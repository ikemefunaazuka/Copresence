import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';

/**
 * The real two-browser co-browsing suite: two independent `BrowserContext`s
 * (separate cookie/storage jars, exactly like two different people), each
 * driving its own tab of the same session, asserting on effects visible in
 * the host page's own light DOM rather than reaching into the client SDK's
 * closed shadow root — the demo page's participant list (wired to
 * `onPresenceChange`/`onFollowChange`, see views/demoPage.ts) is the
 * observable surface this SDK actually exposes to a host page, and is
 * exactly what a real integrator would build against.
 */

declare global {
  interface Window {
    __copresenceInstance: {
      readonly pid: string;
      status(): string;
      connect(): void;
      disconnect(): void;
      followParticipant(pid: string): void;
      stopFollowing(): void;
    };
  }
}

async function waitForOpen(page: Page): Promise<void> {
  await page.waitForFunction(() => window.__copresenceInstance?.status() === 'open');
}

async function getPid(page: Page): Promise<string> {
  return page.evaluate(() => window.__copresenceInstance.pid);
}

interface Participant {
  readonly context: BrowserContext;
  readonly page: Page;
  readonly pid: string;
}

/** Opens A as the session creator (via /s/new), then B joining the same link — the actual shareable-link flow. */
async function openTwoParticipants(browser: Browser): Promise<{ a: Participant; b: Participant }> {
  const contextA = await browser.newContext();
  const pageA = await contextA.newPage();
  await pageA.goto('/s/new');
  await waitForOpen(pageA);
  const sessionUrl = pageA.url();
  const pidA = await getPid(pageA);

  const contextB = await browser.newContext();
  const pageB = await contextB.newPage();
  await pageB.goto(sessionUrl);
  await waitForOpen(pageB);
  const pidB = await getPid(pageB);

  // Each side's join must have propagated to the other before a test's
  // own actions start — otherwise a cursor move sent before B even knows
  // A exists would have nothing to attach to.
  await pageA.waitForSelector(`#participants li[data-pid="${pidB}"]`);
  await pageB.waitForSelector(`#participants li[data-pid="${pidA}"]`);

  return {
    a: { context: contextA, page: pageA, pid: pidA },
    b: { context: contextB, page: pageB, pid: pidB },
  };
}

async function closeAll(...participants: Participant[]): Promise<void> {
  await Promise.all(participants.map((p) => p.context.close()));
}

test.describe('two-browser co-browsing', () => {
  test('a cursor moved in A appears in B within 250ms', async ({ browser }) => {
    const { a, b } = await openTwoParticipants(browser);

    await a.page.mouse.move(300, 200);
    await a.page.mouse.move(340, 260); // a second, distinct position — the first alone can tie with dead-band suppression on a slow runner

    await expect(async () => {
      const x = await b.page
        .locator(`#participants li[data-pid="${a.pid}"]`)
        .getAttribute('data-x');
      expect(x).not.toBeNull();
    }).toPass({ timeout: 250 });

    await closeAll(a, b);
  });

  test("scroll in A with follow enabled moves B's viewport", async ({ browser }) => {
    const { a, b } = await openTwoParticipants(browser);

    await b.page.locator(`#participants li[data-pid="${a.pid}"]`).click();
    await expect(b.page.locator(`#participants li[data-pid="${a.pid}"]`)).toHaveAttribute(
      'data-following',
      'true',
    );

    await a.page.evaluate(() => window.scrollTo(0, 1200));
    await a.page.waitForFunction(() => window.scrollY >= 1200);

    await expect(async () => {
      const scrollY = await b.page.evaluate(() => window.scrollY);
      expect(scrollY).toBeGreaterThan(800);
    }).toPass({ timeout: 3000 });

    await closeAll(a, b);
  });

  test("B closing removes B's presence from A within the participant TTL", async ({ browser }) => {
    const { a, b } = await openTwoParticipants(browser);
    await expect(a.page.locator(`#participants li[data-pid="${b.pid}"]`)).toBeVisible();

    await b.context.close();

    // PARTICIPANT_TTL_MS is set to 3000 for this whole suite (see
    // playwright.config.ts) — this asserts well within that upper bound,
    // since a closed WebSocket triggers an immediate server-side `leave`
    // broadcast rather than actually waiting out the TTL reaper.
    await expect(a.page.locator(`#participants li[data-pid="${b.pid}"]`)).toHaveCount(0, {
      timeout: 3000,
    });

    await a.context.close();
  });

  test('A reconnecting recovers the current full state, not a stale pre-disconnect snapshot', async ({
    browser,
  }) => {
    // This is often described as "recovers full state from a snapshot" —
    // in the system as actually built, a reconnect's fresh `hello` is
    // answered with `welcome` (which already carries the full roster),
    // not a broadcast `snapshot` message; nothing server-side sends
    // `snapshot` yet. The observable behaviour that actually matters here
    // — a reconnecting client converges to the truth rather than stale
    // pre-disconnect state — is what this test actually proves.
    const { a, b } = await openTwoParticipants(browser);

    await b.page.mouse.move(200, 150);
    await b.page.mouse.move(220, 170);
    await expect(async () => {
      const x = await a.page
        .locator(`#participants li[data-pid="${b.pid}"]`)
        .getAttribute('data-x');
      expect(x).not.toBeNull();
    }).toPass({ timeout: 2000 });
    const beforeX = await a.page
      .locator(`#participants li[data-pid="${b.pid}"]`)
      .getAttribute('data-x');

    await a.page.evaluate(() => window.__copresenceInstance.disconnect());

    // B's presence keeps changing on the server while A is away — proving
    // recovery means proving A comes back with THIS, not what it last saw.
    await b.page.mouse.move(900, 700);
    await b.page.mouse.move(950, 750);
    await b.page.waitForTimeout(150); // let the move reach and be applied server-side

    await a.page.evaluate(() => window.__copresenceInstance.connect());
    await waitForOpen(a.page);

    await expect(async () => {
      const afterX = await a.page
        .locator(`#participants li[data-pid="${b.pid}"]`)
        .getAttribute('data-x');
      expect(afterX).not.toBeNull();
      expect(afterX).not.toBe(beforeX);
    }).toPass({ timeout: 2000 });

    await closeAll(a, b);
  });

  test('a real local scroll in B releases follow within one frame, even while following A', async ({
    browser,
  }) => {
    const { a, b } = await openTwoParticipants(browser);

    await b.page.locator(`#participants li[data-pid="${a.pid}"]`).click();
    await expect(b.page.locator(`#participants li[data-pid="${a.pid}"]`)).toHaveAttribute(
      'data-following',
      'true',
    );

    // A genuine local scroll from B's own user — not the programmatic one
    // following A would itself cause — must break follow immediately.
    await b.page.mouse.wheel(0, 600);

    await expect(b.page.locator(`#participants li[data-pid="${a.pid}"]`)).toHaveAttribute(
      'data-following',
      'false',
      { timeout: 250 },
    );

    // And it stays broken: A scrolling further must not drag B along.
    const scrollYAfterBreak = await b.page.evaluate(() => window.scrollY);
    await a.page.evaluate(() => window.scrollTo(0, 2200));
    await a.page.waitForFunction(() => window.scrollY >= 2200);
    await b.page.waitForTimeout(300); // give a would-be (incorrect) follow-scroll time to happen, if it were going to
    expect(await b.page.evaluate(() => window.scrollY)).toBe(scrollYAfterBreak);

    await closeAll(a, b);
  });
});
