import { expect, openRoute, test } from './fixtures';

/* The narrow-screen disclosure is the one piece of header behaviour that can
 * fail in a way a static screenshot misses. It exists once, opens, closes on
 * Escape and returns focus to its trigger; a wide viewport hides it and shows
 * the full nav instead. */

test.describe('navigation disclosure', () => {
  test('one toggle at narrow widths; Escape closes the menu', async ({ page }) => {
    await openRoute(page, '/');

    const toggle = page.locator('[data-nav-toggle]');
    const nav = page.locator('#site-nav-main');
    const viewport = page.viewportSize();
    expect(viewport).not.toBeNull();
    const narrow = (viewport?.width ?? 0) <= 1200;

    await expect(toggle).toHaveCount(1);

    if (!narrow) {
      await expect(toggle).toBeHidden();
      await expect(nav).toBeVisible();
      return;
    }

    await expect(page.locator('[data-nav-toggle]:visible')).toHaveCount(1);
    await expect(nav).toBeHidden();

    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle).toHaveAttribute('aria-label', 'Close navigation');
    await expect(nav).toBeVisible();

    await page.keyboard.press('Escape');
    await expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle).toHaveAttribute('aria-label', 'Open navigation');
    await expect(nav).toBeHidden();
    await expect(toggle).toBeFocused();
  });
});
