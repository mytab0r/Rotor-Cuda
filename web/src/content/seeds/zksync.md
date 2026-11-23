---
chain: zksync
title: "zkSync Era seed phrases: BIP44 EVM accounts | Crypto"
description: "60 deterministic 12-word zkSync Era phrases derived at the BIP44 coin-60 path into 0x accounts proved to Ethereum by the zk rollup."
---

## What a zkSync Era seed phrase controls

zkSync Era is a zero-knowledge rollup that proves state transitions to
Ethereum. A mnemonic supplies the BIP39 seed and the coin-60 branch supplies a
secp256k1 key; the keccak account signs Era transactions and pays gas in ETH.
The account can hold ERC-20 tokens and call Solidity contracts, and its balance
and nonce are local to the rollup. Era also supports native account
abstraction, so a deployed smart account may have custom signature rules that a
plain externally owned account does not.

## Derivation path used here

Rows use `m/44'/60'/0'/0/0`, matching Ethereum's coin type and the first
external address. The table derives the standard EOA only; it does not deploy
or model a smart account, and it does not read the rollup's account
abstraction state. That distinction matters when a phrase has already been used
to deploy a contract account at the same address — the key may be only one part
of that account's signature policy.

## Address format and limits

The account is shown in EIP-55 form and linked to the Era explorer. No
zkSync-specific prefix exists; the bytes are the shared EVM keccak result. A
bridge withdrawal returns value to Ethereum through the bridge contract and its
finality rules, not through a different key. ETH has eighteen decimals. These
balance cells are placeholders, and the phrases are intentionally public: they
are the start of the BIP39 entropy range, not a source of wallet material.
