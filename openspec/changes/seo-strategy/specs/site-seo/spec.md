# Site SEO domain (delta)

## Added requirements

### Requirement: canonical URL scheme
Every served page MUST have exactly one canonical URL: absolute, lowercase,
extensionless, without a trailing slash and without a query string, rooted at
`https://rotor.pxbt.app`. The key MUST NOT appear in any URL, history entry or
storage. Query strings MUST NOT change HTML content; `?v=` is allowed only on
static asset URLs.

#### Scenario: key page canonical
- GIVEN a visitor derives a key on `/key` and shares the page
- WHEN the page is crawled
- THEN the canonical is `https://rotor.pxbt.app/key` and no key material is in
  the URL

#### Scenario: asset versioning
- GIVEN `/site.css?v=20261116` is requested
- WHEN the coordinator responds
- THEN the response is cacheable as an immutable versioned asset and the HTML
  canonical still has no query string

### Requirement: path normalization
Unknown non-API paths MUST return HTTP 404 with a not-found body. Trailing
slash, `/index.html`, uppercase and duplicate-host variants MUST redirect with
301 to the canonical form. The coordinator MUST NOT serve the landing page for
an unknown path.

#### Scenario: unknown path
- GIVEN `GET /does-not-exist`
- WHEN the coordinator handles it
- THEN the status is 404 and the body is not the landing page

#### Scenario: variant redirects
- GIVEN `GET /key/` or `GET /index.html`
- WHEN the coordinator handles it
- THEN the response is 301 to `/key` or `/` respectively

### Requirement: metadata contract
Every indexable page MUST serve, in the HTML, a unique non-empty `<title>`, a
`<meta name="description">`, one absolute `<link rel="canonical">` equal to its
canonical URL, and Open Graph/Twitter tags. Utility pages (`/app`, `/run`,
`/me`, `/status`) MUST be `noindex` and MUST NOT be in the sitemap.

#### Scenario: indexable page head
- GIVEN an indexable route from the route table
- WHEN the page is fetched without JavaScript
- THEN title, description, canonical and OG/Twitter tags are present and the
  canonical equals the table value

#### Scenario: cabinet
- GIVEN `GET /me`
- WHEN the page is fetched
- THEN its robots directive is `noindex,nofollow` and the sitemap excludes it

### Requirement: breadcrumbs
Every indexable page MUST show a visible breadcrumb (`nav aria-label="Breadcrumb"`
with an ordered list and `aria-current="page"` on the last item) and MUST emit
matching `BreadcrumbList` JSON-LD. The last JSON-LD item MUST equal the page
canonical. Breadcrumbs MUST mirror the URL tree.

#### Scenario: docs topic
- GIVEN `GET /docs/run-client`
- WHEN the page renders
- THEN the visible trail is Home > Docs > Running a client and the JSON-LD
  positions match it

### Requirement: structured data
Indexable pages MUST emit the structured data assigned to their type:
`WebSite` on `/`, `WebApplication` on calculators, `TechArticle` on docs and
chain explainers, and `BreadcrumbList` on every indexable page. `HowTo` and
`FAQPage` MAY be added only for genuine step/Q&A content and MUST NOT be
treated as a rich-result guarantee. Utility pages MUST NOT emit structured
data.

#### Scenario: calculator
- GIVEN `GET /key`
- WHEN the page is parsed
- THEN it contains a valid `WebApplication` object and a `BreadcrumbList`

### Requirement: sitemap and robots
The coordinator MUST serve `/sitemap.xml` and `/robots.txt` generated from the
same route table used for routing. The sitemap MUST contain exactly the
indexable canonical URLs, absolute and without query or redirects. `robots.txt`
MUST disallow `/api/`, `/app`, `/me`, `/run`, `/status`, MUST NOT disallow an
indexable page, and MUST link the sitemap.

#### Scenario: sitemap consistency
- GIVEN the route table
- WHEN `/sitemap.xml` is fetched
- THEN every listed URL returns 200 without redirect and every indexable route
  is listed

### Requirement: caching
HTML MUST be served `public, max-age=0, must-revalidate` with a validator or a
short shared-cache lifetime. Versioned static assets MUST be served
`public, max-age=31536000, immutable` only when every reference carries a
version; until the wasm and worker references are versioned, those two MUST use
a short lifetime. `/api/*` MUST be `no-store`.

#### Scenario: stale wasm prevention
- GIVEN a release that changes `rotor_wasm.wasm`
- WHEN a returning visitor loads `/key`
- THEN the page requests the new versioned artifact, not a cached old one

### Requirement: internal linking
Every indexable page MUST be reachable from `/` in at most two link hops and
MUST be linked from at least one contextual page. Calculators MUST expose a
"Related calculations" block. Anchors MUST be descriptive; there MUST be no
sitewide link farm.

#### Scenario: orphan check
- GIVEN a crawl starting at `/`
- WHEN all internal links are followed
- THEN every indexable sitemap URL is reached in <= 2 hops

### Requirement: content safety
The site MUST NOT publish an index or paginated list of real private keys,
derived addresses or balances, and MUST NOT target theft or recovery intent
("private key finder", "find lost bitcoin", "recover wallet"). Programmatic
explainer pages MUST use deterministic published test vectors, contain unique
explanation with a citation, and pass review before publication. Keys, seeds
and WIFs MUST NOT be received, logged or put into analytics.

#### Scenario: explainer gate
- GIVEN a proposed `/chains/<chain>/<format>` page
- WHEN it is reviewed
- THEN it has a worked published vector, unique body, citation and calculator
  link; otherwise it is not published

#### Scenario: no key index
- GIVEN any route, including a query variant
- WHEN it is requested
- THEN it does not enumerate real keys or addresses and does not echo a user
  key

### Requirement: measurement privacy
Analytics MUST load only on indexable pages and MUST record aggregate events
without keys, seeds, WIFs or addresses. Custom events MAY cover `derive`,
`check_balances`, `copy_address`, `broadcast` and `worker_start` with
non-secret properties only.

#### Scenario: event payload
- GIVEN a visitor presses "Calculate"
- WHEN the event is sent
- THEN it carries the curve/preset class only, never the key or an address
