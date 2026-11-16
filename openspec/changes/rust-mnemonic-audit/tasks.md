# Tasks: mnemonic utilities and bounded audit

## 1. Derivation core  (blocked by: —)
- [ ] HMAC-SHA512, BIP32 CKDpriv, path parser; BIP32/BIP39 vectors.
- [ ] Address derivation (compressed P2PKH, hash160/X targets).

## 2. CLI  (blocked by: 1)
- [ ] `--mnemonic-derive`, `--mnemonic-from-entropy`, `--mnemonic-audit`
      with limits, target check, rate/ETA and disclaimers; CLI tests.

## 3. Docs and close-out
- [ ] README section (limits, cost, authorized use), fmt/clippy/test, archive;
      PR.
