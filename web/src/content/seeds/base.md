---
chain: base
title: "Base seed phrases: BIP44 EVM accounts on the L2 | Crypto"
description: "60 deterministic 12-word Base phrases derived at the BIP44 coin-60 path into 0x accounts where ETH pays gas on the OP Stack rollup."
---

## What a Base seed phrase controls

Base is an Ethereum Layer 2 built on the OP Stack. One mnemonic supplies the
BIP39 seed, and the coin-60 branch supplies a secp256k1 key whose keccak account
signs Base transactions. The account pays gas in ETH — there is no separate
native token — and can receive ERC-20 tokens, NFTs and contract state deployed
on the rollup. Because Base shares Ethereum's address derivation, the same
phrase also opens the same address on Ethereum, with a separate balance and
nonce that this page does not query.

## Derivation path used here

The example rows use `m/44'/60'/0'/0/0`. BIP44 coin type 60, account zero,
external change and address zero. This is the branch most EVM wallets try first,
so a phrase imported into a Base wallet and the same phrase imported into an
Ethereum wallet land on one string. If a wallet offers several accounts, it is
usually advancing the account component, not inventing a Base-specific path.

## Address format and limits

Addresses appear in EIP-55 form and link to BaseScan. No Base prefix or base58
form exists; the twenty account bytes come from the same keccak hash used
everywhere else in the EVM family. Bridging changes which network holds the
value, not the key or the display. ETH uses eighteen decimals on Base. The
balance column is reserved but empty in this static build, and the phrases are
deliberately public examples from the beginning of the BIP39 entropy space, so
they are never suitable for storing funds.
