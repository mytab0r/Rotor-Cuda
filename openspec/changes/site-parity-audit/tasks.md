# Tasks

## P0 — interaction parity

- [x] Brainwallet directory: `/brainwallet` index + 18 chain listings, 60 rows
  × 315 pages, auto addresses/balances, two copy icons per row, BTC type tabs,
  First/Prev/Random/Next/Last + Jump. Evidence: `mod.rs:2291-2361`
  (60×315, pager, jump), `brainwallet-directory.js:209-219,596-610`
  (copy icons, type tabs), `brainwallet-directory.js:351-470` (balances).
- [x] Brainwallet single calculator on `/brainwallet-generator` with network,
  passphrase, 1/3/5/10 addresses, Copy All/CSV. Evidence: `mod.rs:2659-2700`,
  `brainwallet.js:457-503`.
- [x] Seed rows: private key/WIF + copy icons; compact reveal for the phrase.
  Each row starts as the first two and last word (`abandon ability … zoo`)
  behind a 44px `aria-expanded` Reveal/Hide button; expanding swaps the row's
  text in place (no re-render, refetch, storage or URL change) and collapsing
  restores the compact form. Evidence: `mnemonic-seeds.js:178-187,601-670`
  (`compactPhrase`, `renderPhrase`, `resetPhrase`), inline styles in
  `mnemonic-seeds.html:76-95`.
- [x] Puzzle home: 160-row table, All/Solved/Unsolved filters, search,
  Balance/TX/Actions. Evidence: `mod.rs:3260-3332`,
  `puzzle-browser.js:236-365`.
- [x] Puzzle random: Community Hunt counters and a live result table.
  Evidence: `mod.rs:3935-3947`, `puzzle-browser.js:367-432,864-886`.
- [ ] `/richest` + `/richest/<chain>` top-100 with type filter, search, copy and
  explorer. **Blocked: no dataset.** The repo has only gzip download mirrors
  (`src/coordinator/wallets.rs:34-40`); top-100 ranks/labels/balances require a
  licensed third-party dataset or API. Not faked.
- [x] BTC/EVM transaction decoders (`/tx/bitcoin`, `/tx/ethereum`).
- [x] Top-level `/send/<chain>` for BTC/ETH testnet, reusing the cabinet signing
  core; mainnet stays gated. Evidence: `apps/site/send.html` (one page on
  `/send`, `/send/bitcoin`, `/send/ethereum`), `apps/site/send.js` (testnet
  chain and endpoint gates, local derivation, sign-only and optional
  broadcast), `src/coordinator/mod.rs` (routes, embedded assets, sitemap),
  `apps/site/send-test.mjs` (mainnet WIF/RPC rejection and no-key-outbound
  proof), `tests/coordinator_api.rs` (three routes return 200 with TESTNET
  copy).
- [x] `/key` debounced auto-derive, icon-only utility actions, full formats and
  counters. Evidence: `key.js:211,569-575` (debounce),
  `key.html:69-76` (icon actions), `key-tools.js:304-321` (formats).
- [x] Global search results in place: interpret-as, 1/3/5/10 addresses, table,
  Copy All/CSV. Evidence: `apps/site/search-test.mjs` (detect modes, row
  shaping per chain, public-only CSV), `node --check` for `site.js`/`search.js`,
  and the `key` route UI audit at 375/1280 in both themes.

## P1 — shell and templates

- [ ] One filter bar (search + type + chain chips + reset), pager separate,
  stats in the table footer.
- [ ] Reusable icon-button (28/36/44, copied state), compact-row and
  skeleton/empty/error primitives.
- [ ] Header: 4 primary links + More/drawer at ≤860 px; icon-only search/theme.
- [ ] Tools index: 8 families with alias rows.
- [ ] Address types for BCH (legacy/CashAddr), TON (v4R2/W5), DOGE/ZEC
  compressed/uncompressed.
- [ ] Breadcrumbs on every page; consistent `aria-current`.
- [ ] Seed converter: live word counter, 20 addresses, Load next 5, Copy All.
- [ ] Vanity: threads/ETA/difficulty/save/recent; pubkey-add: P−Q and scalar
  multiply.

## Shared Cloudflare Worker balance cache

The client keeps a local IndexedDB cache (`apps/site/balance-cache.js`,
provider + chain + address; BTC/other 60 s, EVM 30 s). The edge worker lives in
`deploy/cloudflare` (PR #87, merged) and is tested but **not wired to the site
and not deployed**.

- [x] Cache key and TTLs, stale-while-revalidate, errors never stored as
      success: `deploy/cloudflare/src/cache.mjs`, `src/worker.mjs`; 35 tests.
- [x] Fixed provider allowlist (mempool.space, Tronscan, configured EVM RPCs),
      5 s timeout, per-provider token bucket, concurrency 4, one retry with
      backoff + jitter, secret-shaped body rejection:
      `deploy/cloudflare/src/providers.mjs`, `src/security.mjs`.
- [ ] Batch endpoint `GET /v1/balances?chain=&addresses=<csv>` (cap 60). The
      worker serves one address at a time today.
- [ ] Per-IP rate limiting. The current bucket is per provider per isolate, not
      a global or per-client quota.
- [ ] Client wiring + deploy. **Blocked: no valid Cloudflare credential**
      (`CF_PAGES_TOKEN` is rejected by the API); needs `wrangler login` or a
      Workers token. The site must keep calling providers directly until the
      worker is live, so no fake endpoint is wired.

## Verification

- [x] Durable UI self-review harness: `scripts/ui-audit.mjs` (zero-dep CDP,
      375/768/1280, dark/light, screenshots + JSON), project skill
      `.claude/skills/ui-self-review/SKILL.md`, wired into the UI gate and
      `projects.json` site build/test.
- [ ] `docs/site-map/index.html` updated for every completed row; no false parity.
- [ ] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
- [ ] `node scripts/check-projects.mjs`, site tests, cargo tests, clippy.

## Relocation to internal docs (done)

- [x] Move the parity map from the public site to `docs/site-map/`
  (`index.html`, `site-map.css`, `site-map.js`, `site-map-data.js`,
  `site-map-test.mjs`, local `icons.svg` and `theme.js`); relative assets only.
- [x] Drop `/site-map`, `/site-map.css`, `/site-map.js` and `/site-map-data.js`
  from the coordinator routes, embedded assets and sitemap; route tests and
  `/docs`/`/tools` links no longer reference the public path.
- [x] Run the data test from `docs/`: `node docs/site-map/site-map-test.mjs`.
