# Frontend platform: split SEO frontend from the Rust coordinator

## Summary

Move every public HTML page to an Astro frontend (static + hybrid) served from
Cloudflare Pages/Functions over the existing CDN, and shrink the Rust
coordinator to an API-only service. The Rust/WASM crypto core stays exactly as
it is: derivation, signing and address encoding keep running in the browser
through `apps/site/rotor_wasm.wasm` built from `crates/rotor-wasm`.

Status: proposed. Evidence gathered 2026-11-21 from the current tree.

## Why

The coordinator renders HTML only because the pages are baked into the binary.
The rendering itself is static: none of the `render_*` functions read app state
or storage (`src/coordinator/mod.rs:2127-4460`, 21 functions, 1855 lines);
catalog keys are arithmetic (`:3048`, `:3129-3139`) and the brainwallet rows are
built in the browser (`:2892`). Keeping HTML in Rust costs a release of the
API for every copy change, prevents CDN caching, and leaves frontend structure
outside the tools that are good at it.

Measured problems in the current setup:

| Fact | Value | Source |
|---|---|---|
| First-party JS | 38 files, 30 248 lines, 1.17 MB | `apps/site/*.js` |
| `/key` transfer | 234.7 KB gzip | local gzip measurement |
| `site.js` on every page | 14.9 KB gzip | `apps/site/site.js` |
| Compression | none (no gzip/br) | `src/coordinator/mod.rs:692-721` |
| CSP / Referrer-Policy / CORS | no headers at all | grep over `mod.rs` |
| Private key in the URL | `canonical=/key/<hex>` and `window.__ROTOR_KEY__` | `:2192`, `:2217`, `:2090` |
| ES5 style | `key.js`: 440 `var`, 0 `let/const` | `apps/site/key.js` |
| Duplicate `formatUnits` | 6 implementations | `key.js:1904`, `site.js:389`, `tx-decoders.js:75`, `wallet-btc.js:63`, `wallet-evm.js:72`, `wallet.js:1297` |

## Decision

1. Public SEO pages move to Astro, prerendered where possible, on the edge.
2. `/api/v1/*` stays in Rust; the coordinator stops rendering public HTML after
   phase 6.
3. WASM core untouched, loaded on demand only by pages that derive or sign.
4. Routing stays same-origin: `rotor.pxbt.app/*` -> Pages, `rotor.pxbt.app/api/*`
   -> Worker proxy -> coordinator. No CORS, cookies `SameSite=Lax`.
5. Single-binary (Astro output embedded via `include_bytes!`) stays the fallback
   if the split proves operationally unacceptable.

## Route map

| Group | After | Indexing |
|---|---|---|
| Landing, docs, faq, disclaimer, donate, tools, converters, tx, vanity, milk-sad | Astro prerender | index |
| `/private-keys`, `/private-keys/<chain>` page 1, `/mnemonic-seeds*`, `/brainwallet` page 1, `/bitcoin-puzzle*`, curated `/keys/<chain>/1-64` | Astro prerender | index |
| Listing pages >= 2, `/keys/<chain>/<other>` | Astro `prerender=false`, same component | noindex |
| `/key/<hex>` | curated static (data/key-curated.json); other 64-hex keys worker-injected from the hub shell | curated index, others noindex |
| `/app`, `/run`, `/me`, `/cabinet`, `/cabinet/wallet` | Astro app shell calling the API | noindex |
| `/robots.txt`, `/sitemap.xml` | Astro endpoints | — |
| `/api/v1/*` | Rust, unchanged | — |

## Phases

| Phase | Content | Estimate |
|---|---|---|
| 0 | `web/` skeleton, `chains.json`/`puzzles.json` as shared source, `npm ci` + audit in CI, area in `projects.json` | 3-5 d |
| 1 | Pilot `/mnemonic-converter` (Astro + one island) | 4-6 d |
| 2 | Presentation pages and hubs (~27) | 8-10 d |
| 3 | `/key`, `/private-keys`, fragment key URL, CSP | 15-20 d |
| 4 | `/seed`, `/mnemonic-seeds`, brainwallet, puzzle | 10-14 d |
| 5 | App shell: `/app`, `/run`, `/me`, `/cabinet`, wallet, send | 20-28 d |
| 6 | Origin switch, 410 on Rust HTML, remove `include_str!` | 3-5 d |
| 7 | Delete ES5 scripts, update specs/docs/site-map | 3 d |

## Pilot acceptance

1. Route JS <= 45 KB gzip (today 71.9 KB JS-only on `/mnemonic-converter`).
2. `node scripts/ui-audit.mjs --base <preview>`: 0 violations, 204 runs.
3. LCP <= 1.5 s and INP <= 200 ms on mobile Lighthouse with a cold cache, or the
   equivalent CDP timing measurement.
4. Bit-identical parity: `seed-test.mjs`, `mnemonic-seeds-test.mjs`,
   `wallet-seed-test.mjs` and fixed phrase vectors produce the same addresses as
   the current page.
5. Screenshots 375/768/1280, light/dark, captured by a second agent per
   `AGENTS.md`.

## Security requirements

- Private-key pages keep the donor's legacy `/key/<hex>` path. Curated keys are
  static and indexable; every other 64-hex key is worker-injected with `noindex`
  and a per-key canonical, and the page states that the URL exposes the key to
  browser history and logs. The hub never puts a user-entered key in the path.
- CSP on every HTML response: `default-src 'self'; script-src 'self'
  'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data:; font-src 'self';
  connect-src 'self' <provider list>; frame-ancestors 'none'; base-uri 'none';
  form-action 'self'; object-src 'none'`.
- No `innerHTML` / `dangerouslySetInnerHTML` in first-party code; JSON-LD only
  through a component.
- Assets from the same origin only; no third-party CDN, no SRI needed.
- `package-lock.json` committed, `npm ci`, exact versions, `npm audit
  --audit-level=high` in CI; source maps not published (CI check).
- Keys and phrases never enter bundles, storage except the documented
  sessionStorage handoff, logs or URLs.

## Risks

- Bundle sizes above are estimates until the pilot measures them.
- Cloudflare Pages limits must be checked before phase 2.
- The `connect-src` provider list must be confirmed against a real build
  (WalletConnect and TON hosts are partly documentation links).
- Moving 1855 lines of Rust markup and 204 assertions is the main cost; the
  estimate carries +/-30%.
- Legacy `/key/<hex>` links keep leaking the key once, into access logs.

## Out of scope

- Redesign. The migration keeps the current visual system; the design-system
  process is a separate change (`openspec/changes/design-system-process`).
- Changes to the crypto core or to the job/order/monitor APIs.
