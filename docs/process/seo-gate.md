# SEO gate for the chain directories, their hubs, the presentation pages, the puzzle pages and the 404 page

`scripts/check-seo.mjs` reads the built `web/dist` tree and fails when a
prerendered directory page or hub, one of the presentation pages (`/docs`,
`/tools`, `/faq`, `/disclaimer`, `/donate`), the `/bitcoin-puzzle` hub, one of
its `/bitcoin-puzzle/<n>` detail pages, the sitemap or the root `404.html`
breaks the contract measured in the SEO audit:

- the `/private-keys` hub and its 18 `/private-keys/<chain>` pages;
- the `/mnemonic-seeds` hub and its 18 `/mnemonic-seeds/<chain>` pages;
- the `/bitcoin-puzzle` hub and its 160 `/bitcoin-puzzle/<n>` pages;
- the `/docs` and `/tools` presentation pages;
- the `/faq`, `/disclaimer` and `/donate` pure-content pages;
- `sitemap.xml` and the root `404.html`.

It is wired into `.github/workflows/rust.yml` as the `web-seo` job and needs no
dependencies or network.

The puzzle pages read `data/puzzles.json`, which reproduces the
`PUZZLE_TARGETS` table in `src/coordinator/puzzles.rs` row for row.
`web/tests/puzzles.test.ts` parses the Rust table and fails when the two drift.

## Rules

| Detector | Rule |
|---|---|
| `seo-page-set` | Exactly the 18 mainnet slugs from `data/chains.json` are built in each family; both hubs, the five presentation pages and the `/bitcoin-puzzle` hub are present; the built puzzle detail pages are exactly the 160 numbers in `data/puzzles.json`; no missing or extra page. |
| `seo-metadata-bounds` | Title 50–60 characters ending in `\| Crypto`; description 120–160 characters. Directory chain titles start with the chain name and descriptions carry at least one digit. A private-key hub title is at most 60 and starts with “Private keys by chain”; a seed hub title starts with “Mnemonic seeds by chain”; each hub description names the 18 chains. The puzzle hub title is at most 60 and starts “Bitcoin puzzle browser”; its description names the 160-puzzle count. A puzzle detail title names its `#<n>` and its description carries the target address. Presentation pages share the 50–60 title and 120–160 description bounds. |
| `seo-canonical-robots` | Canonical is the page's own `https://rotor.pxbt.app` URL (`/private-keys`, `/private-keys/<slug>`, `/mnemonic-seeds`, `/mnemonic-seeds/<slug>`, `/docs`, `/tools`, `/faq`, `/disclaimer`, `/donate`, `/bitcoin-puzzle`, `/bitcoin-puzzle/<n>`) and robots is `index,follow`. A puzzle detail page whose data row cannot carry a valid target is rendered `noindex` and must not be in the sitemap. |
| `seo-duplicate-metadata` | No two checked pages (either family's chain pages, either hub, the puzzle hub, every puzzle detail page and every presentation page) share a title or a description. |
| `seo-hidden-heading` | One visible H1 and no visually-hidden H1. A private-key page's H1 is exactly `<Chain> private keys`; a seed page's is `<Chain> seed phrases`; the private-key hub's is `Private keys by chain`; the seed hub's is `Mnemonic seeds by chain`; the puzzle hub's is `Bitcoin puzzle`; a puzzle detail page's is `Bitcoin puzzle #<n>`. A directory chain page or hub needs at least two visible content H2s inside `data-seo-prose`; a puzzle page needs at least two content H2s; `/docs` needs at least three; `/tools`, `/faq`, `/disclaimer` and `/donate` at least two. |
| `seo-toc-anchor` | On `/docs`: the `data-docs-toc` TOC exists, every TOC href resolves to an existing id, every content H2 has an id and an entry, ids are unique, and there are at least three TOC anchors. Any `#fragment` link on a presentation page must resolve. |
| `seo-internal-link` | Every root-relative `<a href>` in a directory page's or hub's main content targets a page or file that exists in `dist`, an entry in the explicit `pendingCutover` map, or one of the two pending chain prefixes (the key calculator `/key/<hex>` and directory page 2+, both still served by the coordinator). Puzzle pages use the same exact `pendingCutover` maps. On a presentation page the same contract applies without the chain prefixes. |
| `seo-pending-cutover` | Every `pendingCutover` and `pendingChainPrefixes` entry carries a non-empty reason; an exact `pendingCutover` target that now exists in `dist` fails until it is removed. |
| `seo-hub-links` | Each hub is built, links all 18 chain pages from `data/chains.json`, and every internal link in its main content resolves to a built file in `web/dist`. The puzzle hub links every one of its 160 detail pages and resolves every internal link. |
| `seo-rendered-rows` | At least 40 rendered chain rows are present in a chain page's initial HTML, not built by JavaScript: `<tr data-key>` on `/private-keys`, `<tr data-seed>` on `/mnemonic-seeds`. |
| `seo-prose-uniqueness` | At least 120 unique prose words per chain page, and 5-gram Jaccard similarity below 0.50 between every pair of chain pages in the same family. The shared safety block is outside `data-seo-prose` and is not part of the comparison. |
| `seo-structured-data` | Every `application/ld+json` block parses. Both families' chain pages contain `CollectionPage` + `BreadcrumbList`; each hub adds an `ItemList` whose `numberOfItems` is the 18-chain count; the puzzle hub contains `CollectionPage` + `ItemList` + `BreadcrumbList`; a puzzle detail page contains `WebPage` + `BreadcrumbList`; `/docs` contains `TechArticle` + `BreadcrumbList`; `/tools` contains `CollectionPage` + `BreadcrumbList`; `/faq` contains `FAQPage` + `BreadcrumbList`; `/disclaimer` and `/donate` contain `BreadcrumbList`. |
| `seo-og-image-alt` | `og:image` is present. Directory chain pages name the chain in `og:image:alt` / `twitter:image:alt`; each hub describes itself and its chain count; a puzzle detail page names its target; every presentation page carries both alt values. |
| `seo-puzzle-rows` | The `/bitcoin-puzzle` hub table declares `data-puzzle-count` equal to the dataset count and renders exactly one row per puzzle, in number order. |
| `seo-puzzle-data` | Every hub row and detail page matches `data/puzzles.json` on number, target address and solved flag; every detail page renders the dataset's inclusive `2^(n-1)..2^n-1` hex range; copy controls carry only the target or the two range values. |
| `seo-puzzle-fabricated-key` | No puzzle page presents a 64-hex value as a private key or carries a private-key data attribute. The dataset never contains a key, so any rendered one is fabricated. |
| `seo-puzzle-sitemap` | `sitemap.xml` lists the `/bitcoin-puzzle` hub and exactly the indexable puzzle detail pages; a page the build renders `noindex` must not appear. |

| `seo-not-found` | The deploy root ships `404.html` with `noindex`, no hidden H1 and exactly one visible H1. Without the file Cloudflare Pages answers 200 with the landing page for an unknown path. |

## The pendingCutover allowlist

`/docs`, `/tools`, `/faq`, `/disclaimer` and `/donate` are the presentation
pages in the static build. Some routes they link to are still served by the Rust
coordinator (the key explorer, seed tools, brainwallet and the remaining
calculators), so the checker keeps those exact paths in one in-file
`pendingCutover` map with a written reason and the frontend-platform phase that
owns the move. The map is shrink-only: a route whose page is now built fails as
a stale entry until it is removed. Do not add a path without a reason, and do not
replace the list with a wildcard or a "skip external" rule.

Directory chain pages also link to two coordinator families the static build
cannot enumerate: the key calculator (`/key/<hex>`) and directory page 2+.
Those live in the separate `pendingChainPrefixes` map, each with a reason. A
single built chain route is never treated as pending: `/private-keys/<slug>`
and `/mnemonic-seeds/<slug>` are checked normally, so a typo in a chain link
still fails.

## Usage

```sh
npm --prefix web run build
node scripts/check-seo.mjs
node scripts/check-seo.mjs --dist path/to/other/dist --json report.json
```

Exit codes: `0` pass, `1` violations, `2` harness error (for example a missing
build tree).

## Mutation check

The gate is only useful if it fails. To prove a rule locally, copy `web/dist` to
a temporary directory, mutate one file, and run the gate against the copy with
`--dist`:

```sh
cp -r web/dist /tmp/rotor-seo-mutated
# remove a heading, shrink a title, break a TOC href, add an unknown internal
# link, duplicate two pages' metadata, corrupt a JSON-LD block, delete a puzzle
# row, change a puzzle target or solved flag, add a 64-hex "private key", or
# drop a puzzle loc from sitemap.xml
node scripts/check-seo.mjs --dist /tmp/rotor-seo-mutated
```

A mutation that removes the H1, truncates a title below 50 characters, deletes
the rendered rows, copies one chain's prose into another, points a docs TOC
anchor at a missing id, links to an unbuilt route that is not allowlisted,
duplicates a title or description, drops the `FAQPage` node from `/faq`,
corrupts JSON-LD, deletes a puzzle row, flips a puzzle's solved flag, renders a
wrong range value, appends a fabricated private key, or removes an indexable
puzzle detail page from the sitemap must make the gate exit `1` with the
matching detector id. The PR records at least three such mutations and their
output.

## Scope

This gate covers both hubs and page 1 of both directories, the `/docs`,
`/tools`, `/faq`, `/disclaimer` and `/donate` presentation pages, the
`/bitcoin-puzzle` hub and all 160 `/bitcoin-puzzle/<n>` detail pages, the
sitemap, and the root 404 document. Pages 2+ remain noindex and are served on
demand, as `data/routes.json` records. The pages are built in `web/dist` but are
not routed through the coordinator until the frontend-platform cutover.
