# Wallet portfolio summary

## Summary

Add a portfolio summary above the cabinet wallet address groups: a USD total,
per-chain native totals, the entry count, the UTC time of the last successful
balance refresh and one refresh action. No transaction history, token
holdings or backend accounting is part of this slice.

## Why

The cabinet wallet listed each address with its own balance but never showed
the portfolio at a glance. A naive total is easy to make dishonest: an
unloaded or failed row is not a zero, a testnet coin has no market price, and
a stale ticker must not silently become a number. The summary therefore
prioritises a stated truth over a round figure.

## Decisions

1. **Only loaded balances contribute to a total.** A row in `loading`,
   `error` or `missing` state is never coerced to `0n`. The summary states
   `N of M balances loaded`, and the per-row result is the only source for
   both the badge and the totals.
2. **`—` is not `$0.00`.** With nothing loaded, the fiat value is `—` and an
   explicit empty state explains why. A row that loaded with an amount of
   `0n` is a real zero and may print `$0.00`.
3. **Testnet and unpriced chains are excluded from USD and named.** The
   exclusion is driven by the chain/ticker mapping, not by the symbol alone:
   Bitcoin testnet carries the symbol `BTC` but has no market of its own and
   must never be priced at the mainnet ticker. There are no invented prices.
4. **One shared ticker cache.** The USD value uses the same public Binance
   ticker helper, localStorage key (`rotor.prices.v1`) and six-hour TTL as the
   key explorer. The pair is exported once from `key-tools.js`; no second
   price provider is introduced. A stale or offline ticker prints `—` with the
   reason and keeps the native per-chain totals, and the excluded chain names
   are shown regardless of why USD is unavailable.
5. **A missing derived address is an error row, not a skipped row.** A bulk
   refresh routes every entry through the same per-row load path, so a row
   without a derived address shows `address not derived yet` instead of
   remaining silently `missing`.
6. **One summary surface, shared grammar.** The block uses the shared `.stat`
   label/value grammar (12px sentence-case label, 20/24/28 tabular value) and
   the refresh action is the shared 44px `.icon-button` with `aria-label` and
   `data-tooltip`.
7. **No new network calls.** Refresh reuses the existing per-row public
   balance lookups and the existing ticker. Only public addresses and ticker
   symbols leave the browser; no key, WIF or passphrase is involved.

## Scope

In scope:

- Total value in USD from loaded balances and a fresh public ticker.
- Per-chain native totals (BigInt sums, displayed through `RotorAmount`).
- Entry count and the last successful balance refresh timestamp.
- A refresh action that reloads every entry through the existing per-row path.
- Empty, loading, error, stale-ticker and unpriced-chain states.

Out of scope:

- Transaction history, PnL, cost basis or token holdings.
- Fiat prices for testnet coins or any invented/derived price.
- A second price provider, a server-side portfolio or new API endpoints.
- Backend changes beyond registering the new static summary module.

## Verification

- Pure math and honesty tests in `apps/site/wallet-summary-test.mjs`.
- The wallet ui-audit scenario asserts the empty and loaded states, a real
  loaded zero, the 44px refresh control and the stat token grammar.
- Wallet suites, `cargo test --release --test coordinator_api`, the full
  `ui-audit`, `check-projects`, `check-ssot`, `check-defect-ledger` and
  `gen-detector-docs --check` all pass.
