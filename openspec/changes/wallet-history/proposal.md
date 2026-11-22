# Wallet transaction history (BTC and TRON)

## Summary

Add a per-entry **History** action to the cabinet wallet. It loads the latest
transactions for that entry's public address and renders them in the shared
compact table: time, direction (in/out), amount in the chain's native unit,
counterparty, and confirmed/pending status.

Coverage is explicit:

| Chain | Source | Covered |
| --- | --- | --- |
| Bitcoin mainnet | `https://mempool.space/api/address/<addr>/txs`, direct from the browser | yes |
| Bitcoin testnet | `https://mempool.space/testnet/api/address/<addr>/txs`, direct from the browser | yes |
| TRON mainnet | `GET /api/v1/chain/tron/transactions?address=<base58>` on the coordinator (TronScan server-side) | yes |
| EVM chains | none | **no**: the page states that history needs an indexer or an API key and calls no provider |
| Other non-EVM chains | none | **no**: the page states history is not available in this build |

No key, WIF, passphrase or address beyond the two named providers is sent
anywhere. EVM chains never render an empty list that could be mistaken for
"no history".

## Why

The wallet could show balances and send, but a user could not see what an
address had done. The donor has no equivalent, so this is an ours-only
capability; it is also the honest alternative to faking EVM history without an
indexer.

## Goals

1. A 44px labelled icon action on every address row (`aria-label` + tooltip),
   enabled only when the existing opt-in public-lookup toggle is on.
2. A single shared history panel that resets on lock and whenever the vault
   entries change.
3. A compact `.data-table` inside `.table-scroll` with loading, empty and error
   states, and an explicit EVM/other unavailable state with a docs link.
4. Native-unit amounts through `RotorAmount`; a truncated counterparty whose
   full value stays in `title`; `Confirmed`/`Pending` status.
5. A coordinator proxy for TRON that validates the address, caps the list at
   50, caches success 60 s / errors 10 s, reuses the existing TronScan limiter
   and key handling, and answers `501 no_provider` when TronScan is not
   configured.

## Non-goals

- Any indexer or new third-party provider. Only mempool.space and TronScan are
  used; both are already in `data/providers.json`.
- ERC-20 token amounts or token discovery. TRON `amountSun` is the native value
  only, so a TRC-10/TRC-20 transfer reports `0` native.
- Pagination beyond the latest 50 transactions.
- EVM history, token history, or history for Litecoin, Dogecoin, Bitcoin Cash,
  Zcash, XRP, Solana, Sui or TON.
- Sending an address anywhere except mempool.space and the coordinator's
  TronScan proxy.

## Areas

`site`, `coordinator`, `ops` (detector registry, defect ledger, site map,
openspec).

## Success criteria

- BTC parser fixtures: one incoming, one outgoing with change and fee, one
  pending; direction and net value are derived from vin/vout ownership.
- TRON parser fixtures: in, out with fee, pending, a real TronScan-shaped
  fixture, and a 60-row cap to 50.
- EVM classification returns the exact unavailable message and no provider URL.
- `wallet-history-surface` detector exercises the table shell, the 44px action,
  the counterparty title, status pills, loading/empty/error and the EVM state,
  with a stubbed fetch; it is registered in `data/detectors.json` with a
  defect-ledger entry.
- `node scripts/ui-audit.mjs --serve` passes; the `ui-audit` CI run uploads
  the screenshots at 375/1280 in both themes for BTC, TRON, EVM-unavailable,
  empty and error states as the `ui-audit-report` artifact (nothing is
  committed to the repo).
- `cargo test --release`, `check-projects`, `check-defect-ledger`, `check-ssot`
  and `gen-detector-docs --check` pass.
