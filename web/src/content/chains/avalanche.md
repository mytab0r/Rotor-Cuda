---
chain: avalanche
title: "Avalanche private keys: C-Chain 0x accounts | Crypto"
description: "Browse 60 deterministic Avalanche private keys and their C-Chain 0x addresses. AVAX pays gas; the X-Chain and P-Chain use other formats."
---

## What an Avalanche private key controls

Avalanche is a network of chains. The contract chain, known as the C-Chain, is
EVM-compatible, and the `0x` account on this page is its secp256k1 account. That
account pays gas in AVAX and holds ERC-20 tokens and Solidity contract state.
The same validator key material can also be used on the X-Chain, which handles
AVAX transfers with a different address encoding, and on the P-Chain, which
handles validators and subnets. This page deliberately shows only the C-Chain
account: treating the `0x` string as the whole of Avalanche would hide the other
chains' formats.

## Address formats on this page

Each row is the EIP-55 `0x` C-Chain account, linked to Snowtrace. The format is
the EVM standard, so the twenty bytes are the same as Ethereum's derivation for
that scalar. Avalanche's X-Chain uses a `X-avax1…` bech32-style address and the
P-Chain uses `P-avax1…`; those are different encodings of different key
purposes and are not rendered in this table. A C-Chain address cannot receive an
X-Chain transfer without a cross-chain operation, and vice versa.

## Key encodings and limits

Use 64 hexadecimal characters, with or without `0x`. A WIF encodes a secp256k1
scalar and the key calculator will derive the C-Chain account from it, but WIF
is not an Avalanche-native export. AVAX has 18 decimals on the C-Chain. The
balance column here is a static placeholder with a fixed row height, not a live
query. The key controls the C-Chain EOA; it does not by itself control staked
AVAX delegated to a validator, and it cannot move X-Chain or P-Chain balances
without the matching chain-specific address and transaction.
