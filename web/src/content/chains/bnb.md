---
chain: bnb
title: "BNB Chain private keys: BEP-20 accounts and gas | Crypto"
description: "Browse 60 deterministic BNB Chain private keys and their 0x addresses, with the 18-decimal BNB gas unit and BEP-20 account model explained."
---

## What a BNB Chain private key controls

BNB Smart Chain (BSC) uses the same secp256k1 curve and keccak-derived account
as Ethereum. The key signs BSC transactions for one externally owned account,
and the account holds BNB for gas as well as any BEP-20 token balances. BSC is
EVM-compatible, so a contract call that works on Ethereum usually has a
counterpart here, but the two networks have separate chain IDs, separate state
and separate gas prices. A signature made for one chain is not automatically
valid on the other. The private key itself is not chain-specific: the same
scalar produces the same `0x` address on BSC, Ethereum and every other EVM
network, while the balance and nonce belong to each network independently.

## Address formats on this page

Every row shows the BEP-20-era account form: `0x` plus twenty bytes with the
EIP-55 checksum. There is no SegWit, base58 or taproot option on BSC. The
explorer link targets BscScan, and the address is the same string you would
paste into a BSC wallet. Because the account is shared across EVM chains, a
key that looks empty here can still hold value on another EVM network; this
page does not aggregate those balances.

## Key encodings and limits

Use 64 hexadecimal characters, optionally prefixed with `0x`. A Bitcoin-style
WIF is accepted by the key calculator as a secp256k1 encoding but is not the
native BSC format. BNB has 18 decimals, so one BNB is 10^18 wei-like base
units; the table reserves a balance column but leaves it as a placeholder in
this static build. The key controls the EOA, not the BEP-20 contracts it calls,
and it cannot move tokens that the account does not hold. Treat a key that has
ever been pasted into a website as exposed: an attacker with the scalar can
sign the same transactions you can.
