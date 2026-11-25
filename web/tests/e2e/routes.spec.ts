import { expect, expectTheme, openRoute, test } from './fixtures';
import { ROUTES } from './routes.data';

/* Structural contract for every page the static build owns: one title, one
 * visible H1, the expected data rows, no document-level horizontal overflow
 * and the requested colour scheme actually applied. */

test.describe('static routes', () => {
  for (const route of ROUTES) {
    test(`${route.path} renders its contract`, async ({ page }, testInfo) => {
      await openRoute(page, route.path);
      await expectTheme(page, testInfo.project.name);

      await expect(page).toHaveTitle(route.title);

      const headings = page.locator('h1');
      await expect(headings).toHaveCount(1);
      await expect(headings).toHaveText(route.h1);

      if (route.path === '/docs/') {
        await expect(page.locator('.docs-toc a')).toHaveCount(9);
        await expect(page.locator('main section.card[id]')).toHaveCount(9);
      }

      if (route.rows > 0) {
        await expect(page.locator('table.data-table tbody tr')).toHaveCount(route.rows);
      } else {
        await expect(page.locator('table.data-table')).toHaveCount(0);
      }

      switch (route.kind) {
        case 'landing': {
          await expect(page.locator('#contribute')).toBeVisible();
          await expect(page.locator('#landing-leaderboard')).toHaveCount(0);
          break;
        }
        case 'hub': {
          const links = page.locator('table.data-table tbody .hub-chain-link');
          await expect(links).toHaveCount(route.rows);
          const base = route.path.includes('private-keys') ? '/private-keys/' : '/mnemonic-seeds/';
          for (const href of await links.evaluateAll((nodes) =>
            nodes.map((node) => node.getAttribute('href') || ''),
          )) {
            expect(href.startsWith(base), `${href} must stay inside ${base}`).toBe(true);
          }
          break;
        }
        case 'key-table': {
          const firstKey = page.locator('tbody tr').first().locator('.private-key');
          await expect(firstKey).toHaveText(/^[0-9a-f]{64}$/);
          const firstRow = page.locator('tbody tr').first();
          await expect(firstRow.locator('a.address-link').first()).not.toBeEmpty();
          break;
        }
        case 'seed-table': {
          const phrase = page.locator('tbody tr').first().locator('td.mono.wrap').first();
          const words = (await phrase.innerText()).trim().split(/\s+/);
          expect(words, 'the first seed must be a 12-word BIP39 phrase').toHaveLength(12);
          await expect(page.locator('tbody tr').first().locator('a.address-link').first()).not.toBeEmpty();
          break;
        }
        case 'puzzle-hub': {
          await expect(page.locator('[data-puzzle-row]')).toHaveCount(route.rows);
          await expect(page.locator('[data-puzzle-table]')).toHaveAttribute(
            'data-puzzle-count',
            String(route.rows),
          );
          break;
        }
        case 'puzzle-detail': {
          const detail = page.locator('[data-puzzle-detail]');
          await expect(detail).toHaveAttribute('data-puzzle-number', '1');
          await expect(detail).toHaveAttribute('data-puzzle-status', 'solved');
          await expect(detail).toHaveAttribute(
            'data-puzzle-target',
            '1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH',
          );
          break;
        }
        case 'prose': {
          await expect(page.locator('main h2').first()).toBeVisible();
          const text = await page.locator('main').innerText();
          expect(text.trim().split(/\s+/).length).toBeGreaterThan(30);
          if (route.path === '/docs/') {
            // Scrollable code blocks must be keyboard reachable; axe does not
            // flag a non-focusable scroller, so pin it here.
            const tabindexes = await page
              .locator('main pre')
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('tabindex')));
            expect(tabindexes.length).toBeGreaterThan(0);
            expect(tabindexes.every((value) => value === '0')).toBe(true);
          }
          break;
        }
      }

      const overflow = await page.evaluate(() => {
        const root = document.documentElement;
        return {
          scrollWidth: root.scrollWidth,
          clientWidth: root.clientWidth,
          bodyWidth: document.body.scrollWidth,
        };
      });
      expect(
        overflow.scrollWidth,
        `document scrollWidth ${overflow.scrollWidth} exceeds viewport ${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
      expect(
        overflow.bodyWidth,
        `body scrollWidth ${overflow.bodyWidth} exceeds viewport ${overflow.clientWidth}`,
      ).toBeLessThanOrEqual(overflow.clientWidth + 1);
    });
  }
});
