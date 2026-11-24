# Design: SEO and information architecture

Status: proposal-level design. No product code in this change.

## D1. Current state (facts, 2026-11-16)

| Fact | Evidence |
|---|---|
| All pages are compile-time strings | `src/coordinator/mod.rs:31-41` |
| Router is exact-match; unknown non-API GET returns landing with 200 | `:488-506`, `:410-416` |
| Every static response is `Cache-Control: no-cache` | `:404-407` |
| No description/canonical/OG on any page | audit of `apps/site/*.html`: 0 matches |
| No `robots.txt` or `sitemap.xml` | `apps/site/` contains neither |
| HTML assets partly versioned with `?v=` | `apps/site/landing.html:7`, `apps/site/key.html:124` |
| Worker and wasm requested unversioned | `apps/site/run.html:413`, `apps/site/key.js:6`, `apps/site/rotor-worker.js:11` |
| Key never enters URL/history/storage | `apps/site/key.js` has no location/history API use; key-explorer spec |
| Public host and CDN | `deploy/README.md:109` (`rotor.pxbt.app`), `:117-119` (Cloudflare) |

Consequences: soft-404 duplicates, no CDN caching, no crawl metadata, no
hierarchy. The site is small now, so fixing this before adding pages is cheap.

## D2. URL map, canonicalization and robots

Canonical origin `https://rotor.pxbt.app`. Canonical form: lowercase, no
trailing slash, no file extension, no query string.

| Path | Purpose | State | Canonical | robots | Cache |
|---|---|---|---|---|---|
| `/` | Hub: product, tools, guides | live | self | `index,follow` | HTML, revalidate |
| `/key` | Key -> address calculator | live | self | `index,follow` | HTML |
| `/tx` | Transaction builder/broadcaster | planned | self | `index,follow` after safety review | HTML |
| `/convert` | Number/encoding converter | planned | self | `index,follow` | HTML |
| `/wif` | WIF converter | planned | self | `index,follow` | HTML |
| `/mnemonic` | Mnemonic/BIP32 explainer+tool | planned | self | `noindex,follow` at launch | HTML |
| `/chains` | Chain explainer hub | planned | self | `index,follow` | HTML |
| `/chains/bitcoin` | Bitcoin address family explainer | planned | self | `index,follow` | HTML |
| `/chains/bitcoin/p2pkh` | Format explainer (fixtures only) | planned | self | `index,follow` | HTML |
| `/chains/bitcoin/p2sh-p2wpkh` | Format explainer | planned | self | `index,follow` | HTML |
| `/chains/bitcoin/p2wpkh` | Format explainer | planned | self | `index,follow` | HTML |
| `/chains/bitcoin/p2tr` | Format explainer | planned | self | `index,follow` | HTML |
| `/chains/ethereum`, `/chains/ethereum/address` | EVM explainers | planned | self | `index,follow` | HTML |
| `/chains/tron`, `/chains/solana` | Chain explainers | planned | self | `index,follow` | HTML |
| `/docs` | Docs hub | live | self | `index,follow` | HTML |
| `/docs/run-client` | Run a native client | planned split | self | `index,follow` | HTML |
| `/docs/protocol` | Lease/heartbeat/result protocol | planned split | self | `index,follow` | HTML |
| `/docs/key-handling` | Key safety guide | planned split | self | `index,follow` | HTML |
| `/docs/api` | Admin/client API | planned split | self | `index,follow` | HTML |
| `/app` | Operator console (token) | live | self | `noindex,follow` | HTML |
| `/run` | Browser worker (token) | live | self | `noindex,follow` | HTML |
| `/me` | Cabinet (token) | live | self | `noindex,nofollow` | HTML |
| `/status` | Public uptime/status | planned | self | `noindex,follow` | HTML, short |
| `/legal/privacy`, `/legal/terms` | Trust pages | planned | self | `index,follow` | HTML |
| `/api/*` | JSON API | live | n/a | `Disallow` | never cache |
| `/robots.txt`, `/sitemap.xml` | Crawl control | planned | n/a | n/a | short |

### Canonicalization rules

1. Unknown path -> `404` with a real not-found body; never the landing page.
   This is the single most important fix.
2. Trailing slash -> `301` to the no-slash form (`/key/` -> `/key`).
3. `/index.html` -> `301` to `/`; `/key/index.html` -> `301` to `/key`.
4. Uppercase path -> `301` to lowercase.
5. Query strings are ignored for HTML; canonical never includes them. `?v=`
   only on asset URLs. The key stays out of the URL (existing behavior).
6. `www.` and `http:` -> `301` to `https://rotor.pxbt.app` (Cloudflare can
   enforce; verify at the origin too).
7. No pagination at v1. If docs need it later: page 1 is the canonical
   entry; each page self-canonicalizes, pages > 1 stay out of the sitemap, and
   `rel=next/prev` is optional. Never paginate a list of keys.
8. One canonical per page, absolute, self-referencing on indexable pages.

## D3. Breadcrumbs (visible markup + BreadcrumbList)

Model: the visible breadcrumb mirrors the URL tree. Root is Home; calculators
are root-level peers (Home > Key), so no fake intermediate "Calculators" crumb
without a page. Docs and chains have real intermediate hubs.

Markup contract: `<nav aria-label="Breadcrumb">` with an ordered list, links
for every crumb except the current one, `aria-current="page"` on the last.
JSON-LD must match the visible trail; the last item is the page canonical.

### Example 1: `/key`

```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumb">
    <li><a href="/">Home</a></li>
    <li aria-current="page">Private key calculator</li>
  </ol>
</nav>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
 {"@type":"ListItem","position":1,"name":"Home","item":"https://rotor.pxbt.app/"},
 {"@type":"ListItem","position":2,"name":"Private key calculator","item":"https://rotor.pxbt.app/key"}
]}
</script>
```

### Example 2: `/tx`

```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumb">
    <li><a href="/">Home</a></li>
    <li aria-current="page">Transaction builder</li>
  </ol>
</nav>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
 {"@type":"ListItem","position":1,"name":"Home","item":"https://rotor.pxbt.app/"},
 {"@type":"ListItem","position":2,"name":"Transaction builder","item":"https://rotor.pxbt.app/tx"}
]}
</script>
```

### Example 3: `/docs/run-client`

```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumb">
    <li><a href="/">Home</a></li>
    <li><a href="/docs">Docs</a></li>
    <li aria-current="page">Running a client</li>
  </ol>
</nav>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
 {"@type":"ListItem","position":1,"name":"Home","item":"https://rotor.pxbt.app/"},
 {"@type":"ListItem","position":2,"name":"Docs","item":"https://rotor.pxbt.app/docs"},
 {"@type":"ListItem","position":3,"name":"Running a client","item":"https://rotor.pxbt.app/docs/run-client"}
]}
</script>
```

### Example 4: `/chains/bitcoin/p2tr`

```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumb">
    <li><a href="/">Home</a></li>
    <li><a href="/chains">Chains</a></li>
    <li><a href="/chains/bitcoin">Bitcoin</a></li>
    <li aria-current="page">P2TR</li>
  </ol>
</nav>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
 {"@type":"ListItem","position":1,"name":"Home","item":"https://rotor.pxbt.app/"},
 {"@type":"ListItem","position":2,"name":"Chains","item":"https://rotor.pxbt.app/chains"},
 {"@type":"ListItem","position":3,"name":"Bitcoin","item":"https://rotor.pxbt.app/chains/bitcoin"},
 {"@type":"ListItem","position":4,"name":"P2TR","item":"https://rotor.pxbt.app/chains/bitcoin/p2tr"}
]}
</script>
```

### Example 5: `/docs` (hub)

```html
<nav aria-label="Breadcrumb">
  <ol class="breadcrumb">
    <li><a href="/">Home</a></li>
    <li aria-current="page">Docs</li>
  </ol>
</nav>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"BreadcrumbList","itemListElement":[
 {"@type":"ListItem","position":1,"name":"Home","item":"https://rotor.pxbt.app/"},
 {"@type":"ListItem","position":2,"name":"Docs","item":"https://rotor.pxbt.app/docs"}
]}
</script>
```

## D4. Metadata and structured data per page type

Title pattern: `<specific page name> — <short qualifier> | Rotor` (50-60
chars). Description: 140-160 chars, states what the page does and the safety
model. No keyword stuffing; no "finder", "recover lost", or "check any key"
framing on `/key`.

| Page type | Structured data | Notes |
|---|---|---|
| `/` | `WebSite` (+ `Organization` if a profile exists) | No `SearchAction`: there is no site search |
| `/key`, `/tx`, `/convert`, `/wif` | `WebApplication` + `BreadcrumbList`; `FAQPage` only for genuine Q&A | No rich-result expectation for WebApplication |
| `/mnemonic` | `WebApplication` + `BreadcrumbList` | `noindex` at launch |
| `/chains/<chain>` | `TechArticle` + `BreadcrumbList` | Cite BIPs and sources |
| `/chains/<chain>/<format>` | `TechArticle` + `HowTo` + `FAQPage` + `BreadcrumbList` | HowTo/FAQ semantic only; rich results retired/restricted |
| `/docs`, `/docs/<topic>` | `TechArticle` (hub may use `CollectionPage`) + `BreadcrumbList` | Include `dateModified` |
| `/app`, `/run`, `/me`, `/status` | none | `noindex` |
| `/legal/*` | `WebPage` + `BreadcrumbList` | Trust pages |

Common head contract for every indexable page:

```html
<meta name="description" content="...">
<link rel="canonical" href="https://rotor.pxbt.app/key">
<meta property="og:type" content="website">
<meta property="og:title" content="...">
<meta property="og:description" content="...">
<meta property="og:url" content="https://rotor.pxbt.app/key">
<meta property="og:image" content="https://rotor.pxbt.app/og/key.png">
<meta name="twitter:card" content="summary_large_image">
```

One shared 1200x630 OG image per page family is enough at v1. Do not add
`hreflang` until a second locale exists; then add self-referencing `en` plus
`x-default`.

## D5. Sitemap and robots generation

One route table is the source of truth: `(path, title, description, canonical,
indexable, page_type)`. `static_asset` and the tests consume the same table;
`/sitemap.xml` and `/robots.txt` are generated from it (a small Rust function
that emits XML/text, not a template engine).

Rules:

- Sitemap contains only `indexable` routes; absolute canonical URLs; no query,
  no redirects, no `noindex` pages.
- Omit `lastmod` rather than emitting a build timestamp that changes every
  deploy; add real per-page dates only when content dates exist.
- `robots.txt` allows `/`, disallows `/api/`, `/app`, `/me`, `/run`, `/status`,
  and links the sitemap. It is crawl guidance, not access control; the token
  checks stay in the API.
- On Cloudflare Pages (v3), the generator runs in the build; the coordinator
  keeps only the API. Never maintain two hand-edited copies.

## D6. Internal linking

- Hub sections: "Calculators" (`/key`, `/tx`, `/convert`, `/wif`, `/mnemonic`)
  and "Guides" (`/docs`, `/chains`). Every indexable page is reachable from `/`
  in at most two hops.
- Each calculator ends with a "Related calculations" block: 3-4 contextual
  links plus one docs/explainer link (e.g. `/wif` -> `/key`, `/convert`,
  `/docs/key-handling`).
- Each docs topic links to the matching calculator and to prev/next topics.
- Each format explainer links up to `/chains/<chain>`, across to sibling
  formats, and to `/key` with descriptive anchor text ("derive a P2TR address").
- Anchors are descriptive; no "click here". No sitewide link farm footer.
- Orphan rule: a page may be `noindex` and unlinked from the hub, but every
  indexable page must be linked from the hub and from at least one contextual
  page.
- Nav is currently duplicated in every file; when it grows, keep one ordered
  list and inject it at build time to avoid drift. This change does not require
  a templating dependency; a small substitution helper is enough.

## D7. Content and safety policy (programmatic pages)

Allowed: deterministic reference pages for formats and test vectors.

Forbidden, at any phase:

- An index or paginated list of real private keys, derived addresses, or
  balances ("browse all keys", `/private-keys/<coin>/<key>`).
- Pages targeting "lost private key", "find lost bitcoin", "recover wallet",
  "check private key balance", or similar theft/recovery intent.
- Publishing any real funded key/address as an example.
- Server-side receipt, logging or analytics capture of keys, seeds, WIFs or
  addresses typed by a visitor.

Explainer quality gate (every `/chains/*` page): unique explanation of the
encoding, a worked example from a published vector, checksum/common-mistake
section, citation to the BIP/EIP, and a link to the calculator. No page is
generated until it has this content; a near-duplicate template with swapped
names is a doorway page and is rejected. `mnemonic` stays `noindex` until a
separate safety review.

## D8. Performance, caching and CDN

Current blocker: `Cache-Control: no-cache` on everything means the Cloudflare
proxy revalidates or bypasses, so the binary's single origin serves every
request. Fix in v1:

| Resource | Header | Precondition |
|---|---|---|
| HTML | `public, max-age=0, must-revalidate` + `ETag` | Add a validator; HTML changes on deploy |
| `/site.css?v=`, `/site.js?v=`, `/key.js?v=` | `public, max-age=31536000, immutable` | HTML already versions these |
| `/rotor_wasm.wasm`, `/rotor-worker.js` | same, after versioning the references | Must first add `?v=<build>` in `key.js`, `rotor-worker.js`, `run.html` |
| `/api/*` | `no-store` | Never cache tokens/stats |

Until the wasm/worker references are versioned, serve them with a short
`max-age` (e.g. 300) rather than `immutable`, or clients can pin an old wasm
after a deploy. Confirm Cloudflare caches `.wasm` and keeps the query in the
cache key (a Cache Rule may be needed); this is unverified here.

Core Web Vitals notes: no web fonts, small CSS, text LCP — the main risks are
(1) the 232 KB wasm blocking interactivity, so load it lazily on first derive,
not on page load; (2) layout shift from async stats on `/`, so reserve card
height; (3) INP from derivation on the main thread, so keep the existing worker
path. Targets: LCP < 2.5 s, INP < 200 ms, CLS < 0.1 at p75 mobile.

When to move static pages to Cloudflare Pages: when indexable pages exceed
roughly 20-30, or organic traffic competes with API latency on the single
origin, or deploys of copy require rebuilding the binary. Preferred split:
keep the hostname and route `/api/*` to the coordinator origin with a
Cloudflare Worker, serve everything else from Pages. This preserves canonicals
and avoids CORS. Moving the API to `api.<host>` is the fallback, but it adds
CORS and a second canonical surface. Do not split at v1.

## D9. Measurement and events

- Cloudflare Web Analytics: cookie-less baseline (pageviews, referrers, CWV)
  on indexable pages only; no script on `/app`, `/me`, `/run`.
- Plausible (or equivalent) only if custom events are required; Cloudflare Web
  Analytics does not support them.
- Events, aggregate only, never values: `derive` (curve, preset),
  `check_balances` (provider success/fail), `copy_address` (row type),
  `broadcast` (chain, success/fail), `worker_start`. No key, seed, WIF or
  address in event properties, URLs or referrers.
- Search Console: domain property via DNS TXT in Cloudflare; submit
  `/sitemap.xml`; Bing Webmaster Tools too. Weekly review of queries, pages,
  Core Web Vitals and the Manual Actions report.
- Success metric for v1: `/key`, `/docs`, `/` indexed with correct canonicals;
  impressions for conversion/explanation terms, not "finder" terms.

## D10. Risk register and policy

| Risk | Likelihood/impact | Mitigation |
|---|---|---|
| Manual action for thin/programmatic pages | medium/high | No key index; reviewed explainers with unique content; small page count |
| Doorway-page classification | medium/high | Real hierarchy, real hub content, no parameter-generated permutations |
| Theft facilitation / harm | medium/very high | No key lookup index, no funded examples, no sweeping, explicit safety copy |
| YMYL / E-E-A-T | high/medium | Named maintainer, about/contact, sources, review dates, disclaimers |
| Trademark/brand misuse | medium/medium | Nominative use only, no logos, no "official", non-affiliation note |
| Intent mismatch ("key search") | medium/medium | Copy targets puzzle solving and conversion/explanation |
| Legal exposure | low/medium | No custody, no advice, no recovery promise, privacy/terms pages |
| Ads/affiliate rejection | medium/low | No ads at launch; do not depend on ad revenue |
| CDN misconfiguration | medium/medium | Verify headers and cache key after deploy; purge on release |

Policy sources to cite in docs: Google Search Essentials and spam policies
(scaled content abuse, doorway pages, thin affiliate), Search Quality Rater
Guidelines for YMYL, and the BIP/EIP specifications for every explainer. This
document does not claim a guaranteed ranking or a guaranteed rich result.

## D11. Alternatives considered and rejected

- `/calculators/<tool>` prefix: cleaner grouping, but `/key` is live and
  linked; the redirect and re-index cost buys only a cosmetic hierarchy.
- Per-key/per-address generated pages: rejected on policy and harm grounds
  (D7).
- Client-side meta injection via JS for canonical/description: search engines
  may ignore it; metadata must be in the served HTML.
- Moving all static content to Pages now: splits the origin, adds routing and
  CORS work before there is traffic to justify it.
- `hreflang` now: no second locale.
- `noindex` on calculators: defeats the goal.

## D12. Phasing

- v1 (foundations + live calculators): 404/301 normalization, metadata on
  live pages, breadcrumbs, sitemap/robots, cache headers, asset versioning,
  analytics, Search Console.
- v2 (account/utility surfaces): `/me`, `/app`, `/run`, `/status` noindex and
  excluded from the sitemap; docs split into `/docs/<topic>`; legal pages.
- v3 (programmatic explainers + CDN): `/chains/**` explainers under the
  quality gate; decide Pages migration; optional `/mnemonic` after safety
  review; optional `/convert`, `/wif`.

Implementation order and verification are in `tasks.md`.
