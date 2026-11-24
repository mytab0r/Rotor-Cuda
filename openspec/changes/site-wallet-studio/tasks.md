# Tasks: site wallet studio

Roles: [front] `apps/site/**`, [back] `src/coordinator/**`,
[wasm] `crates/rotor-wasm/**`, [ops] CI/CF, [qa] browser evidence.
Every unchecked task has a concrete artifact; checked tasks need a test or a
browser capture in the PR.

## 1. Explorer links and WIF rows [front]
- [x] `/mnemonic-seeds/<chain>` rows show the derived private key (compressed
      WIF on Bitcoin, hex elsewhere) and the mnemonic with icon-only copy
      buttons; the BTC WIF keeps its `/key/<WIF>` link, address copy and
      explorer icons stay. Evidence: `apps/site/mnemonic-seeds-test.mjs`,
      `mnemonic_seed_directory_routes_and_assets_are_served` in
      `src/coordinator/mod.rs`.
- [ ] Add one explorer map in `apps/site/browse.js` and use it for chain rows;
      add the same map to `key.js` for derived rows. (blocked by: -)
- [ ] Address text itself links to the explorer; external icon and
      `rel="noopener noreferrer"`.
- [ ] Every BTC row keeps the compressed WIF link to `/key/<WIF>`; details show
      both WIFs with links.
- [ ] Mobile: address and WIF use ellipsis with full value in `title`; copy
      buttons remain 34px+.
- Evidence: browser capture of BTC, EVM, TON rows; no 404 explorer prefixes.

## 2. Key page density [front]
- [x] Add the four counters (total value, has balance, active chains,
      checked N/N) above key facts; hide until the first successful derive.
      Total value stays “—” because no price source is connected (no fake
      USD). Evidence: `apps/site/key-tools-test.mjs` `balanceCounters`
      (unique addresses, funded chains, checked/total over visible provider
      rows); browser capture of key 1: 2 has balance, 2 active chains, 14/14
      checked.
- [x] Compact key-facts block: HEX, DECIMAL, WIF, WIF(U), KEYPAIR(SOL),
      SECRET(XRP), PUBKEY, PAGE. Each row has copy; WIF links to `/key/wif`.
      HEX links to `/key/hex`; PAGE opens the integer directory page; formats
      that the curve cannot support show the reason (ed25519 has no WIF/XRP
      secret; secp256k1 has no Solana keypair). Evidence:
      `apps/site/key-tools-test.mjs` `buildKeyFacts` (report fields, XRP
      secret interior/checksum via an independent Ripple-alphabet decoder,
      Solana keypair seed||pubkey, key 1/60/61 page math).
- [x] Show the EVM account once per network (Ethereum, BNB Chain, Arbitrum,
      Optimism, Base, Polygon, Avalanche, zkSync Era), each tagged “same
      address”, with per-network public RPC balances and explorers; add
      public-only Copy All/CSV on the address toolbar (no key material).
      Evidence: browser capture of key 1 (eight rows, same `0x7E5F…`, per-chain
      balances); `node scripts/ui-audit.mjs --serve --routes key,private-keys/bitcoin
      --viewports 375,1280 --themes dark,light` passes 8/8 runs.
- [ ] Balance checks on by default; per-row spinner → value/error; retry on
      failure; `updated` timestamp.
- [ ] Registry match line remains visible and honest (0 matches = no warning).
- [ ] Remove the detached advanced card; keep only the merged toolbar.
- Evidence: desktop 1440 and mobile 375 captures; Lighthouse a11y ≥ 95.

## 3. Merged address toolbar and presets [front]
- [ ] One toolbar component used by key, chain and seed pages: chain chips,
      address type, path preset, custom path, wallet preset, count, balances.
      (blocked by: 2)
- [ ] Address-type buttons share exactly the same class/DOM on all three pages.
- [ ] Preset changes filter/highlight rows, never change the derivation;
      show a one-line explanation.
- [ ] Add `Master key`, BIP44, BIP49, BIP84, BIP86 path chips; custom path input
      validates `m/…` and is informational (the page takes a final key).
- [x] Replace the `key-advanced` details with one compact derivation block:
      editable path input + icon Copy with `m/…` validation on blur/Enter,
      one preset chip row (All, Ledger / Trezor, MetaMask, SafePal, TronLink,
      Phantom) and the curve beside it. A preset changes the informational path
      and keeps row filtering and `#preset-select` sync unchanged; longer path
      lists live in `title`/`aria-description`.
      Evidence: `node --check apps/site/key.js`; `browser_client_assets_are_served`
      and `seo_key_page_injects_key_and_robots_policy` coordinator tests;
      headless Chrome at 375/768/1280 in both themes (no overflow, chips in
      1–2 rows, no text under 12px, preset→path/filter sequence, valid/invalid
      path states, icon copy → check).
- Evidence: same visual snapshot of the toolbar on `/key/<hex>`, chain browser,
      seed page.

## 4. Curve editor [front]
- [ ] Replace `#curve-plot` with an SVG component: curve, point P, −P, P+G.
      (blocked by: 3)
- [ ] Drag point; X/Y numeric fields two-way bind; keyboard arrows move;
      `Random`, `Reset`, `Copy` actions.
- [ ] Caption states finite-field vs real illustration; reduced motion.
- Evidence: keyboard and pointer interaction script; mobile no overflow.

## 5. Seed studio [front+wasm]
- [x] Entropy 12/15/18/21/24 and BIP39 generation/validation. (blocked by: 3)
      Evidence: `apps/site/seed-test.mjs`; checksum/word-list errors are inline.
- [x] Electrum old (1626-word) and Electrum BIP39 derivation; separate
      wordlist and tests against published vectors.
      `seed-crypto.js` holds the legacy wordlist and Electrum's stretch/sequence
      scheme; Electrum BIP39 uses the BIP39 wordlist with the `01`/`100`
      seed-version check and the `electrum` PBKDF2 salt. 2FA prefixes are an
      explicit unsupported state. Evidence: Electrum `Test_OldMnemonic` and
      `SEED_TEST_CASES` vectors in `apps/site/seed-test.mjs`.
- [x] Passphrase, all-paths toggle, chain selector, address count 1/3/5/10,
      `Convert & Check Balance`.
- [x] Results grouped by chain: path, address, balance, explorer link; CSV.
- [x] Never store/upload phrase; clear on pagehide; no key in URL.
- [x] Balances start automatically on `/seed`, `/mnemonic-converter`, `/key`,
      `/private-keys/<chain>` and `/mnemonic-seeds/<chain>`: no visible
      checkbox or "Check balances" button; per-row checking/value/error; one
      automatic retry on transient failure; compact per-row retry icon; no
      request without a derived public address and no seed/key in requests.
      The seed form is a dense full-width grid (five controls, full-width
      mnemonic, passphrase/count/actions row) at 375/768/1280 in both themes.
      Evidence: headless Chrome DOM measurements (`fillRatio` 100 at
      375/768/1280, `scrollWidth == clientWidth`), mocked fetch counts
      (seed derive = 2 provider calls, retry-once = 2 BTC calls, persistent
      failure renders one retry icon that recovers, empty key = 0 calls), and
      generated `/private-keys/bitcoin` + `/mnemonic-seeds/bitcoin` pages
      loading balances with no balance toggle.
- [x] Global balance refresh and local cache: `/private-keys/<chain>`,
      `/mnemonic-seeds/<chain>` and `/key` expose one "Refresh failed / stale"
      action with a live count. It retries only rows whose balance is missing,
      failed or older than the provider TTL; the per-row retry icon stays for a
      single row. `apps/site/balance-cache.js` is a DOM-free pure codec
      (IndexedDB store with memory fallback) keyed by provider + chain +
      address with `{value, fetchedAt, source, error?}`; BTC and other providers
      use 60 s, EVM 30 s. Cached values render immediately with a 12 px age
      label, stale entries refresh in the background with jitter, requests are
      bounded to 4–5, and transient failures retry once with exponential
      backoff + jitter (429/5xx stop after the attempt budget). Provider errors
      stay visible per row and are never cached as success. Evidence:
      `apps/site/balance-cache-test.mjs` (hit/miss, TTL, error-not-success,
      refresh selection, concurrency, backoff), `node --check` for the three
      page scripts, coordinator asset/route tests and the UI audit.
- Evidence: BIP39 key 1 (`abandon…about` -> `1LqBGSKuX5yYUonjxT5qGfpUsXKYYWeabA`),
      Electrum old (`hardly point…` -> `18v3oDeH9LCmeKrbC2nYgLP5UKva1NpMG`),
      Electrum master-seed vectors in `seed-test.mjs`. Electrum BIP39 validation
      accepts the native 13-word standard vector `cram…able` and the 12-word
      segwit vector `wild father…`, while plain BIP39, 13-word BIP39 and 2FA
      phrases are rejected (`seed-test.mjs`). Browser capture is for QA.

## 6. Milk Sad seed studio parity [front]
- [ ] Reuse the seed toolbar: entropy, mnemonic type, passphrase, path, count.
      (blocked by: 5)
- [ ] Keep seed browser pagination and owner range audit; no balance ranking.
- Evidence: seed 0 official vector and a 60-seed page capture.

## 7. Signing entry [front, links tx-sign-broadcast]
- [ ] Add `Build transaction` entry on the key page behind the explicit gate
      from `tx-sign-broadcast`. (blocked by: 6)
- [ ] Testnet first; review screen shows inputs/outputs/fee/change; no broadcast
      without a separate confirmation.
- Evidence: testnet fixture transaction signed and decoded; no server request
      containing key/WIF/seed in DevTools.

## 8. Cloudflare phase 0 [ops]
- [ ] Add `cf/worker` + `wrangler.jsonc`: static assets, public API cache,
      origin proxy via Tunnel, edge rate limits. (blocked by: -)
- [ ] Keep `/api/v1/lease|result|heartbeat` on origin; document signed proxy
      headers and timeout budget.
- [ ] Deploy to a staging domain; compare latency and errors; rollback plan.
- Evidence: staging URL, 5xx/429 dashboards, origin still reachable.

## 9. Cloudflare phase 1 [ops]
- [ ] D1 schema for accounts/sessions/watchlist/events; one-off migration from
      `monitor.json`. (blocked by: 8)
- [ ] Cron watcher + Queues for Telegram; idempotent event insert.
- [ ] Cabinet reads/writes through Worker; tests for auth and rate limits.
- Evidence: staging alert end-to-end, no duplicate events after restart.

## 10. Cloudflare phase 2 (only if load justifies) [ops]
- [ ] DO per job for leases/alarms; R2 manifest per range; Queue for results.
      (blocked by: 9)
- [ ] Batch leases and heartbeats; load test 1k clients; document DO limits.
- Evidence: load test report and cost estimate.

## 11. QA and archive [qa]
- [ ] Walk `ui-checklist` on every changed page at 375/768/1440.
- [ ] Run `node scripts/check-projects.mjs`, `cargo test`, clippy, WASM smoke.
- [ ] Record gate #1 and #2 verdicts under `reviews/`.
- [ ] Archive the change and update `openspec/specs/key-explorer/spec.md`.

## 12. Donor route backlog (from donor-map.md)
- [x] `/mnemonic-seeds` and `/mnemonic-seeds/<chain>` with 60 rows per page,
      12/18/24-word entropy, BIP-32 path, address type, balances and pager.
      (blocked by: 5 — seed studio engine; delivered on top of `seed.js`)
      Evidence: `mnemonic_seed_directory_routes_and_assets_are_served` route test.
- [x] Header icon-only search + 18-chain icon strip modal with auto-detect
      HEX/WIF/Keypair/XRP secret/Mnemonic/Brainwallet and `Search All Chains`.
      (blocked by: 12 seed directory for mnemonic results)
      Evidence: `site.js` modal + `search.js` `detect`; a mnemonic goes to
      `/mnemonic-seeds/<chain>` or `/seed` with no phrase in the URL; a keypair
      opens `/key/<hex>?curve=ed25519&chain=solana`; XRP family seeds and bad
      keypairs raise precise inline errors instead of a brainwallet hash.
- [x] Header theme toggle next to the icon-only search: light theme built from
      `html[data-theme="light"]` custom properties, default follows
      `prefers-color-scheme`, the visitor's choice persists in `localStorage`,
      and the toggle is a 40px keyboard-accessible button on every page.
      Evidence: `theme.js`, `theme_script_and_chain_generator_entries_are_served`,
      `rendered_documents_load_the_theme_script`.
- [x] `/mnemonic-converter` as a standalone page reusing the seed form.
      It loads the same `seed.js`, `seed-crypto.js`, `seed-page.js` and
      `seed-studio.css` as `/seed`; the page is linked from `/tools` and `/seed`.
      Evidence: `seed_studio_and_mnemonic_converter_are_served`.
- [x] `/brainwallet` is a directory index with 18 chain tiles and the
      18,890-passphrase counter; `/brainwallet/<chain>` and
      `/brainwallet/<chain>/<page>` list 60 deterministic two-word passphrases
      per page (315 pages, 50 on the last page) with BigInt page math,
      First/Previous/Random/Next/Last and Jump. Each row shows the SHA-256 hex
      key, the passphrase, the chain address, explorer/copy icon buttons and an
      optional balance; Bitcoin and Litecoin expose the address-type switch and
      the summary shows balance/active/received/tx. `/brainwallet-generator` is
      the canonical single-passphrase calculator with an 18-network dropdown,
      1/3/5/10 addresses, WIF, copy-all/CSV and opt-in balance checking.
      Evidence: `apps/site/brainwallet-test.mjs` corpus/page/BigInt/vector
      tests (corpus[0] `amber amber` → legacy `1FUi…`), and
      `coordinator::tests::brainwallet_directory_pages_paginate_and_link_assets`.
- [ ] `/richest` and `/richest/<chain>` in-site lists with search/filter and
      the Rich-Address-Wallet attribution; do not proxy balances.
- [ ] `/keystore-parser` accepting a UTC/JSON keystore and decrypting locally;
      no password or file upload.
- [ ] `/wallet-viewer` read-only address lookup with explorer links.
- [ ] `/whale-tracker`, `/satoshi-wallets`, `/bitcoin-dormant` research pages;
      decide data source and rate limits before building.

## 13. Bitcoin puzzle browser parity [front+wasm]
- [x] `/bitcoin-puzzle` puzzle selector `#1…#160`, previous/next and
      breadcrumbs `Home / Bitcoin Puzzle / Puzzle #N / Random Keys`.
      (blocked by: -)
- [x] `/bitcoin-puzzle/<n>/random` and `/bitcoin-puzzle/<n>/detail` routes;
      show balance, range start/end, progress, target address, explorer and
      mempool links.
- [x] Range presets `Full`, `1st Half`, `2nd Half`, `Q1…Q4`; mode
      `Solo Random` / `Solo Seq` / `Team`.
- [x] Browser WASM worker Start/Stop/Reset/Check; counters Generated, Speed,
      Workers, WASM, Match, ETA, Network; match panel with key + Copy.
- [x] Keep the coordinator pooled jobs as a separate `Team` mode; no silent
      mix of local and lease work.
- Evidence: puzzle #71 random run for 60s; start/stop/reset; match fixture;
      mobile 375 capture; no key leaves the browser.

## 14. ref-site-b calculator catalogue (from donor-map.md)
- [ ] `/monero-address-generator`; decide whether view-key/spend-key derivation
      or only address encoding is in scope.
- [x] Per-chain address-generator pages that reuse `/key` with a chain preset:
      Ethereum, BNB, Tron, Solana, XRP, TON, Bitcoin Cash, Taproot/SegWit.
- [x] Per-chain address-generator pages that reuse `/key` with a chain preset:
      Ethereum, BNB, Tron, Solana, XRP, TON, Bitcoin Cash, Taproot/SegWit.
      `/key?chain=<slug>` (plus `&type=taproot|segwit`) preselects the chain,
      address row and ed25519 curve in `key.js`; entry cards live on `/tools`.
      Evidence: `theme_script_and_chain_generator_entries_are_served`.
- [x] `/hex-dec-bin` converter and `/reconstruction` private-key reconstruction.
      Hex/dec/bin handles unsigned values up to 256 bits with validation and copy.
      `/reconstruction` is a known-byte assembler (`offset:format:value`, hex/
      bin/dec/ascii); missing or overlapping bytes are reported and never
      guessed, so it does not claim key recovery.
      Evidence: `apps/site/key-tools-test.mjs` (parser, assembly, wasm report);
      `key_utility_pages_are_served_and_indexed` route test.
- [x] `/public-key` (public key → addresses) and `/pubkey-add` (P + Q).
      Both use new wasm exports `public_key_report` / `public_key_add`; key 1
      test vectors for BTC P2PKH/P2WPKH/P2SH/P2TR, EVM and TRON, and G + G = 2G;
      invalid, off-curve and infinity results are rejected.
      Evidence: `cargo test -p rotor-wasm` (`public_key_*` tests) and
      `apps/site/key-tools-test.mjs`.
- [x] `/keystore-parser` local UTC/JSON keystore decrypt; no upload.
      V3 `aes-128-ctr` with `scrypt` or `pbkdf2` (HMAC-SHA256), 32-byte derived
      key and MAC check run inside the wasm core; the page passes the password
      only to local memory and clears it on `pagehide`. Unsupported versions,
      ciphers, KDFs and oversized scrypt parameters get an explicit message.
      Evidence: scrypt and PBKDF2 fixtures decrypt to the published key and EVM
      address (`keystore::tests`, `apps/site/key-tools-test.mjs`). Both the
      standard 32-byte MAC (geth/MetaMask) and the 16-byte legacy MAC are
      accepted, and the legacy positional scrypt `kdfparams` array `[n, r, p]`
      is parsed.
- [ ] Transaction builders/decoders per ref-site-b route, reusing the
      tx-sign-broadcast review gate; no server-side signing.
- [ ] `/wallets` in-site rich-list catalogue with search/filter and explicit
      price/terms; data source and resale rights must be confirmed first.
      (storefront and proxied downloads: §15; this item is the browsable
      rich-list catalogue)
- [ ] `/scaner` + `/results` UX only if a real scanner exists; no fake progress.

## 15. Wallet database storefront [front+back]
- [x] `/wallets` lists the six Rich-Address-Wallet rich lists for Bitcoin,
      Ethereum, Litecoin, Dogecoin, Bitcoin Cash and Dash; the landing Address
      databases section links only to `/wallets`; no direct `github.com` links
      remain in customer-facing HTML.
- [x] `GET /api/v1/wallets` and `GET /api/v1/wallets/<chain>` return the
      allowlisted catalogue (license metadata, our download paths, no upstream
      host); unknown chains are a hard 404.
- [x] `GET /api/v1/wallets/<chain>/download` streams the upstream snapshot
      through our origin: 5s connect / 30s read-write timeouts, 2 GB cap,
      per-IP bucket, upstream 404 -> 404 and any other upstream failure -> 502.
- [x] MIT notice (Copyright (c) 2022 MMDRZA) on the page and in the
      machine-readable `/wallets/LICENSE.txt`; the access copy says
      `Request access` and adds no invented price or fake checkout.
- Evidence: `tests/coordinator_api.rs::wallet_catalog_is_public_and_downloads_stream_through_our_origin`
  with a mocked upstream; source URLs stay server-side.
- [ ] Paid checkout / terms and price display; decide whether the files stay
      free with attribution or are sold as packaged lists. (blocked by: payment
      provider; legal review below)
- [ ] Counterparty legal review of resale/redistribution obligations before any
      paid offer goes live. (blocked by: -)

## 16. Interactive donor map [front]
- [x] `/site-map` canonical page with search, area/status filters and
      ours/donor/matrix views. Routes and feature statuses live in one file,
      `apps/site/site-map-data.js`; donor pages that have no Rotor equivalent
      stay visible as `missing`.
      Evidence: `apps/site/site-map-test.mjs` validates route coverage, donor
      links and status consistency; `site_map_route_assets_and_sitemap_are_served`
      covers the route, assets and sitemap entry.
- [x] Link the map from `/tools` and `/docs`; the page is listed in
      `sitemap.xml` and embedded by the coordinator.
- [x] Refresh the statuses after PR66–PR74: brainwallet directory, 18 chain
      listings and generator; seed key/WIF rows; key auto-derive; puzzle table,
      detail and Community Hunt. Only the still-missing controls stay partial.
      Evidence: `site-map OK: 83 ours, 117 donors, 41 features; ours parity 48,
      partial 29, ours-only 6, donor-only missing 27`.
