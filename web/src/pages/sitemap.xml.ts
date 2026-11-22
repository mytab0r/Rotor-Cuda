import type { APIRoute } from 'astro';
import { PRERENDERED_ROUTES, SITE_ORIGIN } from '../lib/site';

/* The sitemap lists only the routes this static build actually contains.
 * The coordinator keeps serving the full sitemap until the origin cutover;
 * later phases add their route to PRERENDERED_ROUTES as the page moves. */
export const GET: APIRoute = () => {
  const urls = PRERENDERED_ROUTES.map(
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
