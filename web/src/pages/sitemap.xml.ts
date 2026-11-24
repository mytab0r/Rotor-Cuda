import type { APIRoute } from 'astro';
import { MAINNET_CHAINS } from '../lib/chains';
import { INDEXABLE_PUZZLES } from '../lib/puzzles';
import { CURATED_KEYS } from '../lib/key-curated';
import { PRERENDERED_ROUTES, SITE_ORIGIN } from '../lib/site';

/* The sitemap lists only the routes this static build actually contains.
 * The coordinator keeps serving the full sitemap until the origin cutover;
 * later phases add their route to PRERENDERED_ROUTES as the page moves. The
 * chain directory page-1 routes are built now, so they are listed here even
 * though the coordinator still serves that family until cutover.
 *
 * Puzzle detail pages are listed only when `INDEXABLE_PUZZLES` keeps them, so
 * a record that cannot carry its facts (and is therefore rendered noindex)
 * can never be advertised here. The hub itself is in PRERENDERED_ROUTES. Only
 * the curated `/key/<hex>` pages are indexable; `_worker.js` serves every
 * other key with noindex, so no arbitrary key may enter this file. */
export const GET: APIRoute = () => {
  const routes = [
    ...PRERENDERED_ROUTES,
    ...MAINNET_CHAINS.map((chain) => `/private-keys/${chain.slug}`),
    ...MAINNET_CHAINS.map((chain) => `/mnemonic-seeds/${chain.slug}`),
    ...INDEXABLE_PUZZLES.map((puzzle) => `/bitcoin-puzzle/${puzzle.number}`),
    ...CURATED_KEYS.map((key) => key.path),
  ];
  const urls = routes.map(
    (route) => `  <url><loc>${new URL(route, SITE_ORIGIN).href}</loc></url>`,
  ).join('\n');
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
  return new Response(xml, {
    headers: { 'Content-Type': 'application/xml; charset=utf-8' },
  });
};
