# Tasks: wallet portfolio summary

## 1. Summary math

- [x] Add `apps/site/wallet-summary.js` as a pure, DOM-free module:
  per-chain BigInt aggregation, fiat cents through `key-tools.js`, display
  helpers and the `loadState` mapping.
- [x] Sum only rows whose state is `ok`; count loading, failed and missing
  rows separately and never coerce them to `0n`.
- [x] Keep `0n` as a real loaded zero, distinct from "nothing loaded".
- [x] Exclude chains without a price from USD and return their labels; keep
  Bitcoin testnet unpriced even though its symbol is `BTC`.
- [x] Return `cents: null` and `totalText === "—"` for empty, loading, stale
  and offline states; keep per-chain native totals in every state.
- [x] Name every loaded chain as excluded in the stale and offline states.

## 2. Shared ticker

- [x] Export `PRICE_CACHE_KEY` and `PRICE_TTL_MS` from `key-tools.js` and use
  the same pair from `/key` and the wallet.
- [x] Cache a successful ticker response for six hours in localStorage and
  mark a failed refresh with a previous cache as stale.
- [x] Do not fetch prices before at least one balance has loaded.

## 3. Cabinet wallet UI

- [x] Add the summary block above the address groups with total value, loaded
  count, entry count, per-chain native list, empty state, status line and
  refresh timestamp.
- [x] Render the block with the shared `.stat` grammar and a 44px
  `.icon-button` refresh control with `aria-label` and `data-tooltip`.
- [x] Route the refresh action through the existing per-row load path so every
  entry, including one without a derived address, receives an honest state.
- [x] Keep the address rows and their per-row Balance action unchanged.
- [x] Reset balances, price state and the refresh timestamp on lock; delete a
  removed entry's balance.

## 4. Tests and audit

- [x] Add `apps/site/wallet-summary-test.mjs` covering per-chain BigInt sums,
  USD cents, unpriced exclusion, `0 loaded` vs `0 balance`, stale/offline
  handling, excluded names, a row without a derived address and formatting.
- [x] Extend the wallet scenario in `scripts/ui-audit.mjs` with a stubbed
  balance RPC and ticker: empty state, loaded `$3,000.00`, loaded zero,
  `1 of N` count, per-chain `1 ETH`, refresh timestamp, 44px control, stat
  token grammar and no overflow.
- [x] Register the new detector `wallet-portfolio-summary` in
  `data/detectors.json`, add a `docs/process/defects.json` entry and
  regenerate the detector tables.
- [x] Register `node --check apps/site/wallet-summary.js` and
  `node apps/site/wallet-summary-test.mjs` in `projects.json`.
- [x] Serve `wallet-summary.js` from the coordinator and assert it in
  `cargo test --release --test coordinator_api`.

## 5. Docs

- [x] Update the `/cabinet/wallet` note in `docs/site-map/site-map-data.js`.
- [x] State in the page help that only loaded balances are counted and that
  unpriced chains are excluded from USD.

## 6. Verification

- [x] `node apps/site/wallet-summary-test.mjs`
- [x] `node apps/site/key-tools-test.mjs apps/site/rotor_wasm.wasm`
- [x] `node apps/site/wallet-vault-test.mjs`
- [x] `node apps/site/wallet-evm-test.mjs`
- [x] `node apps/site/wallet-mainnet-test.mjs`
- [x] `node apps/site/wallet-erc20-test.mjs`
- [x] `node apps/site/wallet-approvals-test.mjs`
- [x] `node apps/site/wallet-btc-test.mjs`
- [x] `node apps/site/wallet-seed-test.mjs`
- [x] `cargo test --release --test coordinator_api`
- [x] `node scripts/ui-audit.mjs` full run (282 page runs, 47 routes)
- [x] `node scripts/check-projects.mjs`
- [x] `node scripts/check-ssot.mjs`
- [x] `node scripts/check-defect-ledger.mjs`
- [x] `node scripts/gen-detector-docs.mjs --check`
