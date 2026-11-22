---
chain: base
title: "Base private keys: 0x accounts on the OP Stack L2 | Crypto"
description: "Browse 60 deterministic Base private keys and their 0x addresses. Base is an OP Stack L2 where ETH pays gas and the account model is EVM."
---

## What a Base private key controls

Base is an Ethereum L2 built on the OP Stack and incubated by Coinbase. A Base
private key is a secp256k1 scalar; the corresponding keccak account signs
transactions that the Base sequencer orders and that eventually settle to
Ethereum. The account pays gas in ETH — Base has no separate native gas token —
and can hold ERC-20 tokens, NFTs and contract state deployed on the L2. Because
the address derivation is the EVM standard, the same key is valid on Ethereum,
Base and other OP Stack networks, each with its own balance and nonce.

## Address formats on this page

This page lists the EIP-55 `0x` account for every example key and links it to
BaseScan. There is no Base-specific prefix, base58 form or SegWit form. The
account is the same twenty bytes you would use in an Ethereum wallet; the
network selector, not the key, decides which chain receives a transaction.
Sending ETH to this address on Base does not automatically move value to
Ethereum, and the reverse requires a bridge or withdrawal flow.

## Key encodings and limits

Use 64 hex characters, optionally with `0x`. A WIF is a secp256k1 wrapper the
key calculator understands, but it is not how Base wallets export keys. ETH has
18 decimals on Base, and the balance column here is a fixed-height placeholder
in this static build; no balance request is made until the page hydrates. The
key controls the externally owned account, not the OP Stack bridge contracts or
the sequencer. It cannot speed up the challenge period, cannot recover a
transaction sent to a contract that rejects it, and cannot protect funds if the
scalar is copied.
