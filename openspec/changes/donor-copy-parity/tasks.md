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
- [ ] Stats row (TOTAL VALUE / HAS BALANCE / ACTIVE / CHECKED) with the donor's
      meaning, or an explicit reason we cannot compute it client-side.
- [ ] Keys table row order and labels match the donor.
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
- [ ] Stats semantics: `Checked` = chains checked / 18 (constant), `Has
      Balance` and `Active` count unique chain groups, not rows.
- [ ] Status vocabulary and row tints: green amount with full precision in
      `title`, amber check for active/empty, `-` for checked-empty, `!` for
      errors, spinner while pending.
- [ ] Keys table: eight donor rows (drop our extra Curve row unless needed);
      `Page` links to `/private-keys/bitcoin/<ceil(decimal/60)>`.
- [ ] Do NOT canonicalise the URL: the donor echoes the input verbatim; every
      key form renders the same page in place (owner confirmed the behaviour,
      not a URL rewrite).

- [ ] Stats row `TOTAL VALUE` in USD needs a price source. Decision recorded
      below once made; until then show native amounts, never a fake USD total.


## 2. Search and directories (donor audit)
- [ ] Global search matches the donor's input types and lands on `/key/<hex>`.
- [ ] `/private-keys`, `/private-keys/<chain>`, `/mnemonic-seeds/<chain>`
      column sets and grouping copied from the donor.
      Audit note (2026-11-20): donor column sets, grouping and global-search
      mechanics are recorded in `docs/donor-parity/directories.md`; site parity
      is still to verify.

## 3. secretscan.org ideas
- [ ] Lists/pricing pages, filters and density reviewed; adopted items listed
      in `docs/donor-parity/secretscan.md`.

## 4. Rename Rotor → Crypto
- [ ] UI wordmark, `<title>`, meta descriptions, docs headers.
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

## Gates
- `node scripts/ui-audit.mjs --serve` — 0 violations at 375/768/1280, light/dark.
- Site tests, coordinator tests, `node scripts/check-projects.mjs`.
- One rendered check per changed page in a real browser before merge.
