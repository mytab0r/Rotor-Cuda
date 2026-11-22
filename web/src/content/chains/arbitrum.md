---
chain: arbitrum
title: "Arbitrum private keys: 0x accounts on an L2 rollup | Crypto"
description: "Browse 60 deterministic Arbitrum private keys and their 0x addresses. The same secp256k1 key controls an account on the optimistic L2."
---

## What an Arbitrum private key controls

Arbitrum One is an optimistic rollup that settles to Ethereum. Its accounts use
the familiar `0x` keccak address, and a secp256k1 key signs the L2 transaction
that the sequencer includes. The account holds ETH for gas on Arbitrum and can
hold ARB, ERC-20 tokens and contract positions deployed on the rollup. The rollup
batches transactions and posts compressed data to Ethereum, so the same address
can exist on both layers with different balances and different nonces. A key
compromised on one EVM network is compromised on Arbitrum too, because the
scalar and address derivation are shared.

## Address formats on this page

The table shows the EIP-55 `0x` account for each example key. Arbitrum does not
introduce a second address encoding: the account bytes come from the same
keccak hash as Ethereum. The explorer link opens Arbiscan for that account.
There is no separate "Arbitrum key" format, and a WIF does not carry an
Arbitrum network marker — it only encodes the scalar. If you move funds from
Ethereum to Arbitrum through a bridge, the destination address is this same
`0x` string, but the bridge contract, not the key, performs the transfer.

## Key encodings and limits

Input is 64 hex characters, with or without `0x`; the key calculator also
accepts a WIF as a secp256k1 wrapper. ETH has 18 decimals on Arbitrum and pays
the L2 gas, while ARB is a separate token with its own contract. The balance
column in this build is a reserved placeholder: no provider is queried until
the page runs its client-side balance step. The key cannot force a withdrawal
from the rollup, cannot change the sequencer's ordering, and cannot recover
assets bridged to a contract address that the account does not control.
