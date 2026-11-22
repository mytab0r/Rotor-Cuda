# Wallet mainnet signing (first slice)

## Summary

Enable native-token and ERC-20 EVM transfers on mainnets from the cabinet
wallet vault. Sepolia stays the default. A mainnet network becomes signable
only after the user arms mainnet for the session; the arm resets on lock,
unlock and reload.

ERC-20 support covers `transfer(address,uint256)` and the approvals read,
grant and revoke flow (`approve(spender, amount)` and `approve(spender, 0)`),
all with fixed, locally built ABI payloads. Approvals are discovered by scanning
`Approval(address,address,uint256)` logs over a configurable recent block window
(default 50,000) and the current `allowance(owner,spender)` is re-read for each
spender; there is no indexer, so an approval older than the scanned window needs
a larger window on an archive RPC or an indexer. A grant takes an explicit
allowance amount or the `Unlimited (2^256-1)` option and gets its own review.
Other token methods, allowance discovery beyond the user-supplied token and
scanned window, Bitcoin mainnet and TRON mainnet are next slices and remain
disabled here.

## Why

The vault already holds mainnet EVM keys and shows their addresses, but could
only sign on Sepolia. A user who wants to move native value or an ERC-20 token
still had to export the key to another site. This slice closes that gap
without adding non-EVM mainnet custody, and its allowance grant replaces the
usual "open the token site and approve it there" detour with a local, reviewed
`approve`. Granting is a dangerous permission, so it is a separate, explicit
action with its own warning and review, never part of a transfer.

## Scope

In scope:

- EVM native-token transfers on `ethereum` (1), `bnb` (56), `arbitrum` (42161),
  `optimism` (10), `base` (8453), `polygon` (137), `avalanche` (43114) and
  `zksync` (324), plus the existing Sepolia (11155111) testnet flow.
- ERC-20 `transfer(address,uint256)` on the same chains. An optional token
  contract field reads `decimals()`, `symbol()` and `balanceOf(owner)` through
  `eth_call`, requires contract code at the address, and builds the calldata
  locally; the reviewed native value stays 0.
- ERC-20 approvals read, grant and revoke on the same chains. The user supplies
  the token contract and a recent block window; the wallet scans
  `Approval(address,address,uint256)` with chunked `eth_getLogs`, dedupes by
  spender, re-reads the live `allowance(owner,spender)` for up to 50 spenders,
  labels each spender EOA/contract with `eth_getCode`, and builds
  `approve(spender, 0)` locally for a revoke. A grant builds
  `approve(spender, amount)` locally from an explicit token-unit amount or the
  `Unlimited (2^256-1)` option, refuses zero (use revoke) and values above
  `2^256-1`, and gets a separate review. There is no indexer and no token
  discovery, so the list covers only the scanned window.
- Build from the form, fetch nonce/balance/gas/fees from the selected chain's
  RPC, review the decoded fields, sign locally in the WASM core, broadcast the
  signed raw transaction once. The same pinned unsigned-transaction review
  protects transfers, grants and revokes.

Out of scope (next slices):

- Allowance discovery beyond the user-supplied token contract and scanned
  window.
- Other token methods (transferFrom, permit, arbitrary calldata).
- Bitcoin mainnet.
- TRON mainnet (needs a provider key; the public Nile host is testnet-only).
- Sweeps, batched sends, scheduled sends, server-side signing.

## Safety gates (all enforced in code and tested)

1. **Chain id allowlist.** `eth_chainId` is read before review and again before
   signing. A mismatch, or an id absent from `NETWORKS` in
   `apps/site/wallet-evm.js`, refuses the send.
2. **EIP-55 recipient.** All-lowercase addresses are accepted without a
   checksum; any uppercase letter makes the address checksummed, so mixed case
   and all-uppercase must match the EIP-55 checksum exactly. The zero address
   is always refused.
3. **Balance.** On mainnet a native send's amount plus `gasLimit ×
   maxFeePerGas` must not exceed the native balance. A token send's amount must
   not exceed `balanceOf(owner)`, and its fee alone must fit the native
   balance.
4. **Nonce.** Read with `eth_getTransactionCount(..., "pending")`.
5. **Fee cap.** One table (`NETWORKS[].feeCapWei`) caps the total network fee
   per transaction. A send above the cap is refused before signing with the
   exact fee and cap in the message.
6. **Mainnet armed.** Mainnet is not the default. The user ticks an explicit
   risk checkbox for the session; the codec refuses a mainnet prepare/confirm
   when `mainnetArmed !== true`, and the UI clears the arm on lock, unlock and
   reload.
7. **Gas.** Mainnet gas limit comes from `eth_estimateGas` plus a 20% buffer;
   there is no blind default. A manual limit is user-explicit and reviewed as
   such.
8. **Fees.** Base fee from `eth_feeHistory` with `eth_gasPrice` fallback;
   priority fee from `eth_maxPriorityFeePerGas` with `eth_gasPrice` fallback;
   `maxFee = 2 × base + priority` when not entered manually.
9. **Four fixed shapes, no arbitrary calls.** A native send must have empty
   data and a non-zero amount. A token send must carry exactly the
   `transfer(address,uint256)` calldata rebuilt at confirm time from the
   reviewed recipient and raw amount, with native value 0; the token address
   must return contract code and report 0–24 decimals and a printable symbol
   of at most 32 characters. A revoke must carry exactly
   `approve(spender, 0)` rebuilt at confirm time from the reviewed spender,
   with native value 0; a mutated spender, amount or calldata refuses, and the
   spender's EOA/contract type is informational, not a refusal. A grant must
   carry exactly `approve(spender, amount)` rebuilt at confirm time from the
   reviewed spender and allowance, with native value 0; the amount is parsed
   exactly with the token's decimals from a finite token-unit input or pinned
   to `2^256-1` by the explicit Unlimited option, zero is refused (revoke owns
   that case), values above `2^256-1` are refused, and the zero spender and the
   token contract as its own spender are refused; an EOA spender is allowed and
   labelled. Any other calldata is refused. All four shapes keep the arm,
   chain re-read, fee cap and balance gates.
10. **One broadcast.** The signed raw transaction is sent exactly once; a
    provider error is shown verbatim and not retried automatically. Before
    signing, the unsigned transaction is rebuilt from the reviewed fields
    (chain id, nonce, fees, gas limit, to, value, data) and compared
    byte-for-byte with the reviewed unsigned hex; a mismatch refuses. No key,
    signature seed or signed transaction is logged or stored.
11. **Approval scan window.** `eth_getLogs` is chunked and adapted to the
    provider's range limit (the numeric limit is used when the error states
    it, otherwise the chunk halves). The scan starts from the newest block and
    stops at the provider's archive horizon or the request cap, then reports
    the blocks actually scanned. The list never claims full history; an older
    approval needs an archive RPC or an indexer. The displayed allowance is the
    current `allowance(owner,spender)`, not the log value; an allowance that is
    already zero refuses a revoke.

## Fee caps

`feeCapWei` is the maximum total network fee (`gasLimit × maxFeePerGas`) in
the chain's native unit. The table lives in
`apps/site/wallet-evm.js` (`NETWORKS`) and is exported; there are no scattered
literal caps.

| Chain | Chain id | Native unit | Cap per transaction |
|---|---|---|---|
| Ethereum Sepolia | 11155111 | ETH | none (testnet) |
| Ethereum mainnet | 1 | ETH | 0.05 |
| BNB Chain | 56 | BNB | 0.01 |
| Arbitrum One | 42161 | ETH | 0.01 |
| OP Mainnet | 10 | ETH | 0.01 |
| Base | 8453 | ETH | 0.01 |
| Polygon | 137 | POL | 0.01 |
| Avalanche C-Chain | 43114 | AVAX | 0.01 |
| zkSync Era | 324 | ETH | 0.01 |

## Threat model

| Threat | Mitigation in this slice |
|---|---|
| Phishing / address substitution | EIP-55 checksum enforced; zero address refused; decoded `to` is repeated on the review screen; the user must confirm a second step. |
| Wrong chain | `eth_chainId` checked before review and again before signing; only ids in `NETWORKS` are signable; the second check catches a provider that switched chains after review. |
| Fee spike | Per-chain total-fee cap; max fee is derived from node data (2 × base + priority) and shown before signing; gas limit is estimate + 20%, never a blind default. |
| Spending more than the balance | On mainnet the maximum cost must fit the balance or the send is refused with both figures. |
| Key exfiltration | The key exists only in the unlocked vault entry and the WASM signing request; the request and its JS copy are zeroed in a `finally`; only the signed raw transaction reaches the provider. |
| Accidental mainnet send | Mainnet is not the default; the explicit arm checkbox resets on lock/unlock/reload; the codec itself refuses an unarmed mainnet send. |
| Double send / retry storm | One `eth_sendRawTransaction` call per confirmation; errors are surfaced, not retried. |
| Accidental approval grant / arbitrary approval call | A grant only ever builds `approve(spender, amount)` from a reviewed finite token-unit amount or the explicit Unlimited option; zero, values above `2^256-1`, the zero spender and the token contract as its own spender refuse, a mutated spender/amount/calldata refuses at confirm, and every other calldata is refused. The grant gets its own review with a visible unlimited warning, and the form resets the review on any edit. |
| Stale approval log value | The list re-reads the current `allowance(owner,spender)` for each spender and refuses a revoke when it is already zero. |
| Hidden approval history | The panel reports the blocks actually scanned and says older approvals need an archive RPC or an indexer; it never claims a full list. |

## Success criteria

- A fixed key signs the pinned Ethereum mainnet native-transfer vector in the
  committed WASM core and the raw transaction hash matches the independent
  ethers vector.
- The ERC-20 transfer, `approve(spender, 0)` revoke and `approve(spender,
  amount)` grant calldata match an independent ethers 6.17.0 encoding
  (including the exact `2^256-1` Unlimited word); the grant review is pinned
  by the same unsigned transaction rebuild and a mutated spender/amount/
  calldata refuses.
- Each refusal path above has a stubbed-RPC test in
  `apps/site/wallet-mainnet-test.mjs` or `apps/site/wallet-approvals-test.mjs`;
  no test touches a real network.
- The approvals table and the grant form are covered by a route-specific
  `ui-audit` scenario with a stubbed RPC: shared `.data-table`/`.table-scroll`,
  44px labelled icon actions, `Unlimited`/`Contract`/`EOA` labels, the
  archive-truncated warning, labelled 44px grant fields, the grant form's own
  visible Unlimited warning line, a zero-amount error state, a rendered
  unlimited review and no page overflow at 375/1280.
- `node scripts/ui-audit.mjs --serve`, `check-projects`, `check-defect-ledger`
  and `cargo test --release --test coordinator_api` pass.
