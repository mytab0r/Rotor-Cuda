# Wallet mainnet signing (first slice)

## Summary

Enable native-token EVM transfers on mainnets from the cabinet wallet vault.
Sepolia stays the default. A mainnet network becomes signable only after the
user arms mainnet for the session; the arm resets on lock, unlock and reload.

This is deliberately the smallest mainnet slice. ERC-20 transfers, approvals,
Bitcoin mainnet and TRON mainnet are next slices and remain disabled here.

## Why

The vault already holds mainnet EVM keys and shows their addresses, but could
only sign on Sepolia. A user who wants to move native value still had to export
the key to another site. This slice closes that gap without adding token
approvals or non-EVM mainnet custody.

## Scope

In scope:

- EVM native-token transfers on `ethereum` (1), `bnb` (56), `arbitrum` (42161),
  `optimism` (10), `base` (8453), `polygon` (137), `avalanche` (43114) and
  `zksync` (324), plus the existing Sepolia (11155111) testnet flow.
- Build from the form, fetch nonce/balance/gas/fees from the selected chain's
  RPC, review the decoded fields, sign locally in the WASM core, broadcast the
  signed raw transaction once.

Out of scope (next slices):

- ERC-20 transfers and token balances.
- Allowance approvals: list, revoke, grant.
- Bitcoin mainnet.
- TRON mainnet (needs a provider key; the public Nile host is testnet-only).
- Sweeps, batched sends, scheduled sends, server-side signing.

## Safety gates (all enforced in code and tested)

1. **Chain id allowlist.** `eth_chainId` is read before review and again before
   signing. A mismatch, or an id absent from `NETWORKS` in
   `apps/site/wallet-evm.js`, refuses the send.
2. **EIP-55 recipient.** Mixed-case addresses must match the EIP-55 checksum;
   the zero address is always refused.
3. **Balance.** On mainnet, `amount + gasLimit × maxFeePerGas` must not exceed
   the on-chain balance read from the node.
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
9. **Native transfers only.** On mainnet the data field must stay empty and
   the amount must be greater than zero, so this slice cannot be used to call a
   token contract or create an approval.
10. **One broadcast.** The signed raw transaction is sent exactly once; a
    provider error is shown verbatim and not retried automatically. No key,
    signature seed or signed transaction is logged or stored.

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
| Scope creep into token approvals | Mainnet data must be empty and value > 0; ERC-20 and approvals are separate slices. |

## Success criteria

- A fixed key signs the pinned Ethereum mainnet native-transfer vector in the
  committed WASM core and the raw transaction hash matches the independent
  ethers vector.
- Each refusal path above has a stubbed-RPC test in
  `apps/site/wallet-mainnet-test.mjs`; no test touches a real network.
- `node scripts/ui-audit.mjs --serve`, `check-projects`, `check-defect-ledger`
  and `cargo test --release --test coordinator_api` pass.
