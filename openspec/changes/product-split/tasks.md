# Tasks: product split

Every phase is independently shippable and ends with acceptance evidence.
`Blocked by:` lines are the task-tracking edges used by `scripts/sync-board.mjs`;
a phase with a blocker does not start until the blocker's evidence exists.

Lanes: [core] `rotor-core`/`rotor-search`, [wasm] `crates/rotor-wasm`,
[desktop] CLI/GPU/pool client, [site] `apps/site`/`web`, [server] pool/API
server, [wallet] wallet surfaces, [ops] layout/CI/contracts.

## P0 - baseline and freeze (blocked by: none) [ops][wasm][desktop]

- [x] Freeze new first-party crypto implementations: no new address codec,
      BIP32 path, hash, KDF, keystore decoder or signature outside the target
      `rotor-core` boundary. Reviewers reject a duplicate; the rule is recorded
      in the change and later in `openspec/specs/architecture/spec.md`.
      Evidence: `design.md` section "P0 freeze".
- [x] Capture golden vectors from the current `main`, in the test tree (not
      `docs/`): key `0x...01`, ed25519 seed 1, RFC8032, TON v4R2 and W5,
      keystore scrypt and PBKDF2 frames, EIP-191, BIP143 P2WPKH, TRON
      TransferContract, scan/samples jobs.
      Evidence: `tests/vectors/*.json`; `cargo test --release --test golden_vectors`
      (3 passed); `cargo test -p rotor-wasm` (83 passed, 5 vector tests).
- [x] Record the baseline: 24 WASM exports, `apps/site/rotor_wasm.wasm` =
      501 119 bytes, test counts, `cargo test --release` duration.
      Evidence: `baseline.md` (SHA-256
      `68d99e442e0ce9837b3102842a89822a9ebe67d7f9bcbbd323a6b0f1c5a0afdf`;
      455 passed / 1 ignored in 42 s; wasm 83 passed).
- [x] Add the ABI snapshot skeleton (`wasm-abi.json`) and a Node test that
      compares it with the built artifact.
      Evidence: `crates/rotor-wasm/wasm-abi.json`;
      `node scripts/check-wasm-abi.mjs` (24 exports);
      `node --test scripts/check-wasm-abi.test.mjs` (4 passed).
- [x] Add the architecture boundary check skeleton (`cargo metadata` based):
      core has no network/GPU/server crates; no product depends on another.
      Evidence: `scripts/check-boundaries.mjs` (2 packages, 6 frozen `#[path]`
      includes); `node --test scripts/check-boundaries.test.mjs` (7 passed).
- [x] Acceptance evidence: the vectors reproduce on current `main`; the ABI
      snapshot matches the committed artifact; the boundary check passes on the
      current layout (with the expected exceptions listed).
      Evidence: `cargo test --release --test golden_vectors`;
      `cargo test -p rotor-wasm`; `node scripts/check-wasm-abi.mjs`;
      `node scripts/check-boundaries.mjs`; both gates wired into
      `.github/workflows/rust.yml` (`projects` job).

## P1 - extract `rotor-core` (blocked by: P0) [core][desktop][wasm][server]

- [x] Create `crates/rotor-core` and move `field`, `scalar`, `point`, `secp`,
      `hashes`, `base58` into it; keep public API names or re-export them.
      Evidence: `crates/rotor-core/src/`; `src/lib.rs` re-exports every moved
      module (design.md "Module path compatibility").
- [ ] Move `src/address/mod.rs` and the WASM codecs (`bech32`, `btc`, `evm`,
      `tron`, `ton`) into one core `address` module with explicit
      `TonWallet::V4R2` and `TonWallet::W5`. One implementation per encoding.
- [x] Split `src/mnemonic.rs`: BIP39/BIP32/WIF helpers go to core; the entropy
      audit, `TargetSet` usage and CLI driver stay in desktop.
      Evidence: `crates/rotor-core/src/mnemonic.rs` (11 unit tests moved);
      `run_audit`/`run_derive` stay in `src/mnemonic.rs`.
- [ ] Move `crates/rotor-wasm/src/{keystore,sign}.rs` and the message/tx
      signing paths into core; keep `json.rs` and ABI framing out of core.
- [ ] Create `crates/rotor-search` for `Split`, `SplitMix64`, `thread_seed`,
      chunk math, `TableManifest`, checkpoint format and target filtering.
- [ ] Repoint the pool server (`src/coordinator/{state,chunk_loop}.rs`) to
      `rotor-core` + `rotor-search`; remove `cli::U256`, `engine`, `bsgs` and
      `field`/`point`/`scalar`/`secp` imports from server modules.
- [x] Repoint `crates/rotor-wasm` to `rotor-core`; remove the six `#[path]`
      includes; the crate keeps compiling for `wasm32-unknown-unknown`.
      Evidence: `crates/rotor-wasm/Cargo.toml` + `src/lib.rs`;
      `node scripts/check-boundaries.mjs` reports no `#[path]` includes;
      `wasm-build-test` green.
- [ ] Update the workspace `Cargo.toml` and the 17 test files that use
      `rotor::...`; no test may reach into a product crate from another.
- [x] Delete the moved modules from the root package in the same change.
      Evidence: the six modules, `address/`, `chain`, `generated` and the pure
      mnemonic helpers no longer exist under `src/`.
- [ ] Acceptance evidence: `cargo build --workspace`;
      `cargo test --release`; `cargo test --release --features gpu` on the GPU
      runner; `cargo test -p rotor-wasm`; every P0 vector byte-identical;
      `node scripts/check-projects.mjs`; the boundary check passes without
      exceptions; `cargo tree` shows no network/GPU crate in core.

## P2 - WASM as a thin adapter (blocked by: P1) [wasm][site][wallet]

- [ ] Move request parsing and response formatting into `rotor-wasm`; core
      exposes typed operations. The derivation report JSON, keystore frame and
      transaction review JSON stay in the adapter.
- [ ] Keep all 24 exports and the pointer/length ABI unchanged. Add
      `wasm-abi.json` entries for every export and a Node test that fails on a
      name, arity or result-semantics drift.
- [ ] Add per-export golden blobs to the P0 vector suite; every result blob and
      every error buffer must be byte-identical.
- [ ] Add the size budget check: artifact <= P0 baseline + 5%; a larger
      artifact needs an explicit decision.
- [ ] Add the dependency gate: `cargo tree -p rotor-wasm` contains no crypto
      crate outside `rotor-core`; no `tiny_http`, `ureq`, `getrandom`, `scrypt`,
      `aes`, `hmac`, `pbkdf2` directly.
- [ ] Rebuild `apps/site/rotor_wasm.wasm`, run `crates/rotor-wasm/smoke.mjs`
      and `apps/site/worker-test.mjs` against both the fresh and committed
      artifacts, and commit the artifact.
- [ ] Acceptance evidence: 24/24 exports byte-identical; ABI snapshot green;
      size budget green; both JS tests green; `node scripts/check-ssot.mjs`
      green; the existing wallet and `/key` JS tests still pass, and the #462/#477
      browser tests pass once merged.

## P3 - pool contract and compatibility matrix (blocked by: P1; wasm ABI part by: P2) [ops][server][desktop][site]

- [ ] Create `contracts/pool/v1/` schemas for job, lease, heartbeat, result,
      bsgs-state and error, with one example per request/response.
- [ ] Create `contracts/site-api/v1/` schemas for the site-facing families in
      `data/routes.json` and `src/coordinator/mod.rs`.
- [ ] Create `crates/rotor-pool-protocol` with typed Rust bindings validated
      against the schemas; generate TypeScript bindings from the same source.
- [ ] Add `contracts/compatibility.json` and `scripts/check-compat.mjs`; a
      release row is mandatory for every product.
- [ ] Add the version rules: major = new path and dual-serve window; minor =
      optional field; patch = docs only; no in-place rename.
- [ ] Add the cross-product e2e suite: desktop to pool, worker to pool, core to
      WASM, wallet to core, previous-major client to current server.
- [ ] Add `scripts/check-contracts.mjs`: schemas validate, examples validate,
      matrix rows exist, no product imports another product's source.
- [ ] Acceptance evidence: schemas validate; examples validate; matrix complete
      for the current versions; e2e green; `check-contracts.mjs` green.

## P4 - split the desktop repository (blocked by: P1, P2, P3) [ops][desktop]

- [ ] Confirm a split trigger from `design.md` (release cadence, access
      boundary or CI cost). Without a trigger, land a directory split with the
      same contracts and mark the repository move deferred.
- [ ] Create `rotor-sdk` with `rotor-core`, `rotor-search`,
      `rotor-pool-protocol`, `rotor-wasm`, `contracts/` and the
      `data/chains.json` generator; tag v1.0.0.
- [ ] Create `rotor-desktop` with the CLI, engine, GPU/CUDA, checkpoints and
      pool client; depend on `rotor-sdk` by exact tag; pin the tag in
      `Cargo.toml`/lockfile.
- [ ] Move `build.rs` and `Rotor-Cuda/` with the desktop crate; update
      `gpu-bsgs-compile.yml`, `rust-release.yml` and `windows-release.yml`.
- [ ] Add `check-compat.mjs` and the cross-repo e2e (desktop against a released
      pool server) to the desktop CI.
- [ ] Acceptance evidence: clean clone builds `cargo build --release` without
      CUDA and `cargo build --release --features gpu` on the GPU runner; e2e
      green; no desktop build reads the site tree; the compatibility row is
      present.

## P5 - split the site repository (blocked by: P2, P3, P4) [ops][site][server]

- [ ] Confirm the site split trigger; otherwise land a directory split.
- [ ] Create `rotor-site` with the Astro site, `apps/site` assets, the pool/API
      server and the wallet (until P6); depend on `rotor-sdk` by exact tag.
- [ ] Pin the WASM artifact by digest in the site build; a mismatch fails
      loudly. Keep the `/a/<build>/` immutable asset contract.
- [ ] Add the site CI: Astro build, pool server build/tests, `ui-audit`,
      `check-ssot`, `check-projects`, browser E2E and the cross-repo e2e.
- [ ] Move `data/chains.json` consumption to the SDK-published outputs; keep
      `gen-ssot --check` as the gate.
- [ ] Acceptance evidence: Astro and pool server build from a clean clone; all
      public routes serve; `ui-audit` 0 violations; wasm digest matches; e2e
      green; no site build reads the desktop tree.

## P6 - wallet application (blocked by: P5) [wallet][wasm][ops]

- [ ] Confirm the wallet trigger (independent release, threat boundary or
      product decision); otherwise keep the wallet as a site route with its own
      release tag.
- [ ] Create the wallet app with seed, private-key and WIF restore; depend on
      `rotor-core` through the WASM artifact (or the Rust core for a native
      build).
- [ ] Move the JS BIP39/BIP32 in `apps/site/seed-crypto.js` and the
      vault KDF/cipher calls in `apps/site/wallet-vault.js` behind one adapter
      over core/platform primitives; no second derivation implementation.
- [ ] Preserve the wallet safety gates: no key to the server, testnet default,
      explicit mainnet arming, local review before broadcast, no auto-sweep.
- [ ] Add the key-leak regression test and the wallet-to-core vector suite.
- [ ] Acceptance evidence: restore from seed/key/WIF; every chain derives the
      core fixture; browser E2E and key-leak test green; no key in network,
      storage, URL or logs; the compatibility row is present.

## Cross-phase checklist

- [ ] Every phase deletes the old implementation it replaces; no long-lived
      compatibility shim or feature flag keeps two crypto paths alive.
- [ ] Every phase updates `projects.json`, `PROJECTS.md` and the area
      `AGENTS.md` when a path or owner changes.
- [ ] Every protocol change updates the schema, the typed bindings, the
      compatibility matrix, the examples and the e2e in one PR.
- [ ] Every WASM change rebuilds and commits the artifact, runs both JS tests
      and updates the ABI snapshot if the export set changed.
- [ ] Every product release records its `rotor-sdk` tag and its compatibility
      row.
- [ ] No new first-party cryptographic primitive outside `rotor-core`; the
      architecture gate (`crypto-duplicate`) fails otherwise.
