# Tasks: donor copy parity

Each task states its evidence source and the gate it must pass. Work happens in
a worktree; one writer per area.

## 1. Key page anatomy (donor: docs/donor-parity/key-page.md)
- [x] Derivation block above the address list (owner: "подними секцию Derivation").
      Note: the donor has no derivation controls on this page at all; this is a
      deliberate deviation requested by the owner, not a parity item.
      Evidence: `apps/site/key.html` (derivation section before `#key-rows`).
- [x] Remove per-address WIF links; WIF/WIF (U) live only in the Keys table.
      Evidence: `apps/site/key.js` (no `key-wif-slot`, no `hydrateWifLinks`).
- [x] URL stays as typed. The donor echoes the input verbatim and never runs
      `history.replaceState`/`pushState`; the owner confirmed the same behaviour.
      An earlier idea to canonicalise to `/key/<64-hex>` was dropped — do not
      add it. Evidence: `docs/donor-parity/key-page.md` §1, §8.
- [x] Stats row (TOTAL VALUE / HAS BALANCE / ACTIVE / CHECKED) with the donor's
      meaning, or an explicit reason we cannot compute it client-side.
      Evidence: `apps/site/key.html` (four cards plus the explanatory note),
      `apps/site/key.js` (`updateCounters`/`renderTotalValue`);
      `apps/site/key-tools.js` (`fiatTotals`). TOTAL VALUE sums the loaded
      balances at a public ticker price cached for six hours, excludes rows
      without a price or balance and counts them in the title.
- [x] Keys table row order and labels match the donor.
      Evidence: `apps/site/key-tools.js:526-599` (`buildKeyFacts`) emits HEX,
      Decimal, WIF, WIF (u), Keypair (SOL), Secret (XRP), PubKey, Page.
      Deviation: the extra "Public point" group below the eight rows is kept
      (compressed/uncompressed/X/Y/ed25519); the donor has no such block.
- [x] Address table matches the donor exactly: real `<table>` with `<thead>`,
      columns Chain | Type | Address | Status | actions (no path column), chain
      cell uses `rowspan` (BTC 5, LTC 4, BCH 2, DOGE 2, TON 2, ZEC 2), EVM has
      one `0x` row plus eight chain rows marked "↑ same". 30 rows total.
      Evidence: `docs/donor-parity/key-page.md` §2; `apps/site/key.js`
      renders both curves into one table and `mergeCurveAddresses` in
      `apps/site/key-tools.js` is covered by the 30-row test.
- [x] Add the missing address types — exact donor row set (30 rows):
      BTC: Legacy, Legacy(u), SegWit, **P2SH** (we label it "Nested SegWit"),
      Taproot; EVM: parent `0x` row + ETH/BNB/POL/ARB/OP/BASE/AVAX/zkSync rows
      with `↑ same`; TRX Base58; SOL Base58; TON V4R2 **+ W5**; SUI `0x`;
      XRP `r…`; LTC Legacy, SegWit, **P2SH, Taproot**; BCH **CashAddr** +
      Legacy; DOGE Legacy **+ Legacy(u)**; ZEC **t1 (c) + t1 (u)**.
      Evidence: donor DOM extraction in `docs/donor-parity/key-page.md` §2.
      Row inventory is now 30 of 30: every 32-byte input derives both curves
      (`derive_report` 0 and 1); the ed25519 report supplies SOL, SUI and
      TON W5, the page adds TON V4R2, and the secp report plus the JS
      encoders supply the other 26 rows.
- [x] Stats semantics: `Checked` = chains checked / 18 (constant), `Has
      Balance` and `Active` count unique chain groups, not rows.
      Evidence: `apps/site/key-tools.js:605` (`CHAIN_GROUP_TOTAL = 18`),
      `balanceCounters` over `counterChainKey`, `apps/site/key.html:173`
      (`0/18` initial value and title).
- [x] Status vocabulary and row tints: green amount with full precision in
      `title`, amber check for active/empty, `-` for checked-empty, `!` for
      errors, spinner while pending.
      Evidence: `apps/site/key.js:1805-1821` (spinner), `:1880-1910`
      (`ok`/`active`/`empty` badges, `has-balance`/`is-active` tints),
      `:2406-2407` (error `!`).
- [x] Keys table: eight donor rows; `Page` links to the directory page.
      Evidence: `apps/site/key-tools.js:509-520` (`privateKeyPage`:
      `/private-keys/bitcoin/<ceil(decimal/60)>` for secp, `solana` for an
      ed25519 seed), `:594-597` (Page fact).
- [x] Do NOT canonicalise the URL: the donor echoes the input verbatim; every
      key form renders the same page in place.
      Evidence: no `replaceState`/`pushState` in `apps/site/key.js` or
      `apps/site/site.js` (grep, 2026-11-20).
- [x] Stats row `TOTAL VALUE` in USD from a public price source. Decision
      (2026-11-21): Binance's public ticker, one request per six hours cached in
      localStorage; on 429/network failure keep the previous cache and mark it
      stale. Rows without a price or a balance are excluded and counted, never
      treated as zero; with no reachable source and no cache the card shows
      `—`, never a fake number.
      Evidence: `apps/site/key-tools.js` (`tickerFor`, `atomicToCents`,
      `fiatTotals`, `priceCacheState`), `apps/site/key.js` (`ensurePrices`,
      `renderTotalValue`), `apps/site/key-tools-test.mjs` (chain→symbol
      mapping, 6/8/18-decimal BigInt math, cache TTL/stale, missing-price
      exclusion).


## 2. Search and directories (donor audit)
- [x] Global search matches the donor's input types and lands on `/key/<hex>`.
      Evidence: `apps/site/search.js:22-31` (interpret-as: auto, HEX, WIF,
      Keypair, XRP Secret, Mnemonic, Brainwallet), `:219-256` (detection),
      `apps/site/site.js:137-160` (directory search resolves to
      `/key/<hex>`), `:209-247` (Ctrl+K modal renders inline results with Copy
      All/CSV instead of redirecting). Deviation: the donor's "View" link is
      replaced by in-place results; the directory forms still land on
      `/key/<hex>`.
- [x] `/private-keys`, `/private-keys/<chain>`, `/mnemonic-seeds/<chain>`
      column sets and grouping copied from the donor.
      Audit note (2026-11-20): donor column sets, grouping and global-search
      mechanics are recorded in `docs/donor-parity/directories.md`; site parity
      is still to verify.
      Evidence (2026-11-20): `src/coordinator/mod.rs` (18-chain donor order,
      TON/BCH `?type=legacy` tabs, hidden H1, page-info/progress, three stat
      cards, 60-row grid headers), `apps/site/browse.js` (hex + real 44px key
      copy, one `(c)` address line with the `(u)` form behind a 44px
      disclosure, per-address balance/TX/received with the extra balance line
      disclosed too, `?key=` prefill/highlight), `apps/site/mnemonic-seeds.js` +
      `mnemonic-seeds.html` (three headers + full-width mnemonic sub-row,
      bits/preset/path/type query scheme, word-count reset to page 1,
      preset pills). Deliberate deviations: the H1 is kept but
      `visually-hidden` (document outline/landmark) on both directories; the
      page-percent value is hidden at <=560px to keep the page-info line on
      one row; zero-provider metrics render `-`, never invented data.
- [x] Donor key-URL and directory mechanics: `?key=` jumps to the page that
      contains the key, the donor aliases `/vanity-generator` and `/downloads`
      redirect, and `/key/<value>` accepts `0x` plus short hex.
      Evidence (2026-11-21): `apps/site/browse.js` (`pageForHexKey`,
      `jumpToKeyPage`, `data-page` config; navigation only when the computed
      page differs from the current one), `apps/site/search-test.mjs`
      (`0xdeadbeef` -> page 62,265,476, clamping, non-hex/zero rejection),
      `src/coordinator/mod.rs` (`redirect_target` 301 aliases exact-path only,
      `prefixed_hex_key` left-pads 1..=64 hex digits and rejects all-zero);
      arbitrary non-key text stays a real 404.
- [x] Per-chain summary cards: Balance/Received/TX on UTXO chains,
      Balance/Active on account-model chains (donor: `directory-pages.md`
      §1 "Chain differences").
      Evidence (2026-11-21): `src/coordinator/mod.rs:1272`
      (`AddressKind::is_utxo`), `:3336-3349` and `:3382-3384` (card markup),
      `apps/site/site.css:1517-1519` (`.balance-summary--account`; the mobile
      rule at `:1819` still collapses it) and `:1898-1901` (the ≤560px
      phone-density block keeps two columns for the account variant),
      `apps/site/browse.js:156,411-416,
      578-602,906-945` (`totalActive`, 4-argument `setSummary`, active counting,
      best-effort `eth_getTransactionCount` batch), `tests/coordinator_api.rs:1218`
      (`private_key_pages_shape_summary_cards_by_chain_model`), plus the
      `summary-grid-orphan` detector in `scripts/ui-audit.mjs` and its ledger
      entry in `docs/process/defects.json` (it reproduced the empty third cell
      at 375px before the ≤560px CSS fix).
      Limitation: Solana/Sui/Ton have no per-address tx count, so they count an
      address as active only when it is funded.

## 3. ref-site-b ideas
- [x] Lists/pricing pages, filters and density reviewed; adopted items listed
      in `docs/donor-parity/secretscan.md`.
      Evidence: `docs/donor-parity/secretscan.md` §8 (ranked adoption list).
      No datasets or prices copied; the list/rent machinery stays a separate
      owner decision (section 5).
- Audit note (2026-11-20): mechanics of `/wallets`, `/results`, `/rent` and
  `/scaner` recorded in `docs/donor-parity/secretscan.md`; no datasets or
  prices copied.

## 4. Rename Rotor → Crypto
- [x] UI wordmark, `<title>`, meta descriptions, docs headers.
      Evidence: PR #104 merged as 98668a7; live serves `Crypto` at 20261124e.
- [ ] Repo name and production domain are owner decisions — record them, do not
      change unilaterally.

Scope decision (2026-11-20): rename **user-visible brand text only**.
- In scope: `.brand-name` in every `apps/site/*.html`, `<title>`, meta
  description/og strings, visible copy, `docs/**` page headers, and the same
  strings emitted by `src/coordinator/mod.rs` (today ~50 occurrences).
- Out of scope: JS globals (`RotorKeyTools`, `RotorAddressCodecs`, …), crate
  and package names, file names, route paths, CSS class names, test ids, git
  history, and any URL/domain. They are API, not brand; renaming them is churn
  and risk with no user-visible benefit.
- Blocker: the word “Crypto” is generic for SEO. Record the owner's final
  wordmark choice before touching title/meta (titles are indexed).

## 5. Paid datasets (design: docs/donor-parity/payments.md)
- [x] Implement the processor-free order flow: `POST /api/v1/orders`,
      `GET /api/v1/orders/{id}` (order token), `GET /api/v1/orders/{id}/download`
      (HMAC token, 7 days, 5 downloads), admin revoke/reconcile.
      Evidence: `src/coordinator/orders.rs` (routes, store, tokens), routes
      registered before the client-token matrix in `src/coordinator/mod.rs`,
      store `orders.json` written atomically next to the coordinator state;
      tests in `src/coordinator/orders.rs` and
      `tests/coordinator_api.rs::orders_are_public_but_need_configuration_and_an_active_list`.
      Unconfigured `ORDERS_CONFIG` answers 503; inactive list answers 404.
- [x] Per-order deposit address (watch-only xpub) or unique-amount fallback;
      poller with BTC 3 / LTC 6 / TRON 19 / ETH 12 / BSC 15 confirmations.
      Fallback chosen for this iteration: fixed address + unique atomic-amount
      suffix (no xpub derivation). Evidence: `quote_amount`/`allocate_amount`
      and the pure `match_payment` rules in `src/coordinator/orders.rs`; the
      poller polls Esplora (BTC/LTC) and TronScan (TRON) every 45 s;
      confirmations come from config with the 3/6/19 defaults. One
      `(chain,txid,vout)` pays one order. ETH/BSC remain config-only chains:
      the current poller verifies BTC, LTC and TRON.
- [x] Every delivered package carries the licence/attribution page (MIT notice
      for our lists; CC0 provenance for donor-derived data). The operator
      archive is streamed untouched, so the document is delivered next to it
      from a token-guarded route: `GET /api/v1/orders/{id}/licence?token=...`
      answers `text/plain; charset=utf-8` as `<slug>-LICENCE.txt` with
      `Cache-Control: no-store` and `X-Robots-Tag: noindex`; a wrong token or
      unknown order answers `404`. `ListConfig.licence` (default `MIT`) and
      optional `provenance` are validated; the MIT copyright line is chosen
      deterministically from provenance (Rich-Address-Wallet/MMDRZA vs. the
      Rotor contributors), `CC0-1.0` gets the canonical public-domain notice,
      and any other identifier falls back to a contact-the-operator note. The
      order status always exposes `licence_url`. Evidence:
      `src/coordinator/orders.rs:102` (config fields), `:208` (validation),
      `:619` (`licence_document`), `:1064` (`render_licence_document`),
      `:1246`-`:1255` (route dispatch), `:1388` (response), unit tests at
      `:2173`-`:2244`; `deploy/orders.example.json` sets `licence: MIT` and a
      provenance string only for the two Rich-Address-Wallet-derived packs.
      Provenance stays optional and is omitted where the donor source is not
      known (`usdt-trc20-pack`).
- [ ] Prices, accepted chains and refund policy are owner decisions; ship with
      `active=false` lists until they are set.
      `deploy/orders.example.json` ships every list with `active: false`.

## Density measurement (owner, 2026-11-21)
- [x] Repeatable donor reverse-engineering: `scripts/density-parity.mjs` measures
      chrome height, visible rows/row height, controls above the fold, block
      padding/gaps, title/stat/table-header fonts and document height for two
      URLs at 375x812/1280x800/1440x900, with an honest unreachable-donor
      report. Evidence: the script, the procedure in
      `.claude/skills/donor-reverse/SKILL.md`, and the first measured run in
      `docs/donor-parity/density-tron.md` + `density-tron.json`.
- [x] Apply the ranked change list from `docs/donor-parity/density-tron.md`
      (browse-row WIF lines, stats compaction, jump-form width, chip strip,
      search/page-header/gap micro-compaction). Evidence: PR #218; measured
      again in `docs/donor-parity/density-bitcoin.md` (after: chrome 746,
      rows 56-61 at 1440x900).
- [x] Bitcoin listing row: one visible address line, the second
      (uncompressed) address and its balance line kept in the DOM behind a
      44px `aria-expanded` disclosure; expanding grows only that row. Evidence:
      `apps/site/browse.js` (`addressCellModel`, `addr-extra-toggle`,
      `balance-extra`), `apps/site/site.css`, `apps/site/search-test.mjs`
      (both entries survive the split), `tests/coordinator_api.rs`, and the
      ui-audit `browse-row-address-disclosure` / `browse-row-balance-split`
      checks at 1440/1280/375.
- [x] Issue #220: the row key copy is a real 44px `.icon-button` with
      `aria-label`, `data-tooltip` and the copied state; the donor key cell has
      the same action (28px, revealed on row hover). Detector:
      `browse-row-key-copy`; served-row assertion in
      `tests/coordinator_api.rs`.
- [x] Browse stat cards end level: the 20px value step and a 200px note keep
      `Received` on one line, so the three cards are 55px with a 0px bottom
      spread at 1440 and 1280. Detector: `browse-stat-level`.
- [x] Record the follow-up measurement before/after in
      `docs/donor-parity/density-bitcoin.md` with the raw JSON.

## Gates
- `node scripts/ui-audit.mjs --serve` — 0 violations at 375/768/1280, light/dark.
- Site tests, coordinator tests, `node scripts/check-projects.mjs`.
- One rendered check per changed page in a real browser before merge.
