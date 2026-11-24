import { expect, test, type Page } from '@playwright/test';

/* The address-format selector (#format-panel) is scoped to the selected chain.
 * This is the rendered-page counterpart to `apps/site/key-tools-test.mjs`,
 * which only counts the option list: here the real panel, the real chain chips
 * and a conflicting URL are exercised in a browser, so a markup or wiring
 * regression cannot pass on the helper alone.
 *
 * `/key` is served by the coordinator, not by the Astro `dist/`, so this spec
 * runs under `playwright.coord.config.ts` and is excluded from the static-site
 * project in `playwright.config.ts`. It keeps its own offline guard: the
 * Astro fixture asserts a zero-external-request page and an `html.js` class,
 * neither of which the coordinator shell provides. The page fetches fiat
 * prices from a third party on load; aborting them keeps the run offline
 * without making an unrelated feature decide the test. */

const PANEL = '#format-panel';
const CARD = '.address-type-card';
const BTC_FORMATS = ['btc_p2pkh', 'btc_p2wpkh', 'btc_p2sh_p2wpkh', 'btc_p2tr'];

const chainChip = (chain: string): string => `.key-chain[data-chain="${chain}"]`;

test.beforeEach(async ({ context }) => {
  await context.addInitScript(() => {
    Object.defineProperty(Navigator.prototype, 'doNotTrack', {
      configurable: true,
      get: () => '1',
    });
    Object.defineProperty(window, 'doNotTrack', { configurable: true, value: '1' });
  });
  await context.route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return route.continue();
    if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') return route.continue();
    return route.abort();
  });
});

async function openKey(page: Page, path: string): Promise<void> {
  await page.goto(path, { waitUntil: 'load' });
  await expect(page.locator('#priv')).toBeVisible();
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

async function deriveKey(page: Page): Promise<void> {
  /* The page derives only from an entered key; without one every chain has
   * zero rows and the panel stays hidden for the wrong reason. */
  await page.locator('#priv').fill(`${'0'.repeat(63)}1`);
  await expect(page.locator('#summary-card')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('#addr-rows .key-row:not(.hidden)').first()).toBeVisible();
}

async function cardRows(page: Page): Promise<string[]> {
  return page
    .locator(`${CARD}[data-row]`)
    .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-row') || ''));
}

test.describe('key address-format scope', () => {
  test('All hides the panel, Bitcoin shows its four formats, EVM hides it again', async ({
    page,
  }) => {
    await openKey(page, '/key');
    await deriveKey(page);

    await expect(page.locator(chainChip('all'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(PANEL)).toBeHidden();

    await page.locator(chainChip('btc')).click();
    await expect(page.locator(chainChip('btc'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(PANEL)).toBeVisible();
    await expect(page.locator(CARD)).toHaveCount(BTC_FORMATS.length);
    expect((await cardRows(page)).sort()).toEqual([...BTC_FORMATS].sort());

    await page.locator(chainChip('evm')).click();
    await expect(page.locator(chainChip('evm'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(PANEL)).toBeHidden();
    await expect(page.locator(`${CARD}[aria-pressed="true"]`)).toHaveCount(0);
  });

  test('a foreign ?type is ignored when ?chain names another chain', async ({ page }) => {
    await openKey(page, '/key?chain=evm&type=taproot');
    await deriveKey(page);

    await expect(page.locator(chainChip('evm'))).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator(chainChip('btc'))).toHaveAttribute('aria-pressed', 'false');
    await expect(page.locator(PANEL)).toBeHidden();
    /* The taproot format must not survive as a filter or a focus on EVM. */
    await expect(page.locator(`${CARD}[data-row^="btc_"]`)).toHaveCount(0);
    await expect(page.locator('.key-row.key-row-focus[data-id^="btc_"]')).toHaveCount(0);
  });
});
