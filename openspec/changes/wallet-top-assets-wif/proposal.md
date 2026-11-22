# Wallet top-10 assets and first-class key onboarding

## Summary

Add a top-10 assets table to `/cabinet/wallet` and make restoring a single
private key or WIF a visible onboarding choice next to a seed phrase. The asset
list is a new SSOT file, `data/assets.json`; the page reads a balance only where
a real provider path exists and never prints a failed or unrequested balance as
zero.

## Why

The wallet showed per-address balances and a portfolio total but not the ten
largest assets by market cap, so a holder had no market-cap view. Most wallets
also accept only a seed phrase; this vault already accepts a WIF and a 64-hex
key, but that fact was buried inside the unlocked panel. Both gaps are
discoverability problems with a honesty constraint: an asset row must not
invent a balance, a price or a zero.

## Decisions

1. **One asset SSOT.** `data/assets.json` is the only list: symbol, name,
   chain (or `evm` for a multi-chain token), a contract per chain, decimals,
   ticker or an explicit peg, rank and market-cap rank. `gen-ssot.mjs` validates
   it and generates `apps/site/assets.generated.js`; `check-ssot` fails on a
   stale output, a duplicate rank, an unknown chain, a contract on a native
   asset or a missing price source.
2. **Only real read paths are balances.** Native rows use the shared
   `RotorBalanceProviders` path; ERC-20 rows use `balanceOf` over the chain's
   public RPC; the TRC-20 USDT row reads the TronScan account response. An asset
   without a wired path renders `unavailable`, and a provider failure renders
   `lookup failed`; neither is counted as zero.
3. **Per-network rows.** A multi-chain token (USDC) renders one row per network
   instead of one invented aggregate, so the Chain column is always true. Rows
   follow rank order and the declared network order.
4. **USD only from the shared ticker.** Prices come from the same six-hour
   Binance cache as `/key`; USDC uses the Binance `USDCUSDT` pair. USDT has no
   USDT pair and is valued at its explicit `$1.00` peg, stated in the data and
   in the page help. A stale, loading or offline ticker keeps the native amount
   and prints `—`; the total is `—`, not `$0.00`, until a row loads.
5. **No new price provider, no new key parser.** The table reuses
   `RotorAmount` for atomic formatting, `key-tools.js` for the ticker and
   `atomicToCents` for BigInt cents. WIF and 64-hex parsing stays in
   `parseSecret`; onboarding only points at the existing import form.
6. **Two first-class onboarding entries.** A shared 44px `.chip` pair says
   “I have a seed phrase” and “I have a private key / WIF”. The key choice
   focuses the WIF/64-hex field after the vault is created or unlocked, and the
   safety copy says the key is encrypted locally and never sent to the server.
7. **Shared grammar.** The table is `.data-table` inside `.table-scroll` with a
   total row; no page-local styles or control sizes are added.

## Scope

In scope:

- `data/assets.json`, its validator and generated client copy.
- The top-10 table with loading, empty, error, `not loaded`, `unavailable` and
  failed states, a total row and per-network values.
- Native, ERC-20 and TRC-20 read paths through existing public providers.
- The onboarding chip pair and the runtime WIF/hex reachability scenario.
- Tests, detector registry entries, the defect ledger and site-map/help copy.

Out of scope:

- SPL, jetton or other token standards with no existing read path.
- A second price provider, a server-side portfolio or new API endpoints.
- Changing key parsing, derivation or vault encryption.
- Screenshots in the repository; UI evidence stays a CI artifact.

## Verification

- `apps/site/wallet-assets-test.mjs`: data validation, rank/network order,
  BigInt USD math, the USDT peg, not-loaded/unavailable/failed rows and the
  provider body decoders.
- `apps/site/wallet-onboarding-test.mjs`: the static onboarding contract.
- `scripts/ui-audit.mjs` wallet scenario: the table shell, rank order, honest
  initial state, loaded `$63,015.10` against a stubbed provider and ticker, a
  failed BTC row excluded from the total, and WIF plus 64-hex submissions from
  the onboarding chips.
- Wallet suites, `cargo test --release --test coordinator_api`, the full
  `ui-audit --serve`, `check-projects`, `check-ssot`, `check-defect-ledger` and
  `gen-detector-docs --check`.
