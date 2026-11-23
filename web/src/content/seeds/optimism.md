---
chain: optimism
title: "Optimism seed phrases: BIP44 EVM accounts | Crypto"
description: "60 deterministic 12-word Optimism phrases derived at the BIP44 coin-60 path into 0x accounts that hold ETH gas and OP tokens on the rollup."
---

## What an Optimism seed phrase controls

OP Mainnet is an OP Stack rollup whose accounts follow Ethereum's rules. The
mnemonic yields a BIP39 seed and a secp256k1 key; the key signs L2
transactions for one `0x` account. That account pays fees in ETH and can hold
OP, ERC-20 tokens and other contract positions on the rollup. Settlement data
is posted to Ethereum, yet the account's nonce and balance belong to the L2.
The same words imported into an Ethereum wallet expose the same address, so a
phrase should be treated as shared EVM material rather than an OP-only secret.

## Derivation path used here

The page walks `m/44'/60'/0'/0/0` for every phrase. It is the Ethereum coin
type with account, change and address index all at zero. Optimism does not
introduce a distinct BIP44 branch in this project, which is why the rows can be
compared directly with the Ethereum and Base pages. Changing the last number
moves to the next receiving address; changing the account number starts a
separate branch of the hierarchy.

## Address format and limits

Each address is the checksummed EIP-55 form and opens the Optimistic Etherscan
entry. The OP token does not change the address format; it is a contract on the
network. ETH has eighteen decimals on the rollup, and the balance column is a
fixed-height placeholder in this build. A compact wallet can derive these
branches quickly, but that speed does not make the example phrases secret. They
are the first sixty 128-bit entropy values, reproducible by anyone.
