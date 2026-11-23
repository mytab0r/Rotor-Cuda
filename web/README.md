# web/ — Astro frontend (phase 0-4)

Static Astro build for the public site. Phase 1 migrated `/mnemonic-converter`;
phase 2 adds the shared `SiteLayout` and the landing page (`/`), then the
presentation pages `/docs`, `/tools`, `/faq`, `/disclaimer` and `/donate`; phase
3 adds the `/private-keys/<chain>` page-1 template for all 18 mainnet chains;
phase 4 adds the `/mnemonic-seeds` hub and its 18 chain pages, and the
`/bitcoin-puzzle` hub and its 160 `/bitcoin-puzzle/<n>` detail pages. Every page
is built in `dist/` but **not routed**: the Rust coordinator keeps serving the
route until the frontend-platform cutover, and `data/routes.json` still names
the coordinator as the renderer.

## Commands

```sh
npm ci
npm run check     # astro check + tsc --noEmit
npm run build     # static output in dist/, then /a/<build>/ asset prefixing
npm run preview -- --host 127.0.0.1 --port 4321
npm test          # tsc -p tsconfig.test.json + node --test (no browser)
node ../scripts/check-seo.mjs   # after build: chain, presentation, puzzle and 404 SEO gate
node ../scripts/ui-audit.mjs --base http://127.0.0.1:4321 --routes docs,tools,faq,disclaimer,donate,bitcoin-puzzle,bitcoin-puzzle/71,bitcoin-puzzle/72,bitcoin-puzzle/160
npm run verify:cdp -- --base http://127.0.0.1:4321   # browser parity + screenshots
npx playwright install chromium   # once per machine
npm run test:e2e                  # build + Playwright E2E, axe and visual baselines
npm run test:e2e:update           # rebuild and rewrite the visual baselines
```

Node 22.23.4+ (Astro 7.4.13). Dependencies are pinned exactly and
`package-lock.json` is committed; use `npm ci`.

## Browser regression tests (Playwright)

`npm run test:e2e` builds `dist/` and runs three suites in real Chromium
against `scripts/serve-dist.mjs`, a zero-dependency local server on
`127.0.0.1:4391`. The suite never reaches the internet: an auto fixture
overrides `navigator.doNotTrack` and aborts any request whose host is not the
local dist server, failing the test in teardown if one is attempted.

| Project | Viewport | Colour scheme |
|---|---|---|
| `mobile-375-{light,dark}` | 375×812 | light / dark |
| `tablet-768-{light,dark}` | 768×1024 | light / dark |
| `desktop-1280-{light,dark}` | 1280×900 | light / dark |

Coverage is the twelve routes this static build owns: `/`, `/private-keys/`,
`/private-keys/bitcoin/`, `/mnemonic-seeds/`, `/mnemonic-seeds/ethereum/`,
`/bitcoin-puzzle/`, `/bitcoin-puzzle/1/`, `/docs/`, `/tools/`, `/faq/`,
`/disclaimer/` and `/donate/`. Every project asserts the exact `<title>` and
single H1, the expected table row count (`60` keys, `60` seeds, `160` puzzles,
`18` hub rows), no document-level horizontal overflow, and that the requested
colour scheme was applied. The narrow-screen navigation test proves there is
exactly one toggle, the menu opens, Escape closes it and focus returns to the
trigger; at 1280 the toggle is hidden and the full nav is visible.

`@axe-core/playwright` scans each page in each project. Critical and serious
findings fail the build; there is no page allowlist. The two real findings the
first run exposed were fixed in the shared source: in-text links are now
underlined (`link-in-text-block`) and `.address-link` uses the theme-aware
`--text-2` instead of the dark-only `#c8d8ea` (`color-contrast` in light
mode). The `/docs/` code blocks are focusable scroll regions
(`scrollable-region-focusable`).

### Visual baselines

`toHaveScreenshot` stores one PNG per route and project under
`web/tests/__screenshots__/<platform>/<project>/<route>.png`, plus
`<route>-table.png` for the six routes with a data table. Baselines are per
platform (`win32`, `linux`) because text rasterisation differs between Windows
and the Linux CI runner by more than a small tolerance; each set is reviewed
and committed. They are deterministic test fixtures, not evidence: they are
the only images allowed under `web/tests/` (`scripts/check-screenshots.mjs`
enforces it), and UI run evidence still belongs in the CI artifact. The footer
build id is masked because it changes on every commit, and the comparison
allows a 0.5% pixel ratio inside one platform.

Update the baselines deliberately after a reviewed visual change:

```sh
npm run test:e2e:update
git add tests/__screenshots__
```

On Windows that writes the `win32` set. Regenerate the `linux` set in the same
image the CI runner uses (the browser and fonts are already installed there):

```sh
docker run --rm -v "$PWD/..:/work" -w /work/web \
  mcr.microsoft.com/playwright:v1.65.1-noble \
  node node_modules/@playwright/test/cli.js test \
  tests/e2e/visual.spec.ts --update-snapshots
```

A failing CI run uploads `playwright-report/` and `test-results/` (HTML
report, traces, actual/expected/diff images) as the
`playwright-report-<run id>` artifact. Playwright retries once
(`retries: 1`) to absorb browser timing, not to hide a real diff.

The owner's brief said Node 20+. Astro 5.18.2 was the Node-20 line, but it
carries open high/critical advisories (`npm audit`: Astro XSS/SSRF and a sharp
AVIF RCE, fixed only in 7.2.8+). The pilot pins Astro 7.4.13 and raises the
engine floor instead of shipping a known-vulnerable build tool; this is the
only deviation from the brief and is called out in the PR.

## Layout

| Path | Purpose |
|---|---|
| `src/layouts/SiteLayout.astro` | Shared static shell: header/nav/footer, skip link, metadata, OG/Twitter, JSON-LD slot. Active nav is computed at build time. |
| `src/scripts/theme-init.js` | Pre-paint theme bootstrap (same-origin, blocking); reads the key from the `data-theme-key` attribute and adds `.js` so the narrow-screen nav can collapse. |
| `src/scripts/site-shell.ts` | The only hydrated islands: theme toggle, mobile nav disclosure and the shared `[data-tooltip]` primitive. |
| `src/styles/site-shell.css` | Shell additions and landing layout rules, all consuming the tokens generated into `/site.css`. |
| `src/pages/index.astro` | Landing page; content-equivalent to the live `/`, with static chain/tool/database links and no live counters. |
| `src/pages/docs/index.astro` | Documentation reading surface: one H1, an anchored H2/H3 TOC, the legacy docs copy, and `TechArticle` + `BreadcrumbList` JSON-LD. No client script and no WASM. |
| `src/pages/tools/index.astro` | Tool hub: eight families, one row per tool at its canonical route, and `CollectionPage` + `BreadcrumbList` JSON-LD. No client script and no WASM. |
| `src/pages/faq/index.astro` | The nine legacy Q&A pairs verbatim, hub and site links, and `FAQPage` + `BreadcrumbList` JSON-LD built from the same visible copy. No client script and no WASM. |
| `src/pages/disclaimer/index.astro` | The five legacy limitation sections verbatim and `WebPage` + `BreadcrumbList` JSON-LD. No client script. |
| `src/pages/donate/index.astro` | The three maintainer addresses with human labels and shared `.icon-button` copy controls, plus the hosted payment link. Reuses `chain-copy.ts`; no QR and no new dependency. |
| `src/pages/404.astro` | Root `404.html`: one H1, `noindex,follow`, links to home, the key explorer, private keys, docs and the wallet. Cloudflare Pages returns a real 404 status only when this file exists at the deploy root. |
| `src/pages/private-keys/[chain].astro` | Chain directory page 1 for the 18 mainnet slugs; built but not routed until cutover. |
| `src/pages/bitcoin-puzzle/index.astro` | Puzzle hub: all 160 public targets with address type, range, solved status and a copy control; built but not routed until cutover. |
| `src/pages/bitcoin-puzzle/[puzzle].astro` | One static detail page per puzzle: target, status, inclusive range, keyspace and the honest derivation explanation. Unsolved pages render no key. |
| `src/lib/puzzles.ts` | Typed view of `data/puzzles.json`, the `2^(n-1)..2^n-1` range arithmetic, the indexability rule and the bounded title/description builders. |
| `src/pages/mnemonic-seeds/index.astro` | Hub for the 18 seed directories: chain list from `data/chains.json`, path/format counts, three content H2s and `CollectionPage` + `ItemList` + `BreadcrumbList` JSON-LD. |
| `src/pages/mnemonic-seeds/[chain].astro` | Seed directory page 1 for the 18 mainnet slugs: 60 deterministic 12-word phrases, the first address in every supported format, a shared safety block and static balance placeholders. Built but not routed until cutover. |
| `src/content.config.ts`, `src/content/chains/*.md`, `src/content/seeds/*.md` | One Markdown entry per chain per family: unique prose, content H2s, title and description. |
| `src/lib/chain-directory.ts` | Build-time derivation: drives the existing WASM `derive_report` ABI for keys 1–60 and maps report ids to each chain's address formats. |
| `src/lib/seed-directory.ts` | Build-time mnemonic derivation: BIP39 entropy → phrase → BIP32 or SLIP-0010 → WASM address, reusing `apps/site/seed.js`, `apps/site/seed-crypto.js` and the browser TON encoder. |
| `src/lib/wasm-core.ts`, `src/lib/address-codecs.ts` | The one WASM loader/`derive_report` bridge and the one Bitcoin Cash CashAddr bridge shared by both directories. |
| `src/lib/chains.ts` | Typed view of `data/chains.json`: the 18 mainnet chains in canonical order. |
| `src/scripts/chain-copy.ts` | The only hydrated behaviour on the directory and donate pages: copy a value with the shared check-glyph and `is-copied` state and a live status message. |
| `src/pages/mnemonic-converter.astro` | The pilot page: same markup and copy as `apps/site/mnemonic-converter.html`, now on `SiteLayout`. |
| `src/pages/sitemap.xml.ts` | Sitemap for the routes this static build owns (`/`, `/bitcoin-puzzle` and its indexable detail pages, `/disclaimer`, `/docs`, `/donate`, `/faq`, `/mnemonic-converter`, `/mnemonic-seeds` and its 18 chain pages, `/tools`, and the 18 private-key chain pages). |
| `src/components/JsonLd.astro` | The only JSON-LD writer. |
| `src/lib/jsonld.ts` | BreadcrumbList and WebPage builders shared by the presentation pages. |
| `src/lib/site.ts` | Site origin, nav order/icons and the build-time active-section mapping. |
| `src/lib/build-id.ts` | Footer build id (`ROTOR_BUILD_ID`, else short git SHA). |
| `src/assets/og-landing.png` | 1200×630 social card used by `og:image`/`twitter:image`. |
| `src/scripts/mnemonic-converter.ts` | DOM glue ported from `apps/site/seed-page.js` (rendering, balances, CSV, generation). |
| `src/lib/seed-core.ts` | DOM-free derivation/validation core, unit- and parity-tested under Node. |
| `public/` | Byte copies of the current site assets, served at their current URLs. |
| `public/vendor/` | Byte copies of the crypto engine loaded by the page. |
| `tests/` | Node tests: fixed vectors from `apps/site/seed-test.mjs` and `apps/site/mnemonic-seeds-test.mjs`. |
| `tests/e2e/` | Playwright specs: route contract, navigation disclosure, axe scan and visual regression. |
| `tests/__screenshots__/` | Committed `toHaveScreenshot` baselines, one directory per Playwright project. |
| `playwright.config.ts` | Three viewports × light/dark, retries 1, the local dist server and the baseline path template. |
| `scripts/serve-dist.mjs` | Zero-dependency static server for `dist/` used by the Playwright `webServer`. |
| `scripts/cdp-parity.mjs` | Headless-browser check: convert two fixed phrases at 375/768/1280 light/dark, compare addresses, save screenshots. |
| `scripts/build-prefix.mjs` | Post-build step: copies the asset files under `a/<build>/` and rewrites every absolute asset reference, matching the coordinator's immutable asset URLs. HTML and sitemap are not copied into the prefix. |

## Chain directory (built, not routed)

`npm run build` emits `/private-keys/<slug>/index.html` for the 18 mainnet
slugs from `data/chains.json`. Each page has a visible H1, unique Markdown
prose with two content H2s, one shared safety block, and 60 deterministic
example keys. The table is server-rendered: the build calls the same
`rotor_wasm.wasm` `derive_report` ABI the browser uses, once per key, and maps
the report ids to that chain's formats (Bitcoin and Litecoin four, Bitcoin Cash
two, every other chain one). There is no second crypto implementation; the
Bitcoin Cash CashAddr view reuses `apps/site/address-codecs.js`.

The page links to the coordinator's later pages and to `/key/<hex>` for the
calculator, but no coordinator route changes in this phase. Balance cells are
reserved placeholders, not live queries. `node ../scripts/check-seo.mjs` reads
`dist/` and enforces the measured contract: title 50–60, description 120–160,
canonical and `index,follow`, one visible H1, at least two content H2s, at
least 40 rendered rows, ≥120 unique prose words, pairwise 5-gram Jaccard below
0.50, `CollectionPage` + `BreadcrumbList`, and chain-named OG alt text. It also
requires `dist/404.html` with `noindex` and exactly one H1, so the deploy root
can never fall back to a 200 landing page for an unknown path.

## Mnemonic seed directory (built, not routed)

`npm run build` also emits `/mnemonic-seeds/<slug>/index.html` for the 18
mainnet slugs, plus the `/mnemonic-seeds` hub. Each page starts from the first
60 values of the 128-bit BIP39 entropy space, turns each value into a 12-word
phrase, and derives the first address in every format that chain supports:
Bitcoin at BIP44/BIP49/BIP84/BIP86, Litecoin at BIP44/BIP49/BIP84, Bitcoin Cash
at BIP44 coin 145 with legacy and CashAddr views, the EVM chains at coin 60,
and Solana/Sui/TON with SLIP-0010 ed25519 at their wallet paths. BIP39 phrases,
PBKDF2 seeds and BIP32 keys come from `apps/site/seed.js` and
`apps/site/seed-crypto.js`; addresses come from the same WASM `derive_report`
ABI as the private-key directory. Balance cells are static placeholders with
reserved height. `check-seo.mjs` also gates the hub and the 18 seed pages with
the same metadata, heading, row-count, internal-link, prose-uniqueness and
structured-data rules.

## Docs and tools (built, not routed)

`/docs` is a reading surface, not a copy of the legacy card: one visible H1, a
keyboard TOC whose anchors are checked against the rendered ids, the legacy
claims restructured into H2/H3 sections, and `TechArticle` + `BreadcrumbList`
JSON-LD. `/tools` keeps the eight calculator families and links every tool at
its canonical route; it adds no counters and makes no availability claim.

Most tool routes are still served by the coordinator. `scripts/check-seo.mjs`
therefore keeps those exact targets in one in-file `pendingCutover` map with a
reason and the frontend-platform phase that owns the move. The rule is
shrink-only: when a tool page is built into `dist`, its entry must be removed.
A link outside the map that does not resolve in `dist` fails the gate.

## FAQ, disclaimer and donate (built, not routed)

`/faq` carries the nine legacy question/answer pairs verbatim and emits a
`FAQPage` node built from the same visible copy, so the structured data cannot
invent a Q&A. `/disclaimer` keeps the five limitation sections; `/donate` keeps
the three maintainer addresses and the payment link, and every address has a
human-readable label and a shared `.icon-button` copy control. The pages add no
counters, partners or guarantees, and `scripts/check-seo.mjs` applies the same
H1/H2, metadata, unique title/description, internal-link and JSON-LD rules as
`/docs` and `/tools`. Removing the three routes from `pendingCutover` is part of
the same change: the stale-entry rule forces the removal.

## Bitcoin puzzle (built, not routed)

`data/puzzles.json` is the build-time source. It reproduces the
`PUZZLE_TARGETS` table in `src/coordinator/puzzles.rs` row for row: 160 public
targets, 83 solved and 77 unsolved. `web/tests/puzzles.test.ts` parses the Rust
table and fails when the JSON drifts, so the coordinator and the Astro build
cannot silently disagree.

The hub renders one row per puzzle with the target address, address type, the
inclusive `2^(n-1)..2^n-1` range and the published solved flag. The dataset has
no reward, solver or date field, so neither the hub nor a detail page invents
one. Each detail page carries the target, the padded range hex, the decimal
keyspace and one explanation of why an address does not reveal its key; an
unsolved page states plainly that it holds no key and cannot derive one.

Indexability rule: a detail page is indexable only when its record carries a
well-formed public P2PKH target and a number inside the published set, and its
main prose clears the gate's 120-unique-word floor. Every current row passes, so
all 160 pages are indexable and listed in `sitemap.xml`; a future row that
cannot carry the facts would render `noindex` and stay out of the sitemap. The
gate cross-checks every row and page against `data/puzzles.json`, rejects a
rendered 64-hex private key, and fails when the sitemap and the indexable set
disagree.

The table uses the shared `.data-table` inside `.table-scroll`, the shared
`.status` pill and the shared `.icon-button--sm` copy action (28px dense visual
with a 44px hit area on a fine desktop pointer, 44px on touch). No page-local
control size, pill, radius or card override is introduced.

## Provenance of copied assets

`web/public/` holds copies of the current `apps/site/` assets. Vendored
identity is content after EOL normalization (CRLF folded to LF), not raw bytes,
so the same lock digest is valid on a Windows CRLF checkout and on Linux CI.
`data/vendor.lock.json` is the machine source for every pair: it records the
source path, target path and normalized SHA-256 of each copied file. Do not edit
a `web/public/` copy: edit `apps/site/` first, then run
`node scripts/gen-ssot.mjs --vendor-lock`. It regenerates the chain/provider
outputs, copies every locked pair into `web/public/` and rewrites the digests in
one step. `node scripts/check-ssot.mjs` fails when a copy drifts, when a locked
digest is stale, or when `web/public/` contains a file the lock does not cover.

| web/public file | Source |
|---|---|
| `vendor/seed.js` | `apps/site/seed.js` |
| `vendor/seed-crypto.js` | `apps/site/seed-crypto.js` |
| `site.css` | `apps/site/site.css` |
| `seed-studio.css` | `apps/site/seed-studio.css` |
| `site.js` | `apps/site/site.js` |
| `theme.js` | `apps/site/theme.js` |
| `chains.generated.js` | `apps/site/chains.generated.js` |
| `amount.js` | `apps/site/amount.js` |
| `icons.svg` | `apps/site/icons.svg` |
| `fonts/manrope-latin.woff2` | `apps/site/fonts/manrope-latin.woff2` |
| `rotor_wasm.wasm` | `apps/site/rotor_wasm.wasm` |
| `favicon.ico`, `favicon.png` | `apps/site/favicon.*` |

The pilot loads only `/vendor/seed.js` and `/vendor/seed-crypto.js`; the shared
layout owns the header, nav, theme and tooltips, and the derivation core owns
chain and amount data. `chains.generated.js`, `amount.js` and `site.js` stay in
`web/public/` as locked copies for the coordinator-served pages but are not
loaded by the Astro pilot. The vendored WalletConnect and TON bundles are
deliberately not copied; the reason for each is in `data/vendor.lock.json`
(`nonCopies`).

`rotor_wasm.wasm` is a generated artifact: after `sh scripts/build-wasm.sh`
rebuilds `apps/site/rotor_wasm.wasm`, run
`node scripts/gen-ssot.mjs --vendor-lock` to copy it and refresh the digest (the
pilot keeps two copies until phase 6 removes the embedded site). Do not
hand-edit it.

## Behaviour notes

- The page loads `/vendor/seed.js`, `/vendor/seed-crypto.js` and the
  build-prefixed `rotor_wasm.wasm` exactly where the current page does.
  Derivation, WIF and address encoding still come from the same code.
- Balances use the same public endpoints (`blockchain.info` for BTC, a public
  Ethereum JSON-RPC endpoint for EVM); only derived public addresses leave the
  page. The phrase, passphrase and keys stay in the tab and are not stored. The
  page reads the `/seed` handoff phrase once from `sessionStorage` under
  `rotor-seed-phrase` and removes it immediately, exactly like the current page.
- The page HTML uses `createElement`/`textContent`; there is no `innerHTML`
  with data. Source maps are disabled and not published.
- The landing loads no WASM and no coordinator API: chain cards come from
  `data/chains.json` at build time, and the dynamic totals/leaderboard link to
  the operator console instead of rendering stale numbers. Its only scripts are
  the pre-paint theme bootstrap (blocking, same-origin) and the shell island
  bundle. Both sizes are reported in the PR.
- The shared shell is the one header/footer source. The pilot no longer carries
  its own copy, and it uses the layout's static theme toggle, skip link, active
  nav state, tooltips and narrow-screen disclosure instead of `theme.js` plus
  `site.js`. The pilot no longer loads `site.js`, so only the layout's menu
  exists in the header.
- `assetsInlineLimit: 0` keeps every script a same-origin file. The CSP plan
  allows `script-src 'self'`; an inlined module or `data:` URL would violate it
  even when it is smaller.
- The shell follows the #399 density tier: 36px standard actions on a fine
  desktop pointer, 44px primary actions and the touch floor, and 28px dense row
  actions with a 44px hit area. Header nav/utility controls stay 44px per the
  documented one-row header exception.
- UI copy, CSS and fonts are unchanged from the current site; only the shell
  behaviour above is new. This phase does not restyle the current design.
