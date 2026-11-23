---
chain: polygon
title: "Polygon seed phrases: BIP44 EVM 0x accounts | Crypto"
description: "60 deterministic 12-word Polygon phrases derived at the BIP44 coin-60 path into 0x accounts that pay gas in POL and hold ERC-20 tokens."
---

## What a Polygon seed phrase controls

Polygon PoS is an EVM-compatible proof-of-stake chain. Its wallets take a BIP39
mnemonic, stretch it to a seed, and follow the coin-60 BIP32 branch to a
secp256k1 key. The corresponding keccak account signs Polygon transactions and
pays gas in POL. It may also hold ERC-20 tokens, NFTs and positions in
contracts deployed on Polygon. Polygon maintains its own chain identifier,
validator set and state, so the account's balance and nonce are independent of
the Ethereum account at the same address.

## Derivation path used here

Each phrase is derived at `m/44'/60'/0'/0/0`, the Ethereum coin type with
account and address index zero. Polygon's gas-token migration from MATIC to POL
did not alter this path or the address format. The same branch is used by the
other EVM pages here, which makes the shared account visible: the rows differ
only by the chain whose explorer they open.

## Address format and limits

The table shows EIP-55 `0x` accounts linked to PolygonScan. There is no
Polygon-only encoding, and a WIF carries no Polygon network marker. POL uses
eighteen decimals. The balance cells reserve their height and stay static; no
provider is contacted by the page. Because the examples are the lowest BIP39
entropy values, their words and derived keys are public, and anyone can rebuild
every address shown. Valueless examples are the point; funded use requires
fresh entropy from a trusted device.
