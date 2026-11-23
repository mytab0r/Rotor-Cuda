import { expect, openRoute, test } from './fixtures';
import { ROUTES } from './routes.data';

/* The custom CDP audit measured geometry but could not see a page. These
 * baselines do: every route at the top of the document, plus the first data
 * table for the six routes that render one. The footer build id changes on
 * every commit and is masked so a deploy id cannot redden a visual diff. */

async function scrollTableIntoView(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('.table-scroll').first().evaluate((element) => {
    const top = element.getBoundingClientRect().top + window.scrollY;
    window.scrollTo(0, Math.max(0, top - 96));
  });
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
      }),
  );
}

test.describe('visual regression', () => {
  for (const route of ROUTES) {
    test(`${route.path} matches its baseline`, async ({ page }) => {
      await openRoute(page, route.path);
      const mask = [page.locator('.site-footer__meta')];

      await expect(page).toHaveScreenshot(`${route.name}.png`, {
        animations: 'disabled',
        caret: 'hide',
        mask,
        maskColor: '#ff00ff',
      });

      if (route.rows > 0) {
        await scrollTableIntoView(page);
        await expect(page).toHaveScreenshot(`${route.name}-table.png`, {
          animations: 'disabled',
          caret: 'hide',
          mask,
          maskColor: '#ff00ff',
        });
      }
    });
  }
});
