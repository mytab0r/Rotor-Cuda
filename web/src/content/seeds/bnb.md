---
chain: bnb
title: "BNB Chain seed phrases: BIP44 EVM accounts | Crypto"
description: "60 deterministic 12-word BNB Chain phrases derived at the BIP44 coin-60 path into EIP-55 0x accounts that also exist on every EVM network."
---

## What a BNB Chain seed phrase controls

BNB Smart Chain reuses Ethereum's key machinery. A BIP39 mnemonic becomes a
64-byte seed, the seed produces a secp256k1 scalar on the standard coin-60
branch, and the scalar maps to one keccak account. That account pays gas in BNB
and can hold BEP-20 token balances and contract positions. BSC has its own chain
identifier, validator set and state, so its nonce and balance differ from the
Ethereum account at the same address even though the string is identical.

## Paths used on this page

The table derives `m/44'/60'/0'/0/0` for each phrase: the Ethereum coin type,
the first account, external change and address zero. BNB Chain does not define
a separate BIP44 coin type in this project, and no second branch is offered.
Because the path matches Ethereum's, importing the same words into an Ethereum
wallet produces the same `0x` string — a property to remember when one key is
meant to stay isolated to a single network.

## Address formats and limits

Rows show the twenty-byte account in EIP-55 checksum form, linked to BscScan.
There is no BSC-specific prefix, base58 variant or witness program. BNB has
eighteen decimals, while many BEP-20 tokens choose their own. A WIF can carry
the same scalar but has no BNB network marker. Balance cells here are reserved
placeholders in the static build; the page contacts no provider and sends no
address anywhere.
