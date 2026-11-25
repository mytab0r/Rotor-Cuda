# Tasks: wallet swap

## 1. Same-chain SunSwap (blocked by: ROT-511)

- [x] Read the router address and the WTRX address from `data/` (one source),
  never from page code.
- [x] Quote with `getAmountsOut` through `TriggerSmartContract` constant call;
  refuse a zero route, a stale block and a quote older than its validity.
- [x] Build `swapExactTRXForTokens` / `swapExactTokensForTokens` with
  `amountOutMin` from the user's slippage and a deadline; TRC-20 input needs
  an `approve` step with its own review.
- [x] Review screen: pay, receive, route, slippage, minimum received, fee limit.
- [ ] Tests: calldata vectors for both directions, slippage and deadline
  refusals, a mutation that drops `amountOutMin` and fails.

## 2. Cross-chain aggregator (blocked by: section 1)

- [ ] Measure three aggregators on real TRON → USDC/USDT routes: fee, rate,
  minimum and maximum amount, KYC threshold, terms, rate limits.
- [ ] Record the measurement and the choice in `design.md` before writing code.
- [ ] Integrate the chosen API behind the same review screen; the destination
  address is free-form and does not have to be the source wallet.
- [ ] State in the UI exactly which fields leave the device and to whom.
- [ ] Fail loud on an unavailable route, a changed quote or a provider error;
  never retry a broadcast.
- [ ] Tests: refused route, expired quote, provider error, destination equal to
  the source, and no key material in any outbound payload.
