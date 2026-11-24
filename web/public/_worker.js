/* Cloudflare Pages advanced-mode worker for `/key/<64-hex>`.
 *
 * Static files always win: the request is first answered by the Pages asset
 * layer, so a curated `/key/<hex>` page (and every non-key path, redirect and
 * 404) is byte-identical to the build. Only a missing 64-hex key page is
 * synthesized, from the built `/key/index.html` shell: title, description,
 * canonical and robots are rewritten, the default JSON-LD is removed, and one
 * `application/json` block carries the requested hex to the derive island.
 *
 * The template URL is a constant on the request origin; the path segment is
 * validated as 64 hex before it reaches the page, so no request data is
 * reflected outside the metadata and the JSON block. Arbitrary keys are
 * `noindex` because only the curated pages carry prerendered content.
 *
 * This file lives in `web/public/` and is copied to the deploy root by Astro.
 * It is authored in the frontend area, not a copy of apps/site (see the
 * `authored` list in data/vendor.lock.json). */

const KEY_RE = /^\/key\/([0-9a-fA-F]{64})\/?$/;

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function displayFor(hex) {
  return `0x${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

function replaceOrInject(html, pattern, tag) {
  if (pattern.test(html)) return html.replace(pattern, tag);
  return html.replace('</head>', `${tag}</head>`);
}

function injectMeta(html, { hex, canonical, title, description }) {
  const safeTitle = escapeHtml(title);
  const safeDescription = escapeHtml(description);
  const safeCanonical = escapeHtml(canonical);
  let out = replaceOrInject(html, /<title>[\s\S]*?<\/title>/i, `<title>${safeTitle}</title>`);
  out = replaceOrInject(
    out,
    /<meta\s+name="description"\s+content="[^"]*">/i,
    `<meta name="description" content="${safeDescription}">`,
  );
  out = replaceOrInject(
    out,
    /<link\s+rel="canonical"\s+href="[^"]*">/i,
    `<link rel="canonical" href="${safeCanonical}">`,
  );
  out = replaceOrInject(
    out,
    /<meta\s+name="robots"\s+content="[^"]*">/i,
    '<meta name="robots" content="noindex,follow">',
  );
  out = replaceOrInject(
    out,
    /<meta\s+property="og:title"\s+content="[^"]*">/i,
    `<meta property="og:title" content="${safeTitle}">`,
  );
  out = replaceOrInject(
    out,
    /<meta\s+property="og:description"\s+content="[^"]*">/i,
    `<meta property="og:description" content="${safeDescription}">`,
  );
  out = replaceOrInject(
    out,
    /<meta\s+property="og:url"\s+content="[^"]*">/i,
    `<meta property="og:url" content="${safeCanonical}">`,
  );
  out = replaceOrInject(
    out,
    /<meta\s+name="twitter:title"\s+content="[^"]*">/i,
    `<meta name="twitter:title" content="${safeTitle}">`,
  );
  out = replaceOrInject(
    out,
    /<meta\s+name="twitter:description"\s+content="[^"]*">/i,
    `<meta name="twitter:description" content="${safeDescription}">`,
  );
  /* The template's WebPage node points at /key; the synthesized page is not
   * indexable and must not claim the hub as its canonical entity. */
  out = out.replace(/<script\b[^>]*type="application\/ld\+json"[^>]*>[\s\S]*?<\/script>/gi, '');
  /* The hub shell renders the URL-exposure notice hidden. A synthesized route
   * is exactly a key taken from the URL, so the same sentence must be visible. */
  out = out.replace(
    /(<p\b[^>]*id="key-url-notice"[^>]*?)\s+hidden(?:="[^"]*")?(?=[\s>])/i,
    '$1',
  );
  out = out.replace(/<html\b/i, '<html data-key-source="worker"');
  const payload = JSON.stringify({ hex });
  out = out.replace(
    '</head>',
    `<script type="application/json" id="key-request">${payload}</script></head>`,
  );
  return out;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = request.method === 'GET' ? url.pathname.match(KEY_RE) : null;
    if (!match) return env.ASSETS.fetch(request);

    const asset = await env.ASSETS.fetch(request);
    if (asset.status !== 404) return asset;

    const template = await env.ASSETS.fetch(
      new Request(new URL('/key/index.html', url).href, { headers: request.headers }),
    );
    if (!template.ok) return asset;

    const hex = match[1].toLowerCase();
    const display = displayFor(hex);
    const canonical = `${url.origin}/key/${hex}`;
    const title = `Private key ${display}: 30 addresses on 18 chains | Crypto`;
    const description =
      `The 256-bit key ${display} and all 30 addresses it derives on 18 chains, ` +
      'with WIF, public key, decimal and XRP secret. Computed in your browser.';
    const html = injectMeta(await template.text(), { hex, canonical, title, description });
    return new Response(html, {
      status: 200,
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-robots-tag': 'noindex',
      },
    });
  },
};
