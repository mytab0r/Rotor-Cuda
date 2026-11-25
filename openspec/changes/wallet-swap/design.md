# Design: wallet swap

## D1. Same-chain before cross-chain

SunSwap needs one encoder and no new dependency; a cross-chain aggregator needs
an HTTP contract and a privacy disclosure. Shipping the same-chain swap first
makes the review screen and the slippage/deadline guards testable against a
real contract before a third party enters the path.

## D2. The quote is part of the review, not a UI hint

`amountOutMin` is computed from the quote and the user's slippage and is part
of the signed calldata. A review older than the quote validity is rebuilt, not
signed. This mirrors the unsigned-pin rule of the EVM send path. The 60 s TTL
guards the review→confirm window only: after an approve is confirmed the swap
step is rebuilt from a fresh block from the same provider (new TAPOS fields
and deadline) without a new review or a second TTL check, because the on-chain
`amountOutMin` is the economic guard and the amount/path/recipient pin still
runs at signing.

## D3. Cross-chain: one aggregator, measured

Measured on 2026-11-25 against the public quote endpoints, no API key, sender
`TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7` (TRON) and recipient
`0x1111111111111111111111111111111111111111` (Arbitrum One), slippage 1 %.
Amounts probed: 100 / 1 000 / 100 000 TRX and 100 USDT-TRC20. These are
single-moment probes from the same hour: the TRX price and the routes move
between requests, so what survives is the ordering and the fee structure, not
the absolute USDC figure.

"USDC per TRX debited" is what the user actually pays: received USDC divided
by the TRX the provider debits, including any operating expense added on top
of the typed amount. A quoted output with a hidden debit is not a price, so
that ratio, not the quoted rate, is what selects the provider. Symbiosis's
returned `tx.value` equals the typed amount (`metaRoute(...)` call, checked
100 TRX → `value: 100000000`), so its ratio is the quoted output over the
input; deBridge's `srcChainTokenIn.amount` is the same, but the prepended
operating expense is debited on top.

| Provider | Fee | USDC per TRX debited (100 / 1k / 100k TRX) | 100 USDT-TRC20 → USDC | Limits | KYC | Arbitrary recipient |
| --- | --- | --- | --- | --- | --- | --- |
| Symbiosis `/v2/quote` | flat 0.25 USDC on the output; destination gas withheld inside the quote, not itemized | 0.301449 / 0.305940 / 0.307599 | 99.219958 | 0.3–200 000 USDT per swap | none in docs or terms | yes, `to` separate from `from` |
| deBridge `/v1.0/dln/order/create-tx` | 4 TRX fixFee + prepended operating expense (6.13 TRX on a 100 TRX order) + 4 bps protocolFee on USDT input | 0.289088 / 0.304879 / 0.306661 | 99.790070 (101.879981 debited) | 1 USD – 5.5M USD, documented | none, but address screening | yes, `dstChainTokenOutRecipient` |
| LI.FI `/v1/quote` | 0.25 USDT fixed + 0.36 % bridge fee; source gas 0.99 TRX listed separately | refused: native TRX is not a supported source | 99.272523 (min 98.279798), 21 s | 0.1 USDT returns no route at all; 100 USDT quotes; max not probed | none in the measured path | yes, `toAddress` |

Rejected on the live API, not on reputation:

- **Rango** does model TRON (`TRON.TRX`, `TRON.USDT--TR7NHqjeKQxGTC…`, chain
  728126428), returns a TronWeb-shaped `tx{raw_data,raw_data_hex,txID,
  fee_limit}` to sign on the device, and its quote takes no sender address —
  the best privacy shape of the five. But every `/basic` path answers 401
  without a key; the documented public test key is rejected with a Cloudflare
  403 from this host, and a private key is issued through a Discord ticket.
  No quote could be obtained, so it cannot be chosen; a measured re-run is the
  first step if it is ever revisited.
- **Squid/Axelar** answers 400 `x-integrator-id header is missing`; with
  `x-integrator-id: test` its `/v2/chains` lists 74 chains of type
  `evm/cosmos/sui` with no TRON, and `/v2/route` with `fromChain=tron` answers
  500. Out.
- **LI.FI** rejects the wallet's primary case itself with
  `Implicit source swaps are currently not supported for non-EVM chains`: it
  can bridge USDT-TRC20 out of TRON but cannot convert native TRX first.

Review-screen fields and the exact contract:

| Field | Symbiosis `/v2/quote` | deBridge `create-tx` | LI.FI `/v1/quote` |
| --- | --- | --- | --- |
| pay | `tokenAmountIn.amount` | `estimation.srcChainTokenIn.amount` | `action.fromAmount` |
| receive | `tokenAmountOut` | `estimation.dstChainTokenOut.amount` | `estimate.toAmount` |
| minimum received | `tokenAmountOutMin` | `maxTheoreticalAmount` + `recommendedSlippage` | `estimate.toAmountMin` |
| fee | `fee`, `fees[]` | `costsDetails[]`, `fixFee`, `protocolFee` | `estimate.feeCosts[]`, `gasCosts[]` |
| route | `route`, `routes`, `labels` | `estimation.srcChainTokenOut`, `order` | `includedSteps[].tool` |
| unsigned TRON tx | `tx{chainId,to,data,value,feeLimit,from}` | `tx{to,data,value}`, assembled by the wallet | `transactionRequest{to,data,value,gasLimit}` |
| expiry | calldata regenerated every 30 s; no deadline field | order valid ~30 s | not documented in the response |
| ETA | `estimatedTime` (35 s in every probe) | `order.approximateFulfillmentDelay` (4 s; 16 s at 100k TRX) | `estimate.executionDuration` (21 s) |
| status | `GET /v2/tx/{chainId}/{txHash}` | order status endpoint in docs | not probed |

**Choice: Symbiosis.** Three measured reasons:

1. It pays out more USDC per TRX debited at every size probed (+4.3 % at
   100 TRX, +0.35 % at 1 000, +0.31 % at 100 000). On USDT input LI.FI is
   0.05 % ahead, but LI.FI cannot take native TRX at all, and TRX is the
   wallet's primary balance.
2. The fee is a flat 0.25 USDC and `tokenAmountOutMin` arrives in the quote,
   so the D2 guard binds to a provider-computed minimum instead of a local
   recomputation from a theoretical amount.
3. One request returns the TRON calldata (`tx{to,data,value,feeLimit}`) that
   the existing `TriggerSmartContract` encoder signs, and TRX input needs no
   `approve`. LI.FI needs an `approveTo` step for USDT and leaves the bridge
   choice to its router.

Risks:

- **Quote movement.** 35 s ETA with calldata regenerated every 30 s. The
  signed calldata carries the provider's own `tokenAmountOutMin`; we never
  compute it locally from `tokenAmountOut`. A review past the TTL is refused
  and rebuilt (D2).
- **Bridge status.** The source broadcast is not the swap: value arrives when
  the destination tx confirms. Status comes from
  `GET /v2/tx/{chainId}/{txHash}`; the UI must poll it and show a pending
  state, never "done" on broadcast.
- **Provider refusal.** Public quota is 1 request/second per IP (measured
  `ratelimit-limit: 1;w=1`), the amount floor answers 400 "Amount is too low
  to cover fees", and the cap is 200 000 USDT per swap. Each is a visible
  error; there is no fallback provider (proposal: one aggregator).
- **What leaves the device.** `from`, `to`, `tokenAmountIn`, `tokenOut` and
  `slippage` go to `api.symbiosis.finance` over HTTPS, once per quote and once
  per rebuild. No key material, no signature, no address book. The provider
  sees the IP, both addresses and the amount; the review screen must say so.
- **A flat fee is not free at small sizes.** A 100 TRX order loses 1.9 % in
  total: 0.81 % is the 0.25 USDC fee, the rest is price impact (0.58 %) plus
  destination gas withheld inside the quote. The review must show the
  effective loss, not just the fee line.
- **A meta-aggregator hides the counterparty.** LI.FI's measured USDT route
  ran through LayerSwap, and `includedSteps[].tool` can change per quote: the
  bridge we vet is not necessarily the bridge that executes. Symbiosis names
  its route (`route`, `labels`) and settles through its own contracts.

**deBridge is rejected, not found unsafe.** It debits 6.1 % on a 100 TRX
order (operating expense prepended to the typed amount), and it refused
`0x1111…1111` with `COMPLIANCE_ADDRESS_BLOCKED`: a free-form recipient can be
rejected by address screening at quote time. Its 5.5M USD ceiling is the
reason to revisit it if large transfers become a requirement.

Sources: [Symbiosis API](https://docs.symbiosis.finance/developer-tools/symbiosis-api),
[Symbiosis terms](https://symbiosis.finance/terms-of-use),
[deBridge docs](https://docs.debridge.com),
[Rango keys and limits](https://docs.rango.exchange/api-integration/api-key-and-rate-limits).
LI.FI was probed at `https://li.quest/v1/quote` and Squid at
`https://v2.api.squidrouter.com/v2/chains`; both are reachable without a key
and need no docs link to reproduce the calls above.
