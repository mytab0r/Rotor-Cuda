# Wallet seed phrase: generate, report strength, derive one key

## Summary

Extend the cabinet wallet import card with a BIP39 seed-phrase block: generate a
12- or 24-word phrase with the existing seed stack, show it in the tab, report
its word count, entropy bits, checksum state and a brute-force estimate, then
derive one key on the selected chain's default BIP44 path into the vault.

## Why

The wallet page could only import a pasted WIF or hex key. A user who wanted a
fresh phrase had to leave the page, and nothing on the page said how strong a
phrase was. The seed studio already owns BIP39 generation, validation and BIP32
derivation, so the wallet can reuse it instead of adding crypto.

## Goals

1. Generate 12 or 24 words from `RotorSeedCrypto.generateBip39` in the tab.
2. Show the phrase in a readable, copyable field (not masked).
3. Report strength from the phrase itself: `12 words · 128-bit entropy · BIP39
   checksum ok`, plus a brute-force estimate.
4. Derive one chain-specific key and store it through the same vault path as a
   pasted WIF/hex key.

## Non-goals

- Storing, logging or sending the phrase; only the derived private key enters
  the encrypted vault.
- Multi-account or multi-address derivation from one phrase.
- Guessing derivation paths for chains without a preset (Zcash, Solana, Sui,
  TON).

## Success criteria

- The standard test phrase derives the pinned Ethereum and Bitcoin vectors on
  their default paths.
- A bad checksum is named and disables Add.
- The phrase is cleared after a successful add.
- `node scripts/ui-audit.mjs --serve` stays at 0 violations.
