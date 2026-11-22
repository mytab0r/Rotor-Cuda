# Tasks: wallet top-10 assets and key onboarding

## 1. Asset SSOT

- [x] Add `data/assets.json` with 10 assets: rank, market-cap rank, symbol,
  name, chain (or `evm`), contract per chain, decimals, ticker or explicit peg,
  and balance kind.
- [x] Add `scripts/lib/assets.mjs` validation: exact top-10, contiguous unique
  ranks, unique market-cap ranks and symbols, supported non-testnet chains,
  EVM-only contracts for `evm`, exactly one price source, and no contract on a
  native asset.
- [x] Extend `scripts/gen-ssot.mjs` to validate the file and generate
  `apps/site/assets.generated.js`; make `--check`/`check-ssot` fail when stale.

## 2. Asset model and read paths

- [x] Add `apps/site/wallet-assets.js`: network expansion, balance keys,
  exact BigInt USD cents, the USDT peg, price reasons and the row model.
- [x] Add `metaFor` to `balance-providers.js` so the wallet native rows reuse
  the shared provider mapping.
- [x] Read ERC-20 `balanceOf` through the chain's public RPC and TRC-20 USDT
  through the TronScan account response; never invent a zero for an empty or
  malformed body.
- [x] Add `USDCUSDT` to the shared Binance ticker list.

## 3. Wallet UI

- [x] Add the top-assets table above the portfolio summary: `.data-table` in
  `.table-scroll`, Asset/Network/Balance/USD columns, total row, rank order,
  loading/empty/error lines and a 44px shared refresh path.
- [x] Render `not loaded`, `lookup failed` and `unavailable` honestly; count
  only loaded and priced rows in the total.
- [x] Add the onboarding chip pair (“I have a seed phrase”, “I have a private
  key / WIF”) with shared safety copy; focus the matching form after unlock.
- [x] Do not change WIF or hex parsing.

## 4. Tests and audit

- [x] Add `apps/site/wallet-assets-test.mjs` and
  `apps/site/wallet-onboarding-test.mjs`.
- [x] Extend `scripts/ui-audit.mjs` with the onboarding reachability and
  top-assets scenarios against stubbed responses.
- [x] Register `wallet-top-assets-surface` and `wallet-onboarding-key-entry`
  in `data/detectors.json`, add defect-ledger entries and regenerate the
  detector tables.
- [x] Register the new files and tests in `projects.json`.

## 5. Docs

- [x] Update the `/cabinet/wallet` note in `docs/site-map/site-map-data.js`.
- [x] State in the page help that only assets with a real balance path show a
  balance, that failed rows are never zero, and that prices come from the
  shared ticker (USDT at its explicit peg).

## 6. Verification

- [x] `node apps/site/wallet-assets-test.mjs`
- [x] `node apps/site/wallet-onboarding-test.mjs`
- [x] wallet suites and `node apps/site/key-tools-test.mjs`
- [x] `cargo test --release --test coordinator_api`
- [x] `node scripts/ui-audit.mjs --serve`
- [x] `node scripts/check-projects.mjs`
- [x] `node scripts/check-ssot.mjs`
- [x] `node scripts/check-defect-ledger.mjs`
- [x] `node scripts/gen-detector-docs.mjs --check`
