# Design: TON wallet versions

## Decisions

### D1. The set lives in `rotor-core`, not in either surface

`ton::TON_WALLET_VERSIONS` is the ordered list `[V3R2, V4R2, W5]`, and
`ton::ton_addresses(public_key)` returns one `TonAddress` per version in that
order. The WASM report and the desktop parity vector both call it, so a version
can only be added or dropped in one place.

Why: ROT-505 asks both surfaces to derive the same set. Two independent loops
would drift again and need another allowlist entry.

### D2. The primary `address` field keeps its current meaning

The desktop descriptor stays `TonUserFriendly(V4R2)` and the WASM report's
`address` field stays the W5 row, because both are existing product outputs.
The parity gate stops comparing that scalar for TON and compares the address
set in `addresses` instead. `chain-map.json` gains `"address_set": true` for
`ton`; the library compares the sets of values and fails on any added or
missing version.

Why: changing the primary address would change product behaviour beyond the
issue, and the set comparison is what the issue actually requires.

### D3. The WASM report is the only TON address source on the site

The `/ton.js` bundle exposes `address()` for v4R2 only. Once the WASM report
carries v4R2, the hand-built row on `/key` and the TON directory duplicates it
and forces a second derivation path. The pages drop that row and read
`ton_v3r2`, `ton_v4r2`, `ton_w5` from `report.addresses`.

Why: one implementation, one lazy dependency removed, and the WASM core is
already the source of `ton_w5` on those pages.

### D4. Mutation proof

- Dropping a version from `TON_WALLET_VERSIONS` changes the emitted rows and
  `parity-test.mjs` fails on the baseline drift / set mismatch.
- Swapping a version's code hash fails the pinned vectors in
  `crates/rotor-core/src/address/ton.rs`.

Ceiling: the parity gate compares address values, so a version dropped from
*the shared core and both regenerated baselines* would stay consistent. That
case is guarded by `TON_WALLET_VERSIONS` being a fixed-length array (removing
an entry is a compile error until the length is also edited) and by the pinned
Tonkeeper/tonweb vectors per version, not by the gate itself.
