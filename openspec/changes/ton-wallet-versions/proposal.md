# TON wallet versions: one set on both surfaces

## Summary

Expose every supported TON wallet contract version (v3R2, v4R2, W5) from one
place in `rotor-core`, emit the full set from the WASM derive report, make the
P0 parity gate compare the TON address **set** instead of a single address, and
remove the `ton/address` divergence from `tests/parity/parity-allowlist.json`.

## Why

`rotor-core` already derives v3R2, v4R2 and W5 with pinned code hashes and
independent vectors, but each surface still picks one: the desktop chain
descriptor selects v4R2 (`crates/rotor-core/src/chain.rs`) and the WASM report
emits only `ton_w5` (`crates/rotor-wasm/src/derive.rs`). Because the two
baselines disagree on the one `address` field, the P0 gate carries a standing
allowlist entry (`tests/parity/parity-allowlist.json`, issue #330). The owner
decision in ROT-505 is that the TON contract version is not an arbitrary
default: the product must expose all versions the same way Bitcoin exposes
Legacy/SegWit/Taproot.

## Scope

In scope:
- One helper in `crates/rotor-core/src/address/ton.rs` that returns the ordered
  version set for a public key; both surfaces call it.
- `crates/rotor-wasm/src/derive.rs` emits `ton_v3r2`, `ton_v4r2` and `ton_w5`
  rows for the ed25519 report.
- `tests/parity.rs` writes all three TON addresses into the desktop vector's
  `addresses` map; `tests/parity/lib.mjs` compares the TON address set;
  `tests/parity/chain-map.json` lists the three WASM rows.
- Delete the `ton/address` allowlist entry; the gate must pass with no
  remaining TON divergence.
- `/key`, `/mnemonic-seeds/<chain>` and `/private-keys/<chain>` render each TON
  version as its own row, taken from the WASM report. The hand-built v4R2 row
  from the `/ton.js` bundle disappears from those pages, so the 545 KB bundle
  is no longer loaded there.

Out of scope:
- The cabinet wallet's single `ton` row (`apps/site/wallet.js`); it signs with
  one contract version and is not part of this parity slice.
- Other chains' version sets.

## Risks

- Regenerating both P0 baselines changes committed fixtures. Every changed
  vector must be explained by the new TON rows and nothing else; an unexplained
  diff fails the review.
- The WASM artifact and its vendored copies (`web/public/**`,
  `apps/site/rotor_wasm.wasm`) must be rebuilt and re-locked in the same PR.
