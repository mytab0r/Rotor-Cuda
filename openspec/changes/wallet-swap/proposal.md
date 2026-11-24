# Wallet swap: same-chain first, one cross-chain aggregator later

## Summary

Let a key imported in the wallet swap value without leaving the page: first a
same-chain swap on TRON through the SunSwap router, then a cross-chain swap
from TRON to a stablecoin on another chain through one measured third-party
aggregator. The private key never leaves the browser; every swap is built
locally, reviewed, and broadcast once.

## Why

The owner asked for a TRON transfer and, ideally, a swap to USDC/USDT on
another chain without KYC. A transfer alone covers half the use case: moving
value between chains currently means exporting the key to another site.
Same-chain swaps are a contract call on the same node the transfer already
uses, so they cost one encoder, not a new dependency. Cross-chain swaps cannot
be done without a third party — there is no canonical trustless TRON↔EVM
bridge — so that half is a measured integration, not a build.

## Scope

In scope:
- SunSwap V2 swaps on TRON mainnet: TRX → TRC-20 and TRC-20 → TRX, quote from
  the router's `getAmountsOut`, slippage and a minimum-received bound enforced
  on-chain, built through the same `TriggerSmartContract` encoder as a TRC-20
  transfer.
- One cross-chain aggregator, chosen after measuring real TRON → USDC routes
  (fees, limits, KYC thresholds, terms), behind the same review screen. The
  destination address is supplied by the user and may be any address.
- An explicit statement in the UI of what leaves the device: source and
  destination addresses and the amount go to the chosen provider; the IP can
  be proxied, the addresses cannot.

Out of scope:
- Our own bridge, custody, order books, limit orders, or fiat on/off ramps.
- Swap routing across more than one aggregator in the first release.
- Chains other than TRON as the swap source.

## Risks

- A third-party aggregator is a dependency with its own terms, rate limits and
  AML flags; a blocked route must fail loud, never silently fall back.
- A stale quote is a loss. The minimum-received bound is enforced by the
  contract call, and a review older than the quote's own validity is refused.
