# Wallet seed phrase design

## Decisions

### Reuse the seed stack

Generation, validation and BIP32 derivation call the existing
`apps/site/seed.js` + `apps/site/seed-crypto.js` (`generateBip39`,
`RotorSeed.validate`, `bip39Seed`, `bip32PrivateKey`). The wallet adds no crypto
and no randomness: `generateBip39` uses `crypto.getRandomValues`. Both scripts
are lazy-loaded from the page on first use, not added as blocking tags. Curve
work stays in the wasm core through the existing `derive_report` call
(`pubkey_compressed`), the same lookup `seed-page.js` uses.

The chain -> path presets live in `seed-crypto.js` (`SEED_PATHS`,
`seedPathFor`) so one table feeds the page and the Node test.

### The phrase is visible by design

The phrase field is a plain `textarea.mono`, not a password input: the user must
be able to read, check and copy the phrase before trusting it. It is cleared on
lock, after a successful add and when the selected word count no longer matches
the phrase. It is never written to storage, the URL, logs or the network.

### Strength comes from the phrase

Word count and entropy (`32 x words / 3`) are computed from the normalized
phrase; the BIP39 checksum and wordlist are checked by
`RotorSeed.validate`/`RotorSeed.wordlist`. A non-BIP39 length, an unknown word
or a bad checksum names the problem and disables Add.

The long brute-force estimate is visible text (`#wallet-seed-estimate`). The
shared tooltip primitive (`data-tooltip`, `window.RotorTooltip`) is a short
hover/focus label, and the audit caps it at 40 characters, so
`#wallet-seed-info` carries the compact figure (`128-bit ≈ 1.1×10^19 years`)
while `aria-describedby` points at the full estimate. This avoids a page-local
tooltip component and does not weaken the existing check.

### One chain per add

The phrase derives exactly one private key at the selected chain's preset path:

| Chains | Path |
| --- | --- |
| bitcoin, bitcoin-testnet | `m/84'/0'/0'/0/0` |
| ethereum, bnb, arbitrum, optimism, base, polygon, avalanche, zksync | `m/44'/60'/0'/0/0` |
| tron | `m/44'/195'/0'/0/0` |
| litecoin | `m/84'/2'/0'/0/0` |
| dogecoin | `m/44'/3'/0'/0/0` |
| bitcoin-cash | `m/44'/145'/0'/0/0` |
| xrp | `m/44'/144'/0'/0/0` |

### Refused chains

Zcash, Solana, Sui and TON have no BIP44 preset in this codebase (Solana, Sui
and TON use ed25519 schemes; Zcash needs its own transparent-address path). The
page refuses them with a message naming the chain and suggests a WIF/hex import.
It does not guess a path.

### One vault entry path

Duplicate detection, entry creation and the encrypted save moved from the
import submit handler into `addParsedEntry(parsed, derived, label)`. The WIF/hex
submit and the phrase action both call it, so a derived key and a pasted key
follow exactly the same validation, duplicate rule and save. The WIF/hex
messages and clearing behaviour are unchanged.

## Detector

`scripts/ui-audit.mjs` gains `wallet-seed-strength`. `auditWalletSeed` creates or
unlocks the audit vault, then checks the strength line (12 -> 128, invalid
checksum disables Add, 24 -> 256), and `auditPage` checks the resting DOM:
visible `#wallet-seed-strength` with a word count and an entropy figure,
`#wallet-seed-info` as an `.icon-button` with `aria-label` and `data-tooltip`,
and both action buttons at 44x44 or larger.

## Risks

- Phrase generation depends on Web Crypto and the lazy scripts; a load failure
  is shown in the existing error area and never falls back to weak randomness.
- A pasted phrase with an invalid checksum still shows its words; it is only
  refused at Add, so the user can correct it.
