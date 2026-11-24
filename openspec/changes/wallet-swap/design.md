# Design: wallet swap

## D1. Same-chain before cross-chain

SunSwap needs one encoder and no new dependency; a cross-chain aggregator needs
an HTTP contract and a privacy disclosure. Shipping the same-chain swap first
makes the review screen and the slippage/deadline guards testable against a
real contract before a third party enters the path.

## D2. The quote is part of the review, not a UI hint

`amountOutMin` is computed from the quote and the user's slippage and is part
of the signed calldata. A review older than the quote validity is rebuilt, not
signed. This mirrors the unsigned-pin rule of the EVM send path.

## D3. Cross-chain: one aggregator, measured

Open: which aggregator, pending the measurement in task 2. The decision must
name the fee, the limits, the KYC threshold and the exact fields sent to the
provider.
