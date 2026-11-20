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
- [x] Seed rows: private key/WIF + copy icons; full phrase in the donor layout.
  The donor prints the whole mnemonic, so the earlier compact first-two/last-word
  reveal was dropped and each row shows the full phrase (mono, ellipsis with the
  phrase in `title`) plus a 44px Copy mnemonic button. Evidence:
  `docs/donor-parity/directories.md` §3 (row markup and difference 11);
  `apps/site/mnemonic-seeds.js` (`createRow`/`fillRow`: `col-mnemonic`,
  `mnemonic-text`, `phraseText.textContent = entry.phrase`),
  `src/coordinator/mod.rs` (directory assertions),
  `apps/site/mnemonic-seeds-test.mjs`.
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
- [x] BNB Smart Chain testnet builder (`/send/bnb`, PR #97). Evidence:
  `apps/site/send.js:72` (chain table, chapel chain id 97), `:55` and `:163`
  (BSC-testnet provider allowlist), `apps/site/send-test.mjs:671` (chain-id
  guard and mainnet-provider rejection). Testnet only; BSC mainnet is not
  claimed.
- [x] USDT / generic ERC-20 builder on Sepolia (`/send/usdt`, PR #97).
  Evidence: `apps/site/send.js:365` (`buildErc20Transfer`, canonical
  `transfer(address,uint256)` calldata), `apps/site/send-test.mjs:316`
  (pinned calldata vector) and `:725` (review wiring with value 0). The token
  contract is user-supplied; Sepolia has no canonical USDT deployment, so this
  is not a mainnet USDT claim.
- [x] TRON Nile testnet TRX transfer (`/send/tron`, this change). Evidence:
  `apps/site/send.js:84` (chain table), `:403` (`prepareTronTransfer`),
  `:451` (`signTronTransfer`), `apps/site/tron-tx.js` (Nile-only host/path
  gate), `crates/rotor-wasm/src/tron.rs:89` / `:101` and
  `crates/rotor-wasm/src/lib.rs:547` / `:567` (sign/unsigned exports),
  `apps/site/send-test.mjs:417` (TRX->sun), `:431` (prepare) and `:499`
  (sign/broadcast without a key leak), `src/coordinator/mod.rs:997` / `:1000`
  (route and embedded helper), `tests/coordinator_api.rs:1139` / `:1186`
  (six routes and the served helper). Nile testnet only: mainnet TRON hosts
  and the mainnet `tron` route are rejected, and no live broadcast was
  executed (no funded Nile key).

## P1 — shell and templates

- [ ] One filter bar (search + type + chain chips + reset), pager separate,
  stats in the table footer.
- [ ] Reusable icon-button (28/36/44, copied state), compact-row and
  skeleton/empty/error primitives.
- [ ] Header: 4 primary links + More/drawer at ≤860 px; icon-only search/theme.
- [ ] Tools index: 8 families with alias rows.
- [x] Address types: BCH legacy + CashAddr, DOGE compressed/uncompressed,
  ZEC transparent compressed/uncompressed. Evidence:
  `apps/site/address-codecs.js` (CashAddr + Base58Check encoders),
  `apps/site/key.js` (`attachComputedTypes`), `apps/site/address-codecs-test.mjs`
  (BCH spec translation vectors; DOGE/ZEC addresses independently reproduced
  with Python), UI audit on `/key` and `/key/<key1>` at 375/768/1280 in both
  themes.
- [ ] TON v5/W5 address type. **Blocked:** needs a verified W5 contract-cell
  implementation (StateInit/BoC hashing); v4R2 already ships. No unverified
  address encoder was added.
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
- [x] `docs/site-map/index.html` updated for every completed row; no false parity.
  Evidence: send rows now point at `/send/bitcoin` and `/send/ethereum`
  (partial, testnet-only), the six key rows and `key-page-flow` describe the
  shipped counters/Copy All/CSV instead of claiming they are absent;
  `site-map-test.mjs` passes (89 ours, 117 donors, 41 features).
- [x] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
  Evidence: `node scripts/ui-audit.mjs --serve` PASS 108/108 page runs across 18
  routes (incl. `/brainwallet`, `/send*` and `/vanity`); `/brainwallet` and the
  chain routes went from four 22px links to >=44px after the `.directory-links`
  fix. `/vanity` was added to `DEFAULT_ROUTES` after PR #123 changed its stat
  cards without gate coverage.
- [x] `node scripts/check-projects.mjs`, site tests, cargo tests, clippy.
  Evidence: 13 site suites + 30 `node --check` lines pass; `check-projects`
  OK (367/368, `Cargo.lock` ignored); `coordinator_api` 15, `coordinator_client`
  3, `rotor-wasm` 59 pass; `cargo clippy --all-targets -D warnings` and
  `cargo fmt --check` clean.

## Relocation to internal docs (done)

- [x] Move the parity map from the public site to `docs/site-map/`
  (`index.html`, `site-map.css`, `site-map.js`, `site-map-data.js`,
  `site-map-test.mjs`, local `icons.svg` and `theme.js`); relative assets only.
- [x] Drop `/site-map`, `/site-map.css`, `/site-map.js` and `/site-map-data.js`
  from the coordinator routes, embedded assets and sitemap; route tests and
  `/docs`/`/tools` links no longer reference the public path.
- [x] Run the data test from `docs/`: `node docs/site-map/site-map-test.mjs`.
