---
chain: arbitrum
title: "Arbitrum seed phrases: BIP44 EVM accounts | Crypto"
description: "60 deterministic 12-word Arbitrum phrases derived at the BIP44 coin-60 path into the same 0x accounts the L2 uses for ETH gas."
---

## What an Arbitrum seed phrase controls

Arbitrum One is an optimistic rollup that settles batches to Ethereum. A seed
phrase produces the usual BIP39 seed and a secp256k1 key on the coin-60 branch;
the resulting account signs L2 transactions that the sequencer orders. It holds
ETH for gas on Arbitrum, plus ARB, ERC-20 tokens and any contract position
deployed on the rollup. The address also exists on Ethereum with independent
balance and nonce, because the address derivation is shared across EVM chains
while the state is not.

## Derivation path used here

Each row uses `m/44'/60'/0'/0/0`. Arbitrum follows the Ethereum account
convention rather than defining its own coin type, so the path is identical to
the one an Ethereum wallet would use. The final zero selects address index zero
within account zero. A wallet can advance that index to obtain more accounts
from the same phrase; this page keeps index zero so every example can be
checked against other BIP39 tools.

## Address format and limits

The rendered account is EIP-55 `0x` hex and links to Arbiscan. No Arbitrum-only
encoding exists: the twenty bytes behind the checksum are the Ethereum account
bytes for that scalar. A bridge deposit credits this address after the L2
message is processed, but the key does not control the bridge or the sequencer.
Balances are placeholders with reserved height in this static build. Treat the
phrase as public data, because the entropy values are the smallest in the BIP39
range.
