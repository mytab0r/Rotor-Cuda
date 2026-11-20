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
      Evidence: `apps/site/key.html:158-176` (four cards plus the explanatory
      note), `apps/site/key.js:2199-2206` (counters update from
      `balanceCounters`); TOTAL VALUE shows `—` with a title because there is
      no price source.
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
- [x] Stats row `TOTAL VALUE` in USD needs a price source. Decision: no price
      feed is wired, so the card shows `—` with an explicit title and native
      balances stay per chain; never a fake USD total.
      Evidence: `apps/site/key.html:161` (title), `:176` (note). Wiring a price
      source remains an owner decision, not a parity gap.


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
      cards, 60-row grid headers), `apps/site/browse.js` (hex + WIF (c)/(u)
      links, `(c)/(u)` address lines, per-address balance/TX/received,
      `?key=` prefill/highlight), `apps/site/mnemonic-seeds.js` +
      `mnemonic-seeds.html` (three headers + full-width mnemonic sub-row,
      bits/preset/path/type query scheme, word-count reset to page 1,
      preset pills). Deliberate deviations: the H1 is kept but
      `visually-hidden` (document outline/landmark) on both directories; the
      page-percent value is hidden at <=560px to keep the page-info line on
      one row; zero-provider metrics render `-`, never invented data.

## 3. secretscan.org ideas
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
- [ ] Implement the processor-free order flow: `POST /api/v1/orders`,
      `GET /api/v1/orders/{id}` (order token), `GET /api/v1/orders/{id}/download`
      (HMAC token, 7 days, 5 downloads), admin revoke/reconcile.
- [ ] Per-order deposit address (watch-only xpub) or unique-amount fallback;
      poller with BTC 3 / LTC 6 / TRON 19 / ETH 12 / BSC 15 confirmations.
- [ ] Every delivered package carries the licence/attribution page (MIT notice
      for our lists; CC0 provenance for donor-derived data).
- [ ] Prices, accepted chains and refund policy are owner decisions; ship with
      `active=false` lists until they are set.

## Gates
- `node scripts/ui-audit.mjs --serve` — 0 violations at 375/768/1280, light/dark.
- Site tests, coordinator tests, `node scripts/check-projects.mjs`.
- One rendered check per changed page in a real browser before merge.
