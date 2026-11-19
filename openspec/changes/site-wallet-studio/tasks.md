# Tasks: site wallet studio

Roles: [front] `apps/site/**`, [back] `src/coordinator/**`,
[wasm] `crates/rotor-wasm/**`, [ops] CI/CF, [qa] browser evidence.
Every unchecked task has a concrete artifact; checked tasks need a test or a
browser capture in the PR.

## 1. Explorer links and WIF rows [front]
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
- [ ] Add the four counters (total value, has balance, active chains,
      checked N/N) above key facts; hide until the first successful derive.
      (blocked by: 1)
- [ ] Compact key-facts block: HEX, DECIMAL, WIF, WIF(U), KEYPAIR(SOL),
      SECRET(XRP), PUBKEY, PAGE. Each row has copy; WIF links to `/key/wif`.
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
- [ ] Entropy 12/15/18/21/24 and BIP39 generation/validation. (blocked by: 3)
- [ ] Electrum old (1626-word) and Electrum BIP39 derivation; separate
      wordlist and tests against published vectors.
- [ ] Passphrase, all-paths toggle, chain selector, address count 1/3/5/10,
      `Convert & Check Balance`.
- [ ] Results grouped by chain: path, address, balance, explorer link; CSV.
- [ ] Never store/upload phrase; clear on pagehide; no key in URL.
- Evidence: BIP39 vector, one Electrum vector, mobile capture.

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
- [ ] Header icon-only search + 18-chain icon strip modal with auto-detect
      HEX/WIF/Keypair/XRP secret/Mnemonic/Brainwallet and `Search All Chains`.
      (blocked by: 12 seed directory for mnemonic results)
- [ ] `/mnemonic-converter` as a standalone page reusing the seed form.
- [ ] `/brainwallet/bitcoin`, `/brainwallet/ethereum` and
      `/brainwallet-generator` aliases/variants.
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

## 14. Secretscan calculator catalogue (from donor-map.md)
- [ ] `/monero-address-generator`; decide whether view-key/spend-key derivation
      or only address encoding is in scope.
- [ ] Per-chain address-generator pages that reuse `/key` with a chain preset:
      Ethereum, BNB, Tron, Solana, XRP, TON, Bitcoin Cash, Taproot/SegWit.
- [ ] `/hex-dec-bin` converter and `/reconstruction` private-key reconstruction.
- [ ] `/public-key` (public key → addresses) and `/pubkey-add` (P + Q).
- [ ] `/keystore-parser` local UTC/JSON keystore decrypt; no upload.
- [ ] Transaction builders/decoders per secretscan route, reusing the
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
