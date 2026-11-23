---
chain: avalanche
title: "Avalanche seed phrases: C-Chain BIP44 accounts | Crypto"
description: "60 deterministic 12-word Avalanche phrases derived at the BIP44 coin-60 path into C-Chain 0x accounts that pay gas in AVAX."
---

## What an Avalanche seed phrase controls

Avalanche is a network of chains, and this page derives the contract chain.
The mnemonic becomes a BIP39 seed; the coin-60 branch yields a secp256k1 key;
the key's keccak account is the C-Chain externally owned account. That account
pays fees in AVAX and can hold ERC-20 tokens and Solidity contract state. The
X-Chain, which moves AVAX with a different encoding, and the P-Chain, which
handles validators and subnets, are not derived from this branch in the table.

## Paths used on this page

The only derivation used is `m/44'/60'/0'/0/0`: Ethereum coin type, first
account, external change, address zero. Avalanche's C-Chain follows the EVM
account convention, so the path matches the Ethereum branch even though the
network has several chains. The example rows therefore produce the same `0x`
string an Ethereum wallet would show for that phrase.

## Address formats and limits

C-Chain rows use the EIP-55 checksum and link to Snowtrace. The X-Chain's
`X-avax1…` and the P-Chain's `P-avax1…` addresses are different encodings for
different purposes; this table does not claim them. Moving value between the
chains requires the appropriate cross-chain transaction, not a different key
derivation. AVAX has eighteen decimals on the C-Chain. The balance column is a
placeholder in this static build, and the example phrases are public by
construction, since they are the first sixty entropy values of the 128-bit
BIP39 space.
