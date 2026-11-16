# SEO and information architecture for the coordinator site

## Summary

The coordinator already serves a small static site plus client-side
calculators (`/`, `/key`, `/docs`, `/app`, `/run`, `/me`) from one Rust binary.
It has a title tag and nothing else: no descriptions, canonicals, structured
data, sitemap, robots.txt, or URL policy, and unknown paths return the landing
page with HTTP 200. This change defines a deliberate URL tree, breadcrumbs,
structured data, crawl policy, caching and measurement so the calculators can
rank without the site becoming a thin programmatic-key index or a theft aid.

Deliverable is a written strategy plus a delta spec; implementation is split
into v1/v2/v3 tasks and is not part of this change.

## Problem / motivation

Measured against the current tree (2026-11-16):

- Every HTML page has only `<title>`; no `meta description`, `link rel=canonical`
  or Open Graph. Audit of `web/*.html` returned zero matches for all three.
- `static_asset` matches exact paths only and any unknown non-API GET falls back
  to the landing page with `200` (`src/coordinator/mod.rs:488-506`, `:410-416`).
  That is a soft-404 generator and a duplicate-content source.
- Every static response is sent `Cache-Control: no-cache`
  (`src/coordinator/mod.rs:404-407`), so the Cloudflare proxy in front of the
  origin (`deploy/README.md:117-119`, host `rotor.pxbt.app` at `:109`) cannot
  cache pages or the 232 KB wasm artifact.
- Asset URLs are partly versioned in HTML (`?v=20261116`, e.g.
  `web/landing.html:7`, `web/key.html:124`) but `/rotor-worker.js` and
  `/rotor_wasm.wasm` are requested unversioned from JS (`web/run.html:413`,
  `web/key.js:6`, `web/rotor-worker.js:11`). Long-lived caching is therefore
  unsafe until those references are versioned.
- There is no `/robots.txt` or `/sitemap.xml` (`web/` listing).
- The nav is duplicated per page (`web/landing.html:10-18` and every other
  page); there is no breadcrumb and no hub linking model.
- `/key` deliberately keeps the key out of the URL: `web/key.js` contains no
  `location`, `history` or `pushState` use, and the key-explorer change
  specifies memory-only handling.

Without a policy, the obvious growth path (programmatic `/private-keys/<coin>/<key>`
pages, as some reference sites do) is both a thin-content/doorway risk and a
harm risk. This proposal recommends a defensible alternative.

## Scope

### In scope (strategy + specified behavior)

- Page taxonomy and canonical URL scheme for hub, calculators, chain/format
  explainers, docs, utility pages and status.
- Canonicalization rules: trailing slash, case, `.html`, query strings, unknown
  paths (404, not a 200 landing fallback).
- Breadcrumb model (visible HTML + `BreadcrumbList` JSON-LD) mapped to the URL
  tree, with examples for `/key`, `/tx`, `/docs/<topic>`, chain explainers.
- Per-page structured data and metadata: title/description/canonical/OG,
  `WebSite`, `WebApplication`, `TechArticle`, `FAQPage`, `HowTo`,
  `BreadcrumbList`.
- `robots.txt` and `sitemap.xml` generated from one route table in the
  coordinator (with a Cloudflare Pages option at v3).
- Internal linking rules and orphan-page prevention.
- Caching/Core Web Vitals strategy and when to split static pages to
  Cloudflare Pages.
- Privacy-friendly measurement, Search Console, and event definitions.
- Risk register: Google policy, YMYL, thin/programmatic pages, brand terms,
  legal disclaimers.

### Out of scope

- Product code, HTML/CSS changes, coordinator routing changes, analytics
  scripts, DNS/CDN configuration. Those are tasks for later changes.
- Publishing an index of real private keys, funded addresses, or "browse all
  keys" pages. Explicitly rejected.
- i18n and `hreflang`; the site is `lang="en"` and no second locale is decided.
- Paid search, link building, affiliate/ads monetization.
- Sweeping, signing, wallet import, or any feature that moves funds.

## Recommended URL scheme (decision summary)

Canonical origin: `https://rotor.pxbt.app` (existing deploy host). All canonical
URLs are absolute, lowercase, extensionless, without a trailing slash. Query
strings never change HTML content; `?v=` exists only on static asset URLs.

```
/                         hub (site + tools overview)
/key                      private-key -> address calculator      (live)
/tx                       transaction builder / broadcaster      (planned)
/convert                  number and encoding converter          (planned)
/wif                      WIF converter                         (planned)
/mnemonic                 mnemonic / BIP32 explainer+tool       (planned, review gate)
/chains                   chain explainer hub                   (planned)
/chains/<chain>           chain explainer                       (planned)
/chains/<chain>/<format>  address-format explainer              (planned)
/docs                     documentation hub                     (live)
/docs/<topic>             one guide per topic                   (planned split)
/app                      operator console                      (live, noindex)
/run                      browser worker                        (live, noindex)
/me                       cabinet                               (live, noindex)
/status                   public status                         (planned, noindex)
/robots.txt, /sitemap.xml
```

Calculators stay flat at the root, not under `/calculators/`: `/key` is already
live and linked, flat slugs are the shortest stable URLs, and a thin
`/calculators` hub would add a crawl hop without content. The root namespace is
reserved: a new root slug must be a calculator or an app surface from the table
above. `chains` and `docs` are the only nested trees. Full table, canonical and
robots per row are in `design.md` D2.

### Programmatic pages: rejected variant and the defensible one

Rejected: `/private-keys/<coin>/<key>` or `/address/<address>` pages generated
per key/address. They are near-duplicate thin pages, match doorway-page and
scaled-content-abuse patterns, and turn the site into a lookup surface for
other people's keys.

Recommended: `/chains/<chain>/<format>` explainers built from published test
vectors and deterministic fixtures (key 1, BIP173/BIP350/BIP341 vectors,
checksum-failure examples). Each page explains one encoding: input, steps,
worked example, checksum, common mistakes, and a link to the matching
calculator. No user input is indexed; no real key or funded address is
published. If a "browse" surface is ever needed, it browses formats and test
vectors, not keys.

## Impacted domains

- `site-seo` (new): crawl policy, metadata, structured data, breadcrumbs,
  sitemap/robots, caching, analytics.
- `coordinator`: route table, 404/301 behavior, cache headers, sitemap/robots
  routes (`src/coordinator/mod.rs:397-506`).
- `browser-client`: asset version references (`web/run.html:413`,
  `web/key.js:6`, `web/rotor-worker.js:11`).
- `docs`/site: page copy, titles/descriptions, internal links.
- Deployment/ops: Cloudflare cache rules, analytics, Search Console.
- `tx-signing`: `/tx` page inherits this scheme when it lands.

## Acceptance criteria

Each is checkable with a command or a review checklist.

1. `GET /does-not-exist` returns HTTP 404, not 200, and the body is not the
   landing page. `curl -sI https://rotor.pxbt.app/does-not-exist`.
2. `GET /key/`, `/key/index.html`, `/index.html` return 301 to `/key`, `/key`,
   `/` respectively. `curl -sI` on each.
3. Every indexable route returns a unique non-empty `<title>` and
   `<meta name="description">`, one absolute `<link rel="canonical">` equal to
   the route's canonical, and OG/Twitter tags. Automated test over the route
   table.
4. `/sitemap.xml` lists exactly the indexable routes (no `/app`, `/run`, `/me`,
   `/status`, `/api/*`) and every listed URL returns 200 without redirect.
   Test crawls every entry.
5. `/robots.txt` disallows `/api/`, `/app`, `/me`, `/run`, `/status`, links the
   sitemap, and no indexable page is disallowed.
6. Every indexable page type emits valid `BreadcrumbList` JSON-LD whose items
   match the visible breadcrumb and whose last item equals the canonical URL.
   Validated with Schema Markup Validator and a JSON parse test.
7. HTML is served `public, max-age=0, must-revalidate` (or `s-maxage` short)
   with a validator; versioned assets are served
   `public, max-age=31536000, immutable`; the wasm and worker URLs carry a
   version. Verified with `curl -sI` and a cache-bust check after deploy.
8. A crawl from `/` reaches every indexable sitemap URL in at most two link
   hops; zero orphan pages. Scripted link crawl.
9. No page publishes a real private key, funded address, or key-index route.
   Review checklist against the policy in `design.md` D7.
10. Field Core Web Vitals at p75 (mobile) meet LCP < 2.5 s, INP < 200 ms,
    CLS < 0.1 on `/`, `/key`, `/docs` after 28 days, read from Search Console
    Core Web Vitals or CrUX.

## Risks / unknowns

- **Policy risk (highest).** Private-key tooling sits next to theft and scam
  content. Google has no explicit ban, but scaled content abuse, doorway pages
  and thin pages are spam-policy categories; a programmatic key index is a
  manual-action candidate. Mitigation: no key index, unique explainer copy,
  reviewed pages only, `noindex` on utility surfaces.
- **YMYL.** Crypto finance is held to E-E-A-T standards. Mitigation: named
  maintainer, about/contact, cited BIPs, disclaimers, no recovery claims.
- **Intent mismatch.** "Key search" in the landing title can read as key
  cracking. Mitigation: title/description target puzzle solving and
  conversion/explanation intent, not "find lost key".
- **Mnemonic page.** Accepting seed phrases online is high-harm. Launch
  `noindex,follow` until a safety review passes.
- **Attribution/brand.** Chain and wallet names are used nominatively; no
  logos, no implied affiliation. "Rotor" may collide with unrelated marks; not
  verified.
- **CDN behavior.** Cloudflare cache-key defaults for `.wasm` and query
  strings are not verified in this environment; a cache rule may be required.
- **Rich results.** `HowTo` rich results were retired and `FAQPage` rich
  results are restricted; markup is for semantics, not a display guarantee.
- **i18n.** `hreflang` is deliberately not specified; adding locales later
  needs its own change.

## References

- `src/coordinator/mod.rs:31-41` embedded pages/assets; `:397-506` routing,
  fallback and `Cache-Control: no-cache`.
- `web/landing.html:10-18` nav; `:7` versioned CSS; `web/key.html:124`
  versioned key.js; `web/key.js:6` wasm URL; `web/run.html:413` worker URL.
- `openspec/changes/key-explorer/proposal.md` memory-only key handling;
  `openspec/changes/key-explorer/specs/key-explorer/spec.md` no URL/history.
- `openspec/changes/tx-sign-broadcast/` for the planned `/tx` surface.
- `openspec/specs/coordinator/spec.md` embedded-asset requirement.
- `deploy/README.md:109,117-119` host and Cloudflare proxy facts.
- Reference patterns reviewed: privatekeyfinder.io (browser derivation plus
  public balance APIs, per-key pages), secretscan.org (server-side step
  calculators). Neither pattern is copied wholesale; the key-index part is
  rejected.
