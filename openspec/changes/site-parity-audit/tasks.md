# Tasks

## P0 — interaction parity

- [x] Brainwallet directory: `/brainwallet` index + 18 chain listings, 60 rows
  × 315 pages, auto addresses/balances, two copy icons per row, BTC type tabs,
  First/Prev/Random/Next/Last + Jump. Evidence: `render_brainwallet_directory`
  (`mod.rs:2979`; the 60×315 counts at `:2956`), `brainwallet-directory.js:36`
  (type tabs), `:209-219` (copy icons), `:351-470` (balances).
- [x] Brainwallet single calculator on `/brainwallet-generator` with network,
  passphrase, 1/3/5/10 addresses, Copy All/CSV. Evidence:
  `render_brainwallet_generator` (`mod.rs:3123`), `brainwallet.js:457-503`.
- [x] Seed rows: private key + copy icons; full phrase in the donor layout.
  The donor prints the whole mnemonic, so the earlier compact first-two/last-word
  reveal was dropped and each row shows the full phrase (mono, ellipsis with the
  phrase in `title`) plus a 44px Copy mnemonic button. The donor's row carries
  no WIF links (`directories.md:205`), and ours matches: the row links the hex
  key only. Evidence:
  `docs/donor-parity/directories.md` §3 (row markup and difference 11);
  `apps/site/mnemonic-seeds.js` (`createRow`/`fillRow`: `col-mnemonic`,
  `mnemonic-text`, `phraseText.textContent = entry.phrase`),
  `src/coordinator/mod.rs` (directory assertions),
  `apps/site/mnemonic-seeds-test.mjs`.
- [x] Puzzle home: 160-row table, All/Solved/Unsolved filters, search,
  Balance/TX/Actions. Evidence: `render_puzzle_home` (`mod.rs:4041`),
  `puzzle-browser.js:236-365`.
- [x] Puzzle random: Community Hunt counters and a live result table.
  Evidence: `render_puzzle_random` (`mod.rs:4419`),
  `puzzle-browser.js:367-432,864-886`.
- [ ] `/richest` + `/richest/<chain>` top-100 with type filter, search, copy and
  explorer. **Blocked on an owner decision, not on "no API".** Live capture
  2026-11-22: the donor serves seven chains (`bitcoin, ethereum, bnb, polygon,
  arbitrum, tron, dogecoin`) with Rank/Address/Label/Type/Balance/Actions and
  100 `Unknown` labels. A keyless ranked endpoint does exist:
  `GET https://sochain.com/api/v3/rich_list/<ticker>?page_size=100` answered
  200 with `access-control-allow-origin: *` and 100 ranked rows for BTC, DOGE,
  LTC and ZEC (2500 lookups a day per IP). It ranks UTXO chains only, so it cannot
  cover the donor's ethereum/bnb/polygon/arbitrum/tron lists, and the repo
  still has no licensed dataset (only gzip mirrors,
  `src/coordinator/wallets.rs:34-40`). The route stays absent rather than
  shipping 2 of the donor's 7 chains. Open question for the owner: ship a
  BTC/DOGE-only list, or supply a ranked dataset for the other five. Not faked.
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
  counters. Evidence: `key.js:563-569` (`scheduleDerive`), `key.html:78`
  (`#key-info-btn` icon action), `key-tools.js:218` (key-fact format summary).
- [x] Global search results in place: interpret-as, 1/3/5/10 addresses, table,
  Copy All/CSV. Evidence: `apps/site/search-test.mjs` (detect modes, row
  shaping per chain, public-only CSV), `node --check` for `site.js`/`search.js`,
  and the `key` route UI audit at 375/1280 in both themes. Donor counter and
  sub-type label: `apps/site/search.js` (`countLabel`, `mnemonicSubtype`),
  `apps/site/site.js` (live `N chars`/`N words` counter and the
  `Detected: Electrum SegWit|Legacy|Mnemonic` label from the lazily loaded
  `seed-crypto.js` `electrumSeedType`), and their assertions in
  `apps/site/search-test.mjs`.
  Directory-search detector parity: `apps/site/site.js:344` (`bindKeySearches`
  uses `RotorSearch.keyHref`, shared with the landing handler) and
  `apps/site/search.js:319` (`keyHref`) over `apps/site/search.js:27`
  (`looksLikeXrpSecret`; only 64 hex is a key; the landing address guard
  defers to it for base58 secrets). Nav highlight:
  `apps/site/site.js:33` (`sectionForPath`, `/keystore-parser` -> Tools),
  covered by `apps/site/site-nav-test.mjs`.
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
  (sign/broadcast without a key leak), `src/coordinator/mod.rs:1109` / `:1112`
  (route and embedded helper), `tests/coordinator_api.rs:1139` / `:1186`
  (six routes and the served helper). Nile testnet only: mainnet TRON hosts
  and the mainnet `tron` route are rejected, and no live broadcast was
  executed (no funded Nile key).
- [x] `/key` signing entry: the key page links to the testnet-only `/send`
  page instead of handing the key over; the visitor re-enters it there.
  Evidence: `apps/site/key.html` (`.key-sign-entry` link below the input
  meta row, beside the key card),
  `docs/site-map/site-map-data.js` (`/key` note: curve selector ships,
  signing entry links to `/send`), `openspec/changes/site-parity-audit/matrix.md`
  (`/key` row). Test note: the link is static markup with no key in the URL,
  covered by `apps/site/site-nav-test.mjs` route rules and
  `docs/site-map/site-map-test.mjs`; no browser assertion is needed because
  there is no scripted handoff.
- [x] Mnemonic directory Received formatting: values under 0.0001 coin render
  in atomic units (`sat`, `zat` for Zcash) in both the row and the summary,
  matching the donor's "small" wording (`docs/donor-parity/directories.md:183,
  207,228`). The donor doc does not record the exact constant, so 0.0001 coin
  (10,000 sat) is the inferred cut and is marked as such in `receivedText`.
  Evidence: `apps/site/mnemonic-seeds.js` (`ATOMIC_UNITS`, `receivedText`),
  `apps/site/mnemonic-seeds-test.mjs` (six cases).
- [x] Mnemonic directory Solana balances (2026-11-22, code-only): the Solana
  page previously rendered `—` for all 60 rows; it now uses one batched
  keyless `getMultipleAccounts` POST per page (official RPC first, publicnode
  fallback), parsed by `balance-cache.js`'s `parseSolanaAccounts`, and renders
  through the existing `coin`/`receivedText` path with 9 decimals and SOL.
  Evidence: `apps/site/mnemonic-seeds.js:39` (`SOLANA_RPC_URLS`), `:809`
  (`providerMetaFor`), `:1102` (`solanaBatchBody`), `:1111`
  (`solanaProvider`), `:1145` (dispatcher branch); tests at
  `apps/site/mnemonic-seeds-test.mjs:193` and `:207`; defect
  `mnemonic-solana-balances` in `docs/process/defects.json`.
  Audit coverage: `/mnemonic-seeds/solana` and `/mnemonic-seeds/ton` are now in
  `scripts/ui-audit.mjs` `DEFAULT_ROUTES` (18/18 page runs PASS, no violations;
  the Solana runs record a single 403 console warning in 4 of 6 runs on hosts
  whose browser the public RPC refuses, which is the honest retryable error
  state). The other
  chain pages stay out because their providers fan out one request per address.
- [x] `/key` P0 ledger rows: the seven donor `/PrivateKey*` and `/Bech32` rows
  still claimed "the interactive curve editor and signing entry remain". The
  donor key page has no derivation control (`docs/donor-parity/key-page.md` §3),
  and ours ships the curve selector plus the `/send` signing entry (previous
  bullet). The notes now name the real remainder: ZEC balances have no keyless
  provider (Blockchair 430 without a key; zcha.in unreachable, probed
  2026-11-21), while BCH was later wired through Haskoin (bullet below), so only
  the ZEC row shows `—` and the route status stays `partial` (superseded
  2026-11-22: the ZEC provider landed in PR #237 and the row is now parity).
  Evidence: `docs/site-map/site-map-data.js` (seven donor rows).
- [x] Mnemonic directory BCH/TRON/XRP/SUI balances (2026-11-22, code-only): the
  BCH, TRON, XRP and SUI pages previously rendered `—` for every row although
  keyless providers already served the private-key directory. The four chains
  now map to `haskoin-bch`, `tronscan`, `xrpscan` and `sui` metas; BCH uses one
  batched Haskoin GET per page (60 addresses, results mapped back by index
  because the provider echoes CashAddr) and a rejected batch fails every
  address instead of showing zero. The provider code moved out of `browse.js`
  into the shared `balance-providers.js` so the two directories cannot drift.
  LTC/DOGE/ZEC/TON stay `—` on this page (per-address provider budget); the
  ledger row stays `partial`. XRP is honest about its provider: XRPScan
  redirects some accounts to `data.xrpscan.com/tx.json`, which has no CORS
  header, so the XRP fetcher calls it with `{ redirect: 'error' }` and those
  rows show the retry state instead of a filled balance (they are not claimed
  as 60/60); BCH and SUI were verified at 60/60. Audit coverage:
  `/mnemonic-seeds/bitcoin-cash` is now in `scripts/ui-audit.mjs`
  `DEFAULT_ROUTES` (one batched Haskoin request per page, like Solana;
  TRON/XRP/SUI stay out because they fan out one request per address).
  Evidence: `apps/site/balance-providers.js:383` (`haskoinBatchUrl`), `:389`
  (`haskoinBchProvider`), `:414` (`FETCHERS`), `:436` (`fetchProvider`),
  `:214` (`accountJson` forwards fetch options), `:357` (`xrpBalance` passes
  `redirect: 'error'`); `apps/site/balance-cache.js:171`
  (`parseHaskoinBchBatch`); `apps/site/mnemonic-seeds.js:795` (`providerMetaFor`),
  `:1035` (delegating `fetchProvider`); `apps/site/browse.js:492` (delegating
  `fetchProvider`); tests `apps/site/mnemonic-seeds-test.mjs` (four metas, BCH
  order/index mapping, batch rejection, XRP redirect, browse-dispatch
  coverage), `apps/site/balance-cache-test.mjs` (`parseHaskoinBchBatch` 60-row
  case); defects `mnemonic-bch-balances`, `mnemonic-tron-xrp-sui-balances` and
  `mnemonic-xrp-redirect` in `docs/process/defects.json`.
- [x] Mnemonic directory TON v4R2/W5 (2026-11-22, code-only): the donor page's
  inline `MNEMONIC_SEEDS_PRESETS` derives TON at `m/44'/607'/0'` (Master `m` +
  Tonkeeper preset) and shows the v4R2/W5 wallets, while our page rendered an
  explicit unsupported state. `apps/site/mnemonic-seeds.js` now has the real
  `ton` config (`types` = `ton`/`ton_w5` at `m/44'/607'/0'`, `presets` =
  Master/Tonkeeper), the ed25519 derive branch builds `entry.addressMap.ton`
  from `window.RotorTon.address(report.ed_pubkey)` loaded lazily from `/ton.js`
  (build-prefixed, TON page only) while `ton_w5` comes from the WASM report, and
  `providerMetaFor('ton')` maps to the batched `tonapi` provider: one
  `POST /v2/accounts/_bulk` per page, accounts mapped back by request index
  (TonAPI echoes raw `0:hex` addresses), with a malformed/short body throwing
  so rows show the retry state, never a zero. `browse.js` uses the same
  `tonapi` batch, so `/private-keys/ton` no longer fans out; `toncenter` stays
  for the single-address `/key` page. Measured: `/mnemonic-seeds/ton` and
  `/private-keys/ton` each 60/60 rows `data-balance-state="ok"` at
  375/768/1280 in dark and light (12 runs, one request each); the TON ui-audit
  run is 6/6 PASS with zero console warnings and zero overflow. Evidence:
  `data/providers.json` (`tonapi`), `apps/site/balance-providers.js`
  (`tonApiBatchUrl`, `parseTonApiAccounts`, `tonApiProvider`, `FETCHERS`),
  `apps/site/mnemonic-seeds.js` (`ton:` config, `loadTon`, `deriveEntry`,
  `providerMetaFor`), `apps/site/browse.js` (`providerMeta`),
  `apps/site/mnemonic-seeds-test.mjs` (config/derive, one-POST mapping,
  malformed-body and TonAPI meta cases; `balance-state-attribute` stays green),
  donor source `https://privatekeyfinder.io/mnemonic-seeds/ton`
  (`window.MNEMONIC_SEEDS_PRESETS`, `PKF_CONFIG.type = null`). Deliberate derivation deviation, recorded rather
  than copied: the donor takes the BIP32 secp256k1 master bytes and feeds them
  to the v4R2 builder (row 0 abandon…about, master preset: key
  `1837c1be8e2995ec11cda2b066151be2cfb48adf9e47b151d46adab3a21cdf67`,
  address `EQD5BSqbqr-TBe8BHVx26V85ly7o5lkYFU0MKAJWVUwlkPZG`; Tonkeeper key
  `2d1b84ab366915a9b58d64ea6d3a8766e490479ac2ab8aea635603afe3ad6153`,
  address `EQBuAV_45fTfgLs-CqOtQnNP5rh-Z3xv0jVCL_Nz8C1fe-`), while we ship
  standard SLIP-0010 ed25519 (master key
  `560f9f3c94558b6551928bb781cf6092c6b8800b4fc544af2c9444ed126d51aa`,
  address `EQBql5EyfHFHHq0eULGOI7xdUWgk62w-HzLBlEcAyqYM79AN`; Tonkeeper key
  `b477ef5ed17fb8a2b8faddd7a9835a227243a82c70b190c7af4896155aa7df9f`,
  address `EQAzWZa6nM5mJev91wGc7VCSfBoIsYRqKJpV78N8Add9-U9d`), the standard
  real-wallet derivation the preset name implies. The donor has one v4R2 row
  per entry with static `0 TON` text and no address-type control; our v4R2/W5
  cards and live batched TonAPI balances are a deliberate superset.
  Ledger: `docs/site-map/site-map-data.js` (`/mnemonic-seeds/ton` now `parity`).
- [x] `/key` BCH balances (2026-11-22, code-only): Haskoin's keyless
  `GET https://api.haskoin.com/bch/address/balances?addresses=<addr>` answers
  200 with CORS `*` and satoshi balances (live probe 2026-11-22), so BCH rows no
  longer show `—`. `fetchHaskoinBch` + the pure `parseHaskoinBch`, `bch_`
  allowed in `rowHasProvider`/`rowCacheInfo`, and the `checkRow` dispatch; ZEC
  followed in the next bullet. Evidence: `apps/site/key.js`, `apps/site/balance-cache.js`,
  `apps/site/balance-cache-test.mjs`, PR #228.
- [x] `/key` ZEC balances + per-chain EVM explorer links (2026-11-22,
  code-only): SoChain v3 `GET https://sochain.com/api/v3/balance/ZEC/<addr>`
  answers 200 with CORS `*` and decimal ZEC strings (live probe 2026-11-22;
  Blockchair stays 430 without a key). `fetchSochainZec`
  (`apps/site/key.js:2317`) calls the pure `parseSochainBalance`
  (`apps/site/key-tools.js:1027`, satoshis without floats), `zcash_` is in
  `rowHasProvider` (`apps/site/key.js:2348`), `rowCacheInfo` (`:2555`) and the
  `checkRow` dispatch (`:2714`), so no chain group lacks a provider. The eight
  shared-EVM sub-rows now build their explorer anchor outside the
  `!sharedEvm` guard (`apps/site/key.js:1314`) from `explorerFor` in
  `apps/site/key-tools.js:988`, while copy/details/toggle stay suppressed.
  Evidence: `apps/site/key.js`, `apps/site/key-tools.js`,
  `apps/site/key-tools-test.mjs`, `scripts/ui-audit.mjs` (`key-zec-provider`). The
  matrix row is now `parity` after the independent browser review and the PR #237
  merge.
- [x] `/key` LTC/DOGE/ZEC through SoChain; directory providers (2026-11-22,
  code-only): BlockCypher answered HTTP 429 `{"error":"Limits reached."}` for
  LTC and DOGE, so those `/key` rows could not render a balance. Live probes
  that day: `GET https://sochain.com/api/v3/balance/{LTC,DOGE,ZEC}/<addr>`
  returned 200 with `access-control-allow-origin: *` and decimal coin strings
  (`{"data":{"confirmed":"0.14201511","unconfirmed":"0.00000000"}}`), and
  `GET https://litecoinspace.org/api/address/<ltc>` returned 200 with CORS `*`.
  SoChain allows 2500 lookups a day per IP, so a 60-row page is 2.4% of the daily
  budget (the old "per-address provider budget" premise was false). `sochain` is now the
  first provider for litecoin/dogecoin/zcash in `data/providers.json`;
  `fetchSochain` (`apps/site/key.js:2345`) builds the URL from the SSOT entry,
  LTC/DOGE fall back to `fetchBlockcypher` (`:2372`) and ZEC is SoChain-only;
  the render-time `data-balance-provider` carries the provider id (`:1257`), and
  `key-utxo-provider` (`scripts/ui-audit.mjs:1414`) fails if an LTC/DOGE/ZEC
  row names anything but `sochain`. The one decimal-string parser lives in
  `apps/site/balance-cache.js:158` (`key-tools.js` delegates);
  `providerMetaFor` (`apps/site/mnemonic-seeds.js:835`) and `providerMeta`
  (`apps/site/browse.js:391`) map all three chains to the shared
  `sochain` fetcher (`apps/site/balance-providers.js:458`). Evidence:
  `apps/site/balance-cache-test.mjs`, `apps/site/mnemonic-seeds-test.mjs`,
  `apps/site/key-tools-test.mjs`, defect `key-utxo-blockcypher-429`.
- [x] SoChain 429 stops the directory fan-out (2026-11-22, code-only): the
  provider's keyless allowance is 2500 lookups a **day** per IP (its 429 body
  says so), not 2500 an hour as three comments and two ledger notes claimed.
  Measured on an exhausted account: one 60-row mnemonic page fired **240**
  SoChain requests (60 addresses x inner retry x outer retry), every one a 429,
  so ten page loads would spend the whole daily budget. `sochainProvider`
  (`apps/site/balance-providers.js:482`) now records the first 429 and rejects
  the remaining addresses without a request; the rows keep the honest retry
  state. Mutation-proven: with the guard disabled the new test sees 240
  requests, with it <= 10. All hourly-quota claims are corrected in `key.js`,
  `mnemonic-seeds.js`, `browse.js`, this matrix and the two site-map notes.
  Defect `sochain-quota-storm`, detector `mnemonic-sochain-quota-storm`. The
  matrix row stays `partial`: the live 60/60 measurement is still missing, and
  the daily quota was already spent when this run probed it.
- [x] `/private-keys/bitcoin-cash` balances (2026-11-22, code-only): the
  60-row directory returned no provider meta for BCH and rendered `—` for every
  row, although the shared batched Haskoin provider already existed and the
  mnemonic directory used it. `providerMeta()` in `apps/site/browse.js` now
  returns `haskoin-bch` for `bitcoin-cash`, so one `GET /bch/address/balances`
  request fills all 60 rows (8 decimals, BCH). Rendered live: 60/60
  `data-balance-state="ok"`, first row `0.00001 BCH 59 tx`, matching the
  provider probe (`confirmed: 1000`, `txs: 59`); targeted audit 6/6 PASS with 0
  warnings at 375/768/1280 in both themes. `/private-keys/bitcoin-cash` is now
  in `scripts/ui-audit.mjs` `DEFAULT_ROUTES` (one batched request per run like
  the BCH seed page). Evidence:
  `apps/site/browse.js` (`providerMeta`), `apps/site/mnemonic-seeds-test.mjs`
  (the source lock), defect `bch-directory-balances`. ZEC/LTC/DOGE were still
  unwired on that page at that point; the SoChain P0 bullet above wires all
  three.
- [x] `/key/<WIF>` accepts uncompressed LTC/DOGE WIFs (2026-11-22, code-only):
  both start with `6` (version 0xb0/0x9e, 33-byte form) and were rejected by
  the first-byte prefilter although the decoder already handled them. Evidence:
  `src/coordinator/mod.rs` (`normalized_key_hex`), test
  `key_url_accepts_uncompressed_litecoin_and_dogecoin_wifs` in
  `tests/coordinator_api.rs`, PR #227.
- [x] Ledger honesty pass (2026-11-22, docs-only): ten stale `file:line`
  citations corrected; the `/private-keys` rows no longer claim per-row WIF
  links (PR #218 made them key-level); the mnemonic row no longer claims WIF
  copy (the donor row has none); puzzle detail is `partial` for the missing
  Discussion link (its target is not recorded) and the blocked Solution field;
  the wrong `parity` cells for the brainwallet generator and pubkey-add are
  fixed.
- [x] Ledger honesty pass for ZEC (2026-11-22, docs-only): the seven secretscan
  `/PrivateKey*`/`/Bech32` donor rows, the `/key` route entry and the three
  `/key/<format>` aliases still said ZEC had no keyless provider and stayed
  `partial`. PR #237 wired SoChain (`apps/site/key.js:2336`, dispatch `:2733`)
  and the matrix row is already `parity`, so those rows are now `parity` with
  the correct provider list; the `key-balances` note distinguishes the
  single-key ZEC provider from the 60-row private-key directory (BCH has a
  batched Haskoin provider used by the mnemonic directory but not wired here;
  ZEC is per-address). Evidence: `docs/site-map/site-map-data.js`,
  `node docs/site-map/site-map-test.mjs`.

## Live donor audit follow-ups (2026-11-21)

Source: `docs/donor-parity/parity-live.md` (live route/DOM comparison). These
follow-ups were code-only.

- [x] Directory `?key=` jumps to the page that contains the key (60 keys per
  page, clamped to `data-pages`, `location.replace`, only when the computed
  page differs from `data-page`; keeps `key` and `type`). Evidence:
  `apps/site/browse.js` (`pageForHexKey`, `jumpToKeyPage`, `data-page` config),
  `apps/site/search-test.mjs` (`0xdeadbeef` -> page 62,265,476; clamping;
  non-hex/zero rejection).
- [x] `/key/<value>` accepts a `0x`/`0X` prefix and 1–64 hex digits,
  left-padded to 64; the WIF path and existing key-value forms stay; all-zero
  and arbitrary text are real 404s (deliberately not the donor's soft-404).
  Evidence: `src/coordinator/mod.rs` (`prefixed_hex_key`),
  `seo_key_page_accepts_short_and_prefixed_hex`.
- [x] `/vanity-generator` -> `/vanity` and `/downloads` -> `/wallets`
  permanent aliases, exact paths only. Evidence: `redirect_target`,
  `donor_route_aliases_redirect_to_canonical_paths`.
- [x] Key-page balances: XRP (XRPScan), SOL, SUI (GraphQL) and TON (TON Center)
  are wired in `apps/site/key.js` / `key-tools.js`, with response codecs in
  `apps/site/balance-cache.js` and tests in `apps/site/balance-cache-test.mjs`.
  LTC (all four address types) and DOGE now load through BlockCypher's keyless
  balance endpoint (CORS `*`; Litecoin taproot verified), with the same codec
  and test coverage. BCH/ZEC stay provider-less (Blockchair answers 430 without
  a key), so those rows show — instead of a fake zero.
- [x] One `?key=` implementation on directory pages: a parallel change added a
  second path that called undefined `normalizeKeyHex`/`jumpPageFor` and threw
  on pages without `search.js`; removed, so `pageForHexKey`/`jumpToKeyPage` is
  the only path (PR #147).
- [x] Directory ledger corrected (2026-11-21, thirteenth run):
  `/private-keys/<chain>` re-checked against the live donor; the donor has
  neither a CSV export nor balance sorting, so the site-map note, the
  `parity-live.md` row (now `same`) and the matrix row (now `parity`) state the
  matched controls instead.
- [x] Ledger leftovers from that correction (2026-11-21, sixteenth run):
  `docs/site-map/site-map-data.js` still carried a `key-csv-sort` feature row
  with `donor: 'present'` / `status: 'missing'` and a donorRoute
  `/private-keys/<chain>` still on `partial`. A full live fetch of the donor
  page confirmed neither CSV nor sort controls (the only `csv` hits are inside
  `%3csvg`), so the feature row was deleted and the donor route moved to
  `parity` (PR #176). The matrix global-search cell also stopped claiming
  "no redirect": a mnemonic hands off to `/mnemonic-converter` with the phrase
  in sessionStorage, as the site-map note already recorded.
- [x] WIF detection parity (2026-11-22, code-only): all three input contexts use
  the donor shape `^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{50,51}$` and the global search
  decodes Litecoin (0xb0) and Dogecoin (0x9e) WIFs, not just Bitcoin (0x80) and
  BCH. Evidence: `apps/site/key.js:291` (`WIF_RE`/`WIF_PARTIAL_RE`),
  `apps/site/key-tools.js:381` (`SEARCH_WIF_SHAPE`, also used by
  `routeKeyInput` and `resolveKeyInput`; error text at `:459`),
  `apps/site/search.js:19` (`WIF_RE`) and `:157-158` (`decodeWif` versions),
  `docs/donor-parity/directory-pages.md:29`, `docs/donor-parity/directories.md:82`.
  Tests: `apps/site/key-tools-test.mjs` ("Litecoin (version 0xb0) and Dogecoin
  (0x9e) WIFs" round-trip block, "Litecoin/Dogecoin WIF" routing block) and
  `apps/site/search-test.mjs` ("Litecoin (0xb0) and Dogecoin (0x9e) WIFs"
  detection block).
- [x] Brainwallet directory key links (2026-11-22, code-only): the hex key is an
  `<a href="/key/<hex>">`, and BTC/BCH/LTC/DOGE rows append `WIF(c)` and `WIF(u)`
  links; the error/— state calls `clearKeyLinks` so no stale target remains.
  Evidence: `apps/site/brainwallet-engine.js` (`keyLinksFor`, explicit WIF
  values), `apps/site/brainwallet-directory.js` (key link + WIF line,
  `fillKey`/`wifsFor`/`clearKeyLinks`), `apps/site/brainwallet.css`
  (`.bw-key-link`, `.bw-key-wif`), `docs/donor-parity/directory-pages.md:57`.
  The index copy now states that a HEX/WIF click puts the key in the browser URL
  (`src/coordinator/mod.rs:2969`). Test: `apps/site/brainwallet-test.mjs`
  ("BTC key cell links hex + both WIFs", "BCH shares the 0x80 WIFs", LTC/DOGE
  network-prefix blocks, "ETH/TON keep only the hex link").
- [x] Per-chain WIF encoding (2026-11-22, code-only): `derive_report` always
  emits the Bitcoin version (0x80), so the brainwallet directory re-encodes
  LTC (0xb0) and DOGE (0x9e) while BTC/BCH keep the report value; non-UTXO
  chains show no WIF. The `/private-keys` listing intentionally renders no row
  WIF links (PR #218: hex, address and balance only; the WIF stays on
  /key/<hex>), so per-chain encoding applies to the brainwallet directory only.
  Evidence: `apps/site/key-tools.js` (`wifEncode` optional `compressed`
  argument, 37-byte form), `apps/site/brainwallet-directory.js`
  (`WIF_NETWORKS`, `wifsFor`), `src/coordinator/mod.rs` loads `/key-tools.js`
  before `brainwallet-directory.js`. Tests: `apps/site/key-tools-test.mjs`
  uncompressed LTC/DOGE round-trip, `apps/site/brainwallet-test.mjs`
  LTC/DOGE WIF prefixes.
- [x] Key-directory search copy follows the chain (2026-11-22, code-only): the
  donor names each chain's own WIF shape in the search placeholder and hint;
  ours said Bitcoin's 5/K/L on all 18 directories. `browse_search_placeholder` /
  `browse_search_hint` now render BTC/BCH/ZEC 5/K/L, LTC 6/T, DOGE Q/6 and
  `HEX or Brainwallet` on account-model chains. Evidence:
  `src/coordinator/mod.rs` (helpers + call sites). Test:
  `browse_search_placeholder_names_the_chain_wif_shape`.

## P1 — shell and templates

- [x] One filter bar (search + type + chain chips + reset), pager separate,
  stats in the table footer. The directory type select is donor parity, not a
  duplicate: privatekeyfinder renders `#searchType` and syncs it with
  `.address-type-selector` (`docs/donor-parity/directory-pages.md` §1). `/key`
  renders one `.key-filter-bar` and a separate pager, and the audit
  `duplicate-preset-control` detector fails a second copy of the same control.
- [x] Reusable icon-button (28/36/44, copied state) and compact row. Evidence:
  `.icon-button` variants and `icon-button-scale` (batch 2),
  `row-action-geometry` and the shared row rhythm (batch 5); `--control-h-lg`
  is 44px and `--lg` uses it. Page-local leftovers: `#key-info-btn` moved from
  `key-info-btn` to `icon-button icon-button--quiet` and the local CSS block was
  deleted; detector `icon-only-shared-component` fails any icon-only control
  without the class, defect `key-info-page-local-button` (PR #177). The generic
  `button:not(.primary):hover` rule now excludes `.icon-button`, so the quiet and
  outline variants own their hover borders (quiet stays transparent per
  DESIGN-SYSTEM §3.2); detector `quiet-icon-hover-border` and defect entry
  `quiet-icon-hover-border` are in place, mutation-proven (FAIL before the rule
  change, PASS after).
- [x] Shared skeleton/empty/error primitives. Evidence: `.empty-state`
  (dashed `--line-subtle`, radius `--radius-l`, padding `--space-5`) replaced
  `.key-empty` (both rules), `.range-empty` and `.monitor-empty` in `site.css`,
  `key.html`, `key.js`, `range.html`, `range.js` and `monitor.html`; `.skeleton`
  is the block primitive for the range rows and the key-status bar (tokens,
  12px, `aria-hidden`, shimmer off under reduced motion); `.error`,
  `.key-error`, `.range-error` and `.monitor-status` share one
  `--space-3` top margin. Detector `empty-state-grammar` (static + rendered
  geometry) and the `page-local-empty-states` ledger entry are in place.
  Rendered coverage: four cabinet empty boxes measured at 375/1280 in both
  themes (dashed, radius 12, padding 20); the `/key` and range placeholders and
  the error boxes are hidden until interaction and are enforced by the static
  half. PR #170.
- [x] Header: 4 primary links + More/drawer at ≤860 px; icon-only search/theme.
  Evidence: `apps/site/site.js` (`RotorSiteNav.splitLinks`/`activeInTail` and
  `setupNav`: four inline links, the rest in an `aria-expanded` More
  disclosure, Escape/outside-click close, idempotent rebuild on resize);
  `apps/site/site.css` (drawer styles, 44px targets, icon-only inline links
  ≤520px, reduced motion off); search and theme toggles were already
  icon-only; `apps/site/site-nav-test.mjs`.
- [x] Tools index: 8 families with alias rows. Evidence:
  `apps/site/tools.html:45,62,75,89,101,114,130,143` (eight `article.tool-family`
  blocks), `apps/site/site.css:4161` (`.tool-family-links` chips, 44px targets).
- [x] Address types: BCH legacy + CashAddr, DOGE compressed/uncompressed,
  ZEC transparent compressed/uncompressed. Evidence:
  `apps/site/address-codecs.js` (CashAddr + Base58Check encoders),
  `apps/site/key.js` (`attachComputedTypes`), `apps/site/address-codecs-test.mjs`
  (BCH spec translation vectors; DOGE/ZEC addresses independently reproduced
  with Python), UI audit on `/key` and `/key/<key1>` at 375/768/1280 in both
  themes.
  LTC Taproot card: `crates/rotor-wasm/src/derive.rs:466,580` (`ltc_p2tr` row,
  bech32m) and `lib.rs:1761` (vector); `src/coordinator/mod.rs` `LTC_TYPES`
  gains the fourth `taproot`/`ltc_p2tr` entry (feeds both the `/private-keys`
  cards and the `?type=` switch); `apps/site/browse.js` `TYPE_FIELDS.litecoin`,
  `apps/site/brainwallet-engine.js` `LTC_TYPES` and `apps/site/key.js`
  `ID_LABELS.ltc_p2tr` map it to `'Litecoin taproot'`;
  `litecoin_directory_exposes_taproot_card_and_field` asserts the card and
  `data-field="ltc_p2tr"`, and the brainwallet LTC assertion now expects four
  types. Balance lookup already covers bech32m.
- [x] TON v5/W5 address type (PR #105). Evidence:
  `crates/rotor-wasm/src/ton.rs` (official `wallet_v5` code cell, pinned
  upstream commit), `crates/rotor-wasm/src/derive.rs:717` (`ton_w5` row
  from `w5_address`), `crates/rotor-wasm/ton-w5-vectors.mjs` (independent
  Tonkeeper V5R1 vectors), `apps/site/key.js:99,123,145` and
  `apps/site/key-tools.js:799` (label, explainer, derivation steps),
  `crates/rotor-wasm/src/lib.rs:1890` (row assertion). v4R2 stays as the
  second TON row; directory tabs still show one type per chain.
- [x] Breadcrumbs on every public page; one current crumb per trail. Evidence:
  `apps/site/*.html` (crumb as the first child of `<main>` on docs, key, vanity,
  seed, mnemonic-converter, milk-sad, tools, hex-dec-bin, public-key,
  pubkey-add, keystore-parser, reconstruction, tx, tx/bitcoin, tx/ethereum and
  send), `src/coordinator/mod.rs`
  (`public_pages_render_one_breadcrumb_and_one_current_crumb`; the generated
  `/private-keys` hub gained its visible trail). Main-nav and chain-tab
  `aria-current="page"` markers stay in place: they are different landmarks,
  and the test scopes its count to the breadcrumb nav.
- [x] Seed converter: live word counter, 20 addresses, Load next 5, Copy All.
  Evidence: `apps/site/mnemonic-converter.html:75` (live counter),
  `:86` (20-address option), `:106-107` (Copy All / Load next 5),
  `:109` (Active/Sum aggregate); `apps/site/seed-page.js:397` (word counter and
  scheme hint), `:653` (`loadNextBatch`, next five per path from the snapshot),
  `:1082` (`aggregateText`, honest aggregates), `:1177` (public rows only, never
  keys); `apps/site/seed-test.mjs` (word hints per scheme, batch index math, a
  pinned 20-address derivation).
- [x] Seed converter lifetime Received aggregate (2026-11-22, code-only): the
  BTC balance provider (`blockchain.info/balance`) already returns
  `total_received` beside `final_balance`/`n_tx` in the same response, so the
  aggregate line now adds ` · Received: <BTC>` before ` · Sum:` for a fully
  checked BTC result set. No extra request and no invented value: EVM rows and
  any row without a numeric total show no Received segment. Evidence:
  `apps/site/seed-page.js:1016` (`entry.receivedValue = BigInt(info.total_received
  || 0)`), `:1011`/`:1024` (missing row and error clear it), `:1082`
  (pure `aggregateText`), `:86` (export); test
  `apps/site/seed-test.mjs:337` ("aggregateText adds the BTC lifetime Received
  total and keeps the usual wording"); defect `seed-received-aggregate` in
  `docs/process/defects.json`.
- [x] Vanity: difficulty, ETA and a recent-address list. Evidence:
  `apps/site/vanity.html:68` (expected work next to the pattern inputs),
  `:74-77` (Attempts / Rate / ETA / Elapsed, four even groups), `:87-90`
  (recent matches card); `apps/site/vanity.js:22-55` (alphabet, attempts and
  ETA helpers), `:285` (`addRecent`), `:223-241` (localStorage whitelist:
  chain, pattern, address, foundAt only); `apps/site/vanity-test.mjs`
  (difficulty/ETA math and a sanitizer test proving `key`/`wif`/`priv_hex`
  never survive). Deliberate deviation: private keys and WIF are never saved,
  and the page keeps saying so.
- [x] Vanity: multi-thread workers. Evidence: `apps/site/vanity-worker.js`
  (classic worker: `assetUrl('/rotor_wasm.wasm')` at `:26-31`, random key per
  attempt, 250 ms progress
  and match messages), `apps/site/vanity.js` (`threadCount` clamped 1-4,
  worker pool, aggregate attempts/rate/ETA, first match terminates the pool,
  `sanitizeWorkerMessage`, single-thread fallback on worker failure),
  `src/coordinator/mod.rs` (embedded `/vanity-worker.js` asset and route),
  `apps/site/vanity-test.mjs` (thread clamp, pattern/match rule, message
  sanitizer, keys never saved), `tests/coordinator_api.rs` (asset is served).
- [x] Vanity: QR output. Evidence: `apps/site/qr.js:348` (`encode`: byte
  mode, EC-M, versions 1-6), `apps/site/qr.js:55` (Reed-Solomon) and
  `apps/site/qr.js:323` (mask penalty), `apps/site/vanity.js:547` (`paintQr`:
  address-only payload, integer scale, 4-module quiet zone, hides the row if
  encoding fails), `apps/site/vanity.html:83` (canvas in the result card),
  `apps/site/qr-test.mjs` (pinned reference hashes and structural checks),
  `src/coordinator/mod.rs` (embedded `/qr.js` asset and route).
- [x] Keystore parser: drag-drop file, examples, metadata. Evidence:
  `apps/site/keystore-parser.html` (`.dropzone`, visible file label around a
  focusable input, Load example), `apps/site/keystore-parser.js`
  (`readKeystoreFile` with a 64 KiB cap, `KEYSTORE_EXAMPLES`, id/version/
  cipher/declared-address facts), `apps/site/keystore-parser-test.mjs` (9
  tests including a wasm decrypt of the shipped web3 secret-storage vector),
  `apps/site/site.css` `.dropzone`, `docs/design-system/DESIGN-SYSTEM.md` 3.16.
- [x] Pubkey-add: P−Q and scalar multiplication. Evidence:
  `crates/rotor-wasm/src/derive.rs:309` (`pubkey_subtract_report`),
  `:323` (`pubkey_mul_report`, scalar 1..n−1), `:346` (shared point report);
  `crates/rotor-wasm/src/lib.rs:441` / `:458` (session methods), `:985` /
  `:1013` (C exports); `apps/site/pubkey-add.html:45-46` (operation select);
  `apps/site/key-tools-test.mjs` (pinned P2−P1=P1, k·G, zero-scalar rejection);
  `cargo test -p rotor-wasm` 75 passed.

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
- [x] Batch endpoint `GET /v1/balances?chain=&addresses=<csv>` (cap 60).
      Evidence: `deploy/cloudflare/src/worker.mjs:112` (handler: chain/CSV
      validation, normalize + dedupe, per-item fresh/stale/miss handling),
      `:145` (`batchBalance`), `deploy/cloudflare/test/worker.test.mjs:540`
      (fresh order), `:578` (dedupe), `:598` (empty/61/bad chain), `:618`
      (one invalid item), `:639` (bucket: 8 resolve, 9th `rate_limited`),
      `:661` (stale + `waitUntil`); 41 worker tests pass.
- [x] Per-client (IP-keyed) token bucket wired into every public route
      (120 burst, 20 tokens/s refill, LRU-bounded at 5000 keys, 10 min idle
      prune); `OPTIONS` and `GET /healthz` are exempt and `/v1/balances`
      charges one token per address (clamped to 60). Evidence:
      `deploy/cloudflare/src/limiters.mjs:43` (`createKeyedLimiter`),
      `src/worker.mjs:37` (module limiter), `:78` (pre-routing check),
      `:294` (`requestCost`), `:303` (`enforceClientLimit`, 429 +
      `Retry-After`), `test/worker.test.mjs:229` (keyed limiter unit tests),
      `:928` (exhausted IP gets 429, another IP unaffected), `:947`
      (`/healthz` exempt), `:957` (per-address batch cost); 48 tests pass.
      Honest limitation: the counter is per isolate, so it is a best-effort
      per-isolate quota across a PoP, not a global or cross-isolate guarantee.
- [ ] Client wiring + deploy. **Blocked: no valid Cloudflare credential**
      (`CF_PAGES_TOKEN` is rejected by the API); needs `wrangler login` or a
      Workers token. The site must keep calling providers directly until the
      worker is live, so no fake endpoint is wired.

## Verification

- [x] UI audit harness no longer invents a same-origin failure: a
      `Network.loadingFailed` whose request id was never announced by
      `Network.requestWillBeSent` is ignored instead of falling back to the
      base origin, so a browser-injected external request cannot surface as a
      false `http-error`. Known same-origin failures still violate. Defect
      `unknown-request-id-false-positive` in `docs/process/defects.json`
      (51 entries, all detectors present), PR #185.
- [x] Durable UI self-review harness: `scripts/ui-audit.mjs` (zero-dep CDP,
      375/768/1280, dark/light, screenshots + JSON), project skill
      `.claude/skills/ui-self-review/SKILL.md`, wired into the UI gate and
      `projects.json` site build/test.
- [x] `docs/site-map/index.html` updated for every completed row; no false parity.
  Evidence: send rows now point at `/send/bitcoin` and `/send/ethereum`
  (partial, testnet-only), the six key rows and `key-page-flow` describe the
  shipped counters/Copy All/CSV instead of claiming they are absent;
  `site-map-test.mjs` passes (93 ours, 118 donors, 40 features).
- [x] UI gate 375/768/1280, light/dark, keyboard, reduced motion.
  Evidence: `node scripts/ui-audit.mjs --serve` PASS 192/192 page runs across 32
  routes after PR #139 added every public `text/html` route (tools, tx, docs,
  `/send/bitcoin`, `/send/ethereum`). The `route-coverage` check now fails with
  exit 2 when a public page route is missing from `DEFAULT_ROUTES`; `/milk-sad`
  (the first page it caught) had two sub-12px exponents, fixed in the same PR.
  `/brainwallet` and the chain routes went from four 22px links to >=44px after
  the `.directory-links` fix.
- [x] `node scripts/check-projects.mjs`, site tests, cargo tests, clippy.
  Evidence: 16 site suites + 31 `node --check` lines pass; `check-projects`
  OK (393/394, `Cargo.lock` ignored); `coordinator_api` 18, `coordinator_client`
  3, `rotor-wasm` 75 pass; `cargo test --release` 0 failures;
  `cargo clippy --all-targets -D warnings` and `cargo fmt --check` clean.
  `node --test deploy/cloudflare/test/worker.test.mjs` 41/41, now wired into the
  `ops` test list and the `projects` CI job (PR #138).

## Relocation to internal docs (done)

- [x] Move the parity map from the public site to `docs/site-map/`
  (`index.html`, `site-map.css`, `site-map.js`, `site-map-data.js`,
  `site-map-test.mjs`, local `icons.svg` and `theme.js`); relative assets only.
- [x] Drop `/site-map`, `/site-map.css`, `/site-map.js` and `/site-map-data.js`
  from the coordinator routes, embedded assets and sitemap; route tests and
  `/docs`/`/tools` links no longer reference the public path.
- [x] Run the data test from `docs/`: `node docs/site-map/site-map-test.mjs`.
