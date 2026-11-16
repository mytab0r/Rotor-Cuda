# Tasks: SEO and information architecture

No product code in this change. Each task names its verification. "Front" =
page/copy work, "back" = coordinator routing/headers, "ops" = Cloudflare and
Search Console.

## 1. Route table and canonicalization (blocked by: —)

- [ ] Back: add one route table (path, title, description, canonical,
      indexable, page type) that `static_asset`, metadata and the sitemap all
      consume; keep `include_str!` serving (`src/coordinator/mod.rs:31-41`).
- [ ] Back: return a real `404` body for unknown non-API GET instead of the
      landing fallback (`:410-416`).
- [ ] Back: `301` normalization for `/key/`, `/key/index.html`, `/index.html`,
      uppercase paths; ignore query for HTML.
- [ ] Back: `301`/`308` for `http:` and `www.` if the origin ever sees them
      (Cloudflare enforces at the edge; verify).
- [ ] Test: assert unknown path = 404; each variant = 301 to the canonical;
      canonical matches the route table.

Verify: `curl -sI` on `/nope`, `/key/`, `/index.html`, `/%6Bey`; unit test on
the route table.

## 2. Metadata, breadcrumbs and structured data (blocked by: 1)

- [ ] Front: unique title and description for `/`, `/key`, `/docs` per the
      title/description patterns; reframe the landing title away from
      "key search".
- [ ] Front: canonical, OG and Twitter tags on every indexable page; one
      1200x630 OG image per page family.
- [ ] Front: visible breadcrumb markup per design D3 on `/`, `/key`, `/docs`,
      and the planned pages; `aria-current` on the last item.
- [ ] Front: JSON-LD per design D4: `WebSite` on `/`, `WebApplication` on
      calculators, `TechArticle` on docs/explainers, `BreadcrumbList`
      everywhere indexable.
- [ ] Back: serve metadata in the HTML, not injected by JS.
- [ ] Test: every indexable page has one non-empty title, description,
      canonical; JSON-LD parses and the breadcrumb tail equals the canonical.

Verify: Schema Markup Validator, `curl` head checks, a script over the route
table.

## 3. Sitemap and robots (blocked by: 1)

- [ ] Back: generate `/sitemap.xml` from the route table; indexable only;
      absolute; no query; omit volatile `lastmod`.
- [ ] Back: generate `/robots.txt`; allow `/`; disallow `/api/`, `/app`,
      `/me`, `/run`, `/status`; link the sitemap.
- [ ] Test: every sitemap URL returns 200 with no redirect; no `noindex` URL
      is listed; robots does not block an indexable page.

Verify: `curl` sitemap, loop over `<loc>` values, compare with the table.

## 4. Caching, asset versioning and Core Web Vitals (blocked by: 1, 4a)

- [ ] 4a Back: add a build version constant; append `?v=<build>` to
      `/key.js`, `/rotor-worker.js` and `/rotor_wasm.wasm` references
      (`apps/site/key.html:124`, `apps/site/run.html:413`, `apps/site/key.js:6`,
      `apps/site/rotor-worker.js:11`). Until then use short `max-age`.
- [ ] Back: HTML `public, max-age=0, must-revalidate` + `ETag`; versioned
      assets `public, max-age=31536000, immutable`; `/api/*` `no-store`.
- [ ] Back: lazy-load the 232 KB wasm on first derive, not on page load;
      reserve height for async stats to avoid CLS.
- [ ] Ops: confirm Cloudflare caches `.wasm` and keeps `?v=` in the cache key;
      add a Cache Rule if not; purge on deploy.
- [ ] Test: `curl -sI` headers; cache-bust check after a deploy; PageSpeed
      Insights lab run on `/`, `/key`, `/docs`.
- [ ] Test: field CWV at p75 after 28 days (LCP < 2.5 s, INP < 200 ms,
      CLS < 0.1).

## 5. Internal linking and orphan prevention (blocked by: 2)

- [ ] Front: hub sections "Calculators" and "Guides"; link every indexable
      page from `/`.
- [ ] Front: "Related calculations" block on each calculator (3-4 links + one
      docs/explainer link).
- [ ] Front: docs topics link to the matching calculator and prev/next; format
      explainers link to `/chains/<chain>`, siblings and `/key`.
- [ ] Front: descriptive anchors; no sitewide footer link farm.
- [ ] Test: crawl from `/`; every sitemap URL reachable in <= 2 hops; zero
      orphans.

Verify: scripted link crawl; manual review of anchor text.

## 6. Measurement (blocked by: 2)

- [ ] Ops: Cloudflare Web Analytics beacon on indexable pages only; none on
      `/app`, `/me`, `/run`.
- [ ] Ops: choose Plausible only if custom events are required; define
      `derive`, `check_balances`, `copy_address`, `broadcast`, `worker_start`.
- [ ] Front: ensure no event, URL or referrer carries a key, seed, WIF or
      address; no input values in analytics.
- [ ] Ops: Search Console domain verification (DNS TXT), sitemap submission,
      Bing Webmaster Tools.
- [ ] Test: network panel on `/key` shows no secret in analytics payloads;
      GSC reports no manual actions; sitemap status is "Success".

## 7. Content safety and policy gate (blocked by: —)

- [ ] Front: publish the content policy from design D7 in the repo/docs; it
      governs `/chains/**`, `/mnemonic` and any future programmatic page.
- [ ] Front: review `/` and `/key` copy against it: no "finder", "recover
      lost", "check any key" framing; safety notice stays visible.
- [ ] Front: add `/legal/privacy` and `/legal/terms`; named maintainer and
      contact on `/` or an about section; cite BIPs in explainers.
- [ ] Front: `mnemonic` ships `noindex,follow` until a separate safety review
      passes.
- [ ] Test: review checklist signed off before any `/chains/**` page is
      published; no real key/address anywhere in the repo site content.

## 8. v2: utility surfaces and docs split (blocked by: 1, 2)

- [ ] Back/Front: `/me` `noindex,nofollow`; `/app`, `/run` `noindex,follow`;
      `/status` `noindex,follow`; all excluded from the sitemap.
- [ ] Front: split `/docs` into `/docs/run-client`, `/docs/protocol`,
      `/docs/key-handling`, `/docs/api`; keep `/docs` as the hub with
      breadcrumbs.
- [ ] Back: `301` old anchors/sections where practical; keep `/docs` stable.
- [ ] Test: sitemap and robots reflect the split; no indexable page is
      disallowed; 404/301 suite still green.

## 9. v3: programmatic explainers and CDN (blocked by: 7, 3, 4)

- [ ] Front: publish `/chains`, `/chains/bitcoin`, and format pages
      (`p2pkh`, `p2sh-p2wpkh`, `p2wpkh`, `p2tr`), then Ethereum/Tron/Solana.
      Each passes the D7 quality gate: unique explanation, published-vector
      example, checksum/common mistakes, citation, calculator link.
- [ ] Front: add `/convert` and `/wif`; `/mnemonic` only after review.
- [ ] Back: add the new routes to the table, sitemap and internal links;
      `noindex` any page that is not ready.
- [ ] Ops: decide on Cloudflare Pages. If yes: route `/api/*` to the
      coordinator origin with a Worker, serve the rest from Pages, keep
      canonicals on `https://rotor.pxbt.app`, purge on deploy.
- [ ] Test: page-count threshold for Pages (~20-30) or origin latency justifies
      the move; canonical/sitemap/robots unchanged after the move.
- [ ] Test: spot-check each explainer against its cited vector; no duplicate
      bodies; no key-index route exists.

## Launch checklist (v1)

- [ ] Unknown path returns 404; `/key/`, `/index.html` return 301.
- [ ] Every indexable page: unique title, description, canonical, OG/Twitter.
- [ ] Visible breadcrumb and matching `BreadcrumbList` on every indexable page.
- [ ] `/sitemap.xml` and `/robots.txt` correct and consistent with the table.
- [ ] HTML revalidates; versioned assets are immutable; wasm/worker versioned.
- [ ] Cloudflare caches static assets and purges on deploy; `/api/*` not cached.
- [ ] Analytics on indexable pages only; no secret in any payload.
- [ ] Search Console verified, sitemap submitted, no manual actions.
- [ ] Internal crawl reaches every indexable page in <= 2 hops.
- [ ] Content-safety review signed off; no real key/address published.
- [ ] CWV lab run recorded; field monitoring scheduled at +28 days.

## Out of scope

- Product code in this change, HTML edits, coordinator changes, analytics
  scripts, DNS changes.
- Key/address index pages, "browse all keys", sweeping, signing or wallet
  import.
- i18n/`hreflang`, paid search, link building, ads.
