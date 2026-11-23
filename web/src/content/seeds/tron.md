---
chain: tron
title: "TRON seed phrases: BIP44 T-address accounts | Crypto"
description: "60 deterministic 12-word TRON phrases derived at the BIP44 coin-195 path into Base58Check T-addresses with the keccak account inside."
---

## What a TRON seed phrase controls

TRON signs with secp256k1 but presents accounts differently from Ethereum. The
BIP39 seed follows the BIP44 coin-195 branch to a private key; keccak256 of the
public key gives twenty account bytes; TRON adds the `0x41` network byte, a
double-SHA256 checksum and Base58Check encoding, producing a `T…` string. The
key authorizes TRX transfers and contract calls for that account, including
TRC-20 and TRC-721 assets. Bandwidth and energy, not a simple gas balance,
decide what a transaction may consume.

## Paths used on this page

The build derives `m/44'/195'/0'/0/0` for every phrase: TRON's registered coin
type, first account, external change, address zero. This is the branch TRON
wallets conventionally use, and it is distinct from Ethereum's coin-60 path, so
the same words produce a different key and a different account on the two
networks. The table shows address index zero; later indexes belong to the same
account branch.

## Address formats and limits

Rows show Base58Check `T…` addresses and open Tronscan. The same scalar also has
an EVM `0x` representation because the twenty bytes come from keccak, but TRON
wallets expect the `T…` form and a mismatched destination can lose funds. TRX
has six decimals. The balance column is a reserved placeholder and the page
does not query a node. The phrases are the first sixty values of the BIP39
entropy space, so their words are public and their derived keys carry no value.
