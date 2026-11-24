import { test as base, expect, type Page } from '@playwright/test';
import { schemeOf } from './routes.data';

/* One guard for every test: the page may reach only the local dist server.
 * Any other host is aborted and recorded, and the fixture fails the test in
 * teardown, so a page that starts phoning home cannot pass silently. The DNT
 * override also stops the first-party analytics beacon before it tries. */
export const test = base.extend<{ externalRequests: string[] }>({
  externalRequests: [
    async ({ context }, use) => {
      const externalRequests: string[] = [];
      await context.addInitScript(() => {
        Object.defineProperty(Navigator.prototype, 'doNotTrack', {
          configurable: true,
          get: () => '1',
        });
        Object.defineProperty(window, 'doNotTrack', {
          configurable: true,
          value: '1',
        });
      });
      await context.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
        externalRequests.push(url.href);
        return route.abort();
      });
      await use(externalRequests);
      expect(
        externalRequests,
        `the built site must not reach the network; blocked: ${externalRequests.join(', ')}`,
      ).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };

/** Load a route and wait for webfonts and two frames so layout is final. */
export async function openRoute(page: Page, routePath: string): Promise<void> {
  await page.goto(routePath, { waitUntil: 'load' });
  await expect(page.locator('html')).toHaveClass(/\bjs\b/);
  await page.evaluate(async () => {
    await document.fonts.ready;
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

/** The colour scheme the browser reported is the one the shell applied. */
export async function expectTheme(page: Page, projectName: string): Promise<void> {
  await expect(page.locator('html')).toHaveAttribute('data-theme', schemeOf(projectName));
}
