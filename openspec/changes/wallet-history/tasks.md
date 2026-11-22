# Tasks

## 1. Coordinator TRON transactions

- [x] Add `GET /api/v1/chain/tron/transactions?address=<base58>` next to the
      public TRON account routes; keep it GET-only and out of the token matrix.
- [x] Reuse `valid_tron_address`, the shared TronScan limiter, the
      `public-tron:<ip>` rate limit and the 60 s / 10 s cache; answer
      `501 no_provider` when neither `TRONSCAN_API_KEY` nor the edge proxy is
      configured.
- [x] Normalize the TronScan list to
      `{txid, timestamp, direction, amountSun, counterparty, confirmed, fee?}`
      and cap it at 50. `timestamp` is epoch milliseconds; `amountSun` is the
      native value only; `fee` is the sender's fee for outgoing rows.
- [x] Return `Cache-Control: no-store` on success and error answers.
- [x] Unit tests: TRON hex -> base58 vector, in/out/pending/fee fixtures from
      the real TronScan shape, cap and malformed-row skipping.
- [x] Integration test: validation, missing query, 501 without a provider,
      `no-store`, POST 405.

## 2. Site history panel

- [x] `apps/site/wallet-history.js`: pure `support`, `btcTxsUrl`,
      `parseBtcTxs`, `parseTronPayload`, `formatNative`, `formatTime`,
      `truncateMiddle`, direction/status labels and the EVM/other messages.
- [x] Per-entry 44px `.icon-button` History action with `aria-label` and
      `data-tooltip`, gated by the existing public-lookup toggle.
- [x] One shared panel with a `.data-table` inside `.table-scroll`: time,
      direction, native amount (with outgoing fee), truncated counterparty
      with `title`, confirmed/pending status.
- [x] Loading, empty and error states; the panel resets on lock and on any
      entry change.
- [x] Bitcoin mainnet/testnet read mempool.space directly; TRON calls the new
      coordinator endpoint; EVM and other chains show the honest unavailable
      note with a docs link and make no provider call.
- [x] `apps/site/wallet-history-test.mjs`: BTC incoming/outgoing-with-change
      and fee/pending, direction math, caps, TRON in/out/pending, native-unit
      formatting, EVM message and URL selection.

## 3. Detector and docs

- [x] `wallet-history-surface` detector in `scripts/ui-audit.mjs`: imports BTC
      and TRON keys, stubs fetch, checks the table shell, 44px action, header
      set, counterparty title, status pills, loading/empty/error/EVM states and
      overflow; writes one screenshot per state.
- [x] Register the detector in `data/detectors.json` and add the
      `wallet-history-unchecked` defect entry; regenerate the detector tables.
- [x] Site-map note, wallet help text and this change.

## 4. Verification

- [x] `node --check` on the wallet scripts; history tests green.
- [x] `cargo test --release`.
- [x] `node scripts/ui-audit.mjs --serve` PASS with the history screenshots.
- [x] `check-projects`, `check-defect-ledger`, `check-ssot`,
      `gen-detector-docs --check`.
