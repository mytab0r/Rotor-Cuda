import type { APIRoute } from 'astro';
import { MAINNET_CHAINS } from '../lib/chains';
import { PRERENDERED_ROUTES, SITE_ORIGIN } from '../lib/site';

/* The sitemap lists only the routes this static build actually contains.
 * The coordinator keeps serving the full sitemap until the origin cutover;
 * later phases add their route to PRERENDERED_ROUTES as the page moves. The
 * chain directory page-1 routes are built now, so they are listed here even
 * though the coordinator still serves that family until cutover. */
export const GET: APIRoute = () => {
  const routes = [
    ...PRERENDERED_ROUTES,
    ...MAINNET_CHAINS.map((chain) => `/private-keys/${chain.slug}`),
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
