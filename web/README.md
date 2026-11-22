# web/ — Astro frontend (phase 0-2)

Static Astro build for the public site. Phase 1 migrated `/mnemonic-converter`;
phase 2 adds the shared `SiteLayout` and the landing page (`/`). The Rust
coordinator keeps serving every route until the later phases in
`openspec/changes/frontend-platform/proposal.md`.

## Commands

```sh
npm ci
npm run check     # astro check + tsc --noEmit
npm run build     # static output in dist/, then /a/<build>/ asset prefixing
npm run preview -- --port 4321
npm test          # tsc -p tsconfig.test.json + node --test (no browser)
npm run verify:cdp -- --base http://127.0.0.1:4321   # browser parity + screenshots
```

Node 22.23.4+ (Astro 7.4.13). Dependencies are pinned exactly and
`package-lock.json` is committed; use `npm ci`.

The owner's brief said Node 20+. Astro 5.18.2 was the Node-20 line, but it
carries open high/critical advisories (`npm audit`: Astro XSS/SSRF and a sharp
AVIF RCE, fixed only in 7.2.8+). The pilot pins Astro 7.4.13 and raises the
engine floor instead of shipping a known-vulnerable build tool; this is the
only deviation from the brief and is called out in the PR.

## Layout

| Path | Purpose |
|---|---|
| `src/layouts/SiteLayout.astro` | Shared static shell: header/nav/footer, skip link, metadata, OG/Twitter, JSON-LD slot. Active nav is computed at build time. |
| `src/scripts/theme-init.js` | Deferred pre-paint theme bootstrap; adds `.js` so the narrow-screen nav can collapse. |
| `src/scripts/site-shell.ts` | The only hydrated islands: theme toggle and mobile nav disclosure. |
| `src/styles/site-shell.css` | Shell additions and landing layout rules, all consuming the tokens generated into `/site.css`. |
| `src/pages/index.astro` | Landing page; content-equivalent to the live `/`, with static chain/tool/database links and no live counters. |
| `src/pages/mnemonic-converter.astro` | The pilot page: same markup and copy as `apps/site/mnemonic-converter.html`, now on `SiteLayout`. |
| `src/pages/sitemap.xml.ts` | Sitemap for the routes this static build owns (`/`, `/mnemonic-converter`). |
| `src/components/JsonLd.astro` | The only JSON-LD writer. |
| `src/lib/site.ts` | Site origin, nav order/icons and the build-time active-section mapping. |
| `src/lib/build-id.ts` | Footer build id (`ROTOR_BUILD_ID`, else short git SHA). |
| `src/assets/og-landing.png` | 1200×630 social card used by `og:image`/`twitter:image`. |
| `src/scripts/mnemonic-converter.ts` | DOM glue ported from `apps/site/seed-page.js` (rendering, balances, CSV, generation). |
| `src/lib/seed-core.ts` | DOM-free derivation/validation core, unit- and parity-tested under Node. |
| `public/` | Byte copies of the current site assets, served at their current URLs. |
| `public/vendor/` | Byte copies of the crypto engine loaded by the page. |
| `tests/` | Node tests: fixed vectors from `apps/site/seed-test.mjs` and `apps/site/mnemonic-seeds-test.mjs`. |
| `scripts/cdp-parity.mjs` | Headless-browser check: convert two fixed phrases at 375/768/1280 light/dark, compare addresses, save screenshots. |
| `scripts/build-prefix.mjs` | Post-build step: copies the output under `a/<build>/` and rewrites every absolute asset reference, matching the coordinator's immutable asset URLs. |

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

The pilot page loads `/chains.generated.js` and `/amount.js` before `/site.js`,
mirroring the coordinator's injection order: `site.js` reads the generated
`window.RotorChains` / `window.RotorProviders` globals and `window.RotorAmount`.
The vendored WalletConnect and TON bundles are deliberately not copied; the
reason for each is in `data/vendor.lock.json` (`nonCopies`).

`rotor_wasm.wasm` is a generated artifact: after `sh scripts/build-wasm.sh`
rebuilds `apps/site/rotor_wasm.wasm`, run
`node scripts/gen-ssot.mjs --vendor-lock` to copy it and refresh the digest (the
pilot keeps two copies until phase 6 removes the embedded site). Do not
hand-edit it.

## Behaviour notes

- The page loads `/vendor/seed.js`, `/vendor/seed-crypto.js` and
  `/rotor_wasm.wasm` exactly where the current page does. Derivation, WIF and
  address encoding still come from the same code.
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
  the deferred theme bootstrap (601 B gzip) and the shell island bundle (882 B
  gzip).
- The shared shell is the one header/footer source. The pilot no longer carries
  its own copy, and it uses the layout's static theme toggle, skip link, active
  nav state and narrow-screen disclosure instead of `theme.js` plus `site.js`
  nav splitting.
- `assetsInlineLimit: 0` keeps every script a same-origin file. The CSP plan
  allows `script-src 'self'`; an inlined module or `data:` URL would violate it
  even when it is smaller.
- UI copy, CSS and fonts are unchanged from the current site; only the shell
  behaviour above is new. This phase does not restyle the current design.
