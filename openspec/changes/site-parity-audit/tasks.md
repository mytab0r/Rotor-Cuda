# Tasks

## P0 — interaction parity

- [ ] Brainwallet directory: `/brainwallet` index + 18 chain listings, 60 rows
  × 315 pages, auto addresses/balances, two copy icons per row, BTC type tabs,
  First/Prev/Random/Next/Last + Jump.
- [ ] Brainwallet single calculator on `/brainwallet-generator` with network,
  passphrase, 1/3/5/10 addresses, Copy All/CSV.
- [ ] Seed rows: private key/WIF + copy icons; compact reveal for the phrase.
- [ ] Puzzle home: 160-row table, All/Solved/Unsolved filters, search,
  Balance/TX/Actions.
- [ ] Puzzle random: Community Hunt counters and a live result table.
- [ ] `/richest` + `/richest/<chain>` top-100 with type filter, search, copy and
  explorer.
- [x] BTC/EVM transaction decoders (`/tx/bitcoin`, `/tx/ethereum`).
- [ ] Top-level `/send/<chain>` for BTC/ETH testnet, reusing the cabinet signing
  core; mainnet stays gated.
- [ ] `/key` debounced auto-derive, icon-only utility actions, full formats and
  counters.
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

## Shared Cloudflare Worker balance cache (next step, not in the client-cache PR)

The pages now keep a client-side IndexedDB cache in `apps/site/balance-cache.js`
(provider + chain + address; BTC/other 60 s, EVM 30 s). The next step moves the
same contract behind the edge so many visitors share one upstream read:

- [ ] Add `GET /api/v1/balances?provider=<id>&chain=<slug>&addresses=<csv>` to
      the CF Worker. It accepts public addresses only; reject any request with
      a key, WIF, seed or passphrase field, and cap `addresses` at 60.
- [ ] Cache key `balance:<provider>:<chain>:<address>` in the Worker Cache API
      (or D1 for persistence), with the same TTLs: BTC and non-EVM providers
      60 s, EVM 30 s. Store `{value, fetchedAt, source}`; never store errors as
      success.
- [ ] Origin remains the upstream fetcher; the Worker does not proxy arbitrary
      URLs. Allowlist each provider host, add a 5 s connect / 10 s read budget,
      per-IP rate limit and a 10k-entry cap.
- [ ] Return per-address `error` fields instead of failing the whole batch.
      Pass 429/5xx through so the client keeps the per-row error and retry
      icon; the client cache remains the display source and is advisory-only.
- [ ] Keep `/api/v1/lease|result|heartbeat` on the origin; the Worker never
      accepts a private key. Measure upstream request count before/after.

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
