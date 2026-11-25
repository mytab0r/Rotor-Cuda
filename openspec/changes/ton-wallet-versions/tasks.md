# Tasks: TON wallet versions

## 1. Core

- [x] `ton::TON_WALLET_VERSIONS` and `ton::ton_addresses(public_key)` return
  v3R2, v4R2 and W5 in one ordered set; a unit test pins the order and the
  three addresses per key.
- [x] `crates/rotor-wasm/src/derive.rs` emits `ton_v3r2`, `ton_v4r2` and
  `ton_w5` rows with the same public key and their StateInit hashes.

## 2. Parity gate

- [x] `tests/parity.rs` writes the three TON addresses into the desktop
  vector's `addresses` map.
- [x] `tests/parity/lib.mjs` compares the TON address **set** when
  `chain-map.json` sets `"address_set": true`; a missing or extra version is a
  mismatch.
- [x] `tests/parity/chain-map.json` lists the three WASM rows for `ton`.
- [x] Regenerate both baselines, confirm the only changed vectors are TON, and
  delete the `ton/address` entry from `tests/parity/parity-allowlist.json`.

## 3. Site

- [x] `/key` shows three TON rows from the WASM report and no longer loads
  `/ton.js` for a hand-built v4R2 row.
- [x] `/mnemonic-seeds/ton` renders Wallet v4R2, W5 and v3R2 as separate
  columns and `/private-keys/ton` exposes the same three as address-type tabs
  (v4R2 stays the default), all read from the WASM report; the old `?type=`
  link still lands on the default tab.
- [x] The global search reads the three report rows: the TON filter and card
  show all versions and the all-chains view uses v4R2 as the canonical row.
- [x] `node scripts/ui-audit.mjs` is green on the three pages at 375/768/1280
  (24 page runs, 0 violations; desktop layout deltas are reference-only).

## 4. Evidence

- [x] `cargo test --release --test parity`, the wasm build and both JS test
  suites pass; the rebuilt `apps/site/rotor_wasm.wasm` is committed and the
  vendor lock regenerated.
- [x] Independent review (the `critic` agent, a different model) opened the
  built key page and the TON directory, pasted geometry (three tabs, v4R2
  active, 60 addresses, no overflow) and re-ran the mutation proof.
