---
chain: zksync
title: "zkSync Era private keys: 0x accounts and zk gas | Crypto"
description: "Browse 60 deterministic zkSync Era private keys and their 0x addresses, with ETH gas, native account abstraction and the zk rollup model."
---

## What a zkSync Era private key controls

zkSync Era is a zero-knowledge rollup that proves its state transitions to
Ethereum. Its accounts use the EVM `0x` form, and a secp256k1 key signs L2
transactions for one account. ETH pays gas, and the account can hold ERC-20
tokens and interact with Solidity contracts. zkSync Era supports native account
abstraction, so an account can be a smart contract with custom signature rules;
this page only derives the standard externally owned account from the scalar,
not a custom smart account. The rollup proves batches to Ethereum, but the
account's balance and nonce on zkSync are separate from Ethereum's.

## Address formats on this page

The table shows the EIP-55 `0x` account and links it to the zkSync explorer. The
address bytes come from the same keccak hash as Ethereum, so there is no
zkSync-specific prefix. A deposit from Ethereum through the official bridge
credits this account; a withdrawal goes back through the bridge and is subject
to its finality rules. The key does not control the prover, the sequencer or the
bridge contract, and a smart-account deployment could give the address rules
that this plain EOA derivation does not model.

## Key encodings and limits

Input is 64 hex characters, with or without `0x`; WIF is a secp256k1 wrapper,
not a zkSync format. ETH has 18 decimals for gas. The balance column is a
reserved placeholder in this static build and does not query a provider. The
key can sign ordinary account transactions, but it cannot change the rollup's
proof system or force a withdrawal before the bridge allows one. Because the
address is shared across EVM networks, a leaked scalar exposes the same account
everywhere it exists, not just on zkSync Era.
