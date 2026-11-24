# Product split: one crypto core, three products, versioned contracts

Areas: desktop, wasm-core, site, coordinator, ops

## Summary

Split the current single Rust package into a product-neutral crypto library
(`rotor-core`) and three products that consume it:

- **`rotor-site`** — SEO calculators, key/address lists, the puzzle, later the
  cabinet. It serves HTML/JS and owns the pool/API server. It consumes the core
  through the WASM artifact and consumes the pool over a versioned HTTP
  contract.
- **`rotor-desktop`** — the Rust + CUDA search tool. It is standalone, works
  without the site, and has an optional pool client.
- **`wallet`** — the anonymous wallet that restores from a seed, private key or
  WIF. It depends on the core and stays inside the site until it becomes its own
  application.

`crates/rotor-wasm` stops being a second home for chain logic and becomes a thin
pointer/length adapter over `rotor-core`. The pool protocol becomes a versioned
contract package, not an import of the server's state module.

This change is a migration plan. Phase 1 moves code with **no behaviour
change**; every later phase is independently shippable. No product features are
added.

Status: proposed, 2026-11-24. Every current-state claim below is verified
against the tree at this date; the few items that could not be verified are
marked **not verified**.

## Why

### The premise is almost right, but "duplicated" needs precision

There is **no shared crypto library**. The root package `rotor` is one crate
(`Cargo.toml:1-41`) and `crates/rotor-wasm` is a separate workspace member with
its own dependency set and no `rotor` dependency
(`crates/rotor-wasm/Cargo.toml:11-27`, `Cargo.toml:46-48`).

However, six primitives are **not** duplicated: the WASM crate compiles the
same source files through `#[path]` includes — `base58`, `field`, `hashes`,
`point`, `scalar`, `secp` (`crates/rotor-wasm/src/lib.rs:53-63`). That is
source-level reuse with no library boundary: a change to `src/secp.rs` can break
the WASM build without a version, and the WASM crate carries its own feature and
dependency resolution.

What *is* duplicated is the layer above those primitives:

| Concern | Root package | WASM crate | Site JS |
|---|---|---|---|
| Address encodings | `src/address/mod.rs` (380 lines) | `bech32.rs`, `btc.rs`, `evm.rs`, `tron.rs`, `ton.rs` (2 760 lines) | `apps/site/address-codecs.js` (303 lines) |
| BIP32 / mnemonic | `src/mnemonic.rs:95-141` | not present | `apps/site/seed-crypto.js:229-260` |
| Ethereum keystore | not present | `keystore.rs` (433 lines) | `apps/site/keystore-parser.js` |
| ECDSA signing | `k256` recovery only (`src/monitor/auth.rs:105-133`) | hand-rolled `sign.rs` (310 lines) | calls WASM |
| Transaction signing | not present | `btc.rs`, `evm.rs`, `tron.rs` | calls WASM |

So the accurate statement is: **the low-level curve arithmetic and hashes are
source-shared; address codecs, BIP32, keystore and signing are implemented twice
or three times, and the pool server is wired to desktop internals.**

### The divergence is not hypothetical

The desktop and the site already disagree about the TON wallet:

- Desktop implements wallet **v4R2** (`src/address/mod.rs:262-318`).
- The WASM core and the site implement wallet **v5 / W5**
  (`crates/rotor-wasm/src/ton.rs:1-21`).
- The parity test documents the gap instead of failing on it
  (`tests/chain.rs:8-12`: "the current site report exposes TON wallet W5 …
  while this descriptor implements wallet v4R2").

Two implementations of the same chain already produce different addresses for
the same seed. That is the class of defect this change exists to prevent.

### The pool boundary is a code dependency today

- The pool **server** imports desktop modules: `cli::U256`,
  `engine::{Split, SplitMix64, thread_seed}`, `bsgs::TableManifest`, `field`,
  `point`, `scalar`, `secp` (`src/coordinator/state.rs:20-27`,
  `src/coordinator/chunk_loop.rs:21-22`).
- The desktop pool **client** imports server state: `bsgs::TableManifest` and
  `coordinator::state` (`src/coordinator/client.rs:13-14`).

The two products therefore cannot be released independently: a protocol change
is a source change in the other product. A versioned contract removes that
coupling.

### Release cadence and product boundaries

- The desktop binary is standalone; its only network paths are the optional
  `--coordinator` pool client (`src/cli.rs:58`, `src/main.rs:186-188`) and
  self-update (`src/selfupdate.rs`). It does not need the site. Its CUDA/GPU CI
  is the heaviest job in the repository.
- The site is deployed continuously and has its own toolchain (Astro, static
  assets, UI gates). Its release should not wait for a CUDA build.
- The wallet is a distinct product surface with a different threat model. It
  should not be released as a side effect of a site deploy once it becomes an
  app.

The current layout forces all three through one `Cargo.toml`, one test binary
set and one release graph.

## What changes

1. **`rotor-core`** — a Rust library with one implementation of every
   first-party cryptographic primitive: curve arithmetic, hashes, Base58,
   Bech32/Bech32m, address codecs, BIP39/BIP32, WIF, Ethereum keystore, message
   and transaction signing, chain descriptors. No network, no GPU, no BSGS, no
   CLI, no coordinator, no filesystem state.
2. **`rotor-search`** — a small CPU-only crate with the search/protocol
   primitives the pool server and the desktop share: chunk split math,
   `SplitMix64`, target filtering, BSGS table manifest, checkpoint format. This
   exists so the pool server does not import desktop code and the desktop does
   not import server code. GPU/CUDA stays in `rotor-desktop`.
3. **`rotor-wasm`** — a thin adapter: allocator, result buffers, ABI framing,
   JSON request/response encoding. Every cryptographic operation is a call into
   `rotor-core`. The 24 exported functions and the pointer/length ABI do not
   change.
4. **`rotor-site`** — the public site plus the pool/API server. It consumes the
   WASM artifact and the pool contract. It must not depend on `rotor-desktop`
   source.
5. **`wallet`** — depends on `rotor-core`; today it remains a route in the site;
   after P6 it is its own application.
6. **Contracts** — `contracts/pool/v1` and `contracts/site-api/v1` JSON
   Schemas, typed Rust/TS bindings, `compatibility.json`, and cross-product
   end-to-end tests. A breaking protocol change bumps the major version and the
   path (`/api/v2`), never an in-place field rename.

The migration order is fixed: core extraction (P1) → WASM adapter (P2) →
contracts (P3) → desktop repository (P4) → site repository (P5) → wallet app
(P6). Each phase is independently shippable and reversible.

## Scope

### In

- The module boundary and dependency direction.
- The core crate contents and exclusions.
- The WASM adapter contract and output-parity evidence.
- The pool and site-API versioning plan, compatibility matrix and cross-product
  e2e.
- The repository topology and split triggers.
- Re-scoping of current work that touches these boundaries.

### Out

- Any new product feature or UI change.
- Any behaviour change in P1. P1 moves code; it does not rename a public
  address, change a derivation path, change a JSON field or change a
  transaction byte.
- A repository split in the first PR. P1-P3 stay in the current repository.
- Publishing `rotor-core` to crates.io or another registry. Versioned tags and
  release artifacts are enough until an external consumer appears.
- Choosing a single TON wallet version for both products. P1 exposes both
  explicitly and proves parity; the product decision is separate.
- Rewriting the hand-rolled ECDSA in terms of `k256`, or vice versa. That is a
  later, separately reviewed change.
- Deleting legacy trees (`BinSort/`, `Others/`, `Release/`).
- Consolidating CodeQL, dependency alerts or release workflows beyond what the
  split requires.

## Impacted domains

- `architecture` (new): crate boundaries, dependency direction, contracts.
- `desktop`: module moves, pool client, CUDA build and release workflow.
- `wasm-core`: adapter, ABI snapshot, output parity, size budget.
- `site`: WASM consumption, site API contract, repository split.
- `coordinator`: pool server split out of desktop imports, protocol package.
- `wallet`: core dependency, seed/BIP32 consolidation, future app.
- `ops`: workspace layout, CI path filters, CodeQL and alert monitors, release
  artifacts, compatibility matrix.

## Acceptance criteria

1. **Core boundary is machine-checked.** `cargo metadata` plus a repository gate
   prove that `rotor-core` has no dependency on `tiny_http`, `ureq`, `ctrlc`,
   `xorf`, `getrandom`, CUDA, `bsgs`, `engine`, `cli`, `coordinator` or
   `selfupdate`, and that no product crate depends on another product crate.
2. **P1 is behaviour-preserving.** The full test matrix passes
   (`cargo test --release`, `cargo test --release --features gpu` on a GPU
   runner, `cargo test -p rotor-wasm`), and every golden vector from P0 is
   byte-identical. A changed vector fails the phase.
3. **P2 is byte-identical at the ABI.** All 24 WASM exports produce the same
   result blobs and the same error buffers for the golden vectors; the export
   names and signatures are frozen in a committed ABI snapshot; the WASM
   artifact is no larger than the P0 baseline plus 5%.
4. **P3 contracts are versioned and complete.** Every pool request/response and
   every site API family has a schema, an example and a version; the
   compatibility matrix names core, protocol, WASM ABI and data-schema versions
   for each product release; the cross-product e2e suite passes.
5. **P4-P6 are independent builds.** A clean clone of each product builds,
   tests and releases against a pinned `rotor-sdk` tag; no product build reads
   another product's source tree; the cross-product e2e passes against the
   released artifacts.
6. **No silent duplication.** A new first-party hash, KDF, address encoder,
   BIP32 path, keystore decoder or signature implementation outside
   `rotor-core` fails review and the architecture gate (detector name
   `crypto-duplicate`).

## Impact on current work

This change collides with work already on the board. None of the items below is
cancelled; each needs a re-scope before P1 starts.

| Work item | Key | Conflict | Required re-scope |
|---|---|---|---|
| Repo structure and agent coordination | epic #190, ROT-320..325 | Its Phase 3 `ROT-323` already plans `crates/rotor-core`, but its sketch puts `filter`/`bsgs` primitives in core (`repo-structure/design.md:55-60,118-124`). That contradicts "GPU/BSGS never enter core". | Make `product-split` P1 the implementation of ROT-323; change the core entry to the boundary below; move search primitives to `rotor-search`. |
| Rust-only desktop, all chains | epic #191, ROT-326..333 | `ROT-330` builds TON v4R2 while the site ships W5; `ROT-327`/`ROT-328` add address codecs in desktop. | Block new desktop-only codecs after P1; implement both TON variants in core with fixtures; `ROT-330` becomes "select and document the canonical TON variant", not a second encoder. |
| Transaction building, local signing, broadcast | epic #196, ROT-365..377 | `ROT-366` says "Add scalar inversion to `src/scalar.rs`", `ROT-367` adds an address/script codec, `ROT-368` adds network-aware derivation — all in the old layout. | Retarget ROT-366/367/368 to `crates/rotor-core`; land after P1 or rebase P1 under them. The WASM ABI they add is part of the P2 snapshot. |
| Frontend platform / Astro cutover | epic #294, ROT-295..302; PR #451, #462, #477 | P2 freezes the WASM ABI that `web/src/lib/wasm-core.ts` and `web/src/lib/key-core.ts` consume; P5 splits the site repository. `web/src/lib/address-codecs.ts` is a build-time bridge to `apps/site/address-codecs.js`, not a new implementation, and must stay that way. | Rebase #451/#462/#477 after P2; add the ABI snapshot to the browser regression gate; keep the bridge; P5 owns the repository move, not the page migration. |
| Cabinet wallet and its slices | epic #186 (ROT-284..286), #236, #443/#444, wallet-portfolio (#273, closed), wallet-history (#376, closed), wallet-top-assets-wif (#388, closed), walletconnect-deeplinks (#401, closed) | All call `derive_report`, `evm_sign_message`, `evm_sign_tx`, `btc_sign_tx`, `tron_sign_tx` or `keystore_decrypt`; `wallet.js:821-822` uses the JS BIP32 in `seed-crypto.js`. | P2 preserves every export byte-for-byte; P6 re-scopes the wallet into its app. The JS BIP32/BIP39 and `wallet-vault.js` primitives are candidates for the core in P1/P6, not new work in parallel. |
| Site wallet studio | epic #195, ROT-348..360 | Adds wallet/signing entry points on the site. | No new crypto code; use `rotor-core` through WASM. The route work continues. |
| Single source of truth | #264, ROT-361/362 | `data/chains.json` feeds both `src/generated/chains.rs` and `apps/site/chains.generated.js`; after the split both products need the same data. | P3/P4 move the data and generator into `rotor-sdk` (or publish generated outputs with digests); `gen-ssot --check` remains the gate. |
| Address activity monitor | epic #188, ROT-303..311 | `src/monitor/auth.rs` uses `k256` recovery while the WASM core hand-rolls ECDSA; two signature implementations. | `ROT-305` (wallet auth) calls core verification; keep `k256` until a separate change proves parity. |
| Security advisories | change #440, ROT-441.. | The daily "no open code-scanning alerts" gate is repository-wide. Four public repositories mean four alert queues. | Add one aggregate monitor or a per-repo triage owner before P4; do not let a split create an untriaged queue. |
| Admin cabinet, edge privacy, donor parity, SEO | #233, #234, #187, #193 | No crypto conflict; path-only impact when P5 moves the site. | Update path globs and CI filters in the P5 commit. |

`data/routes.json` is the route inventory, not a product boundary: P5 moves the
renderer/repository behind a route family, it does not add, remove or re-status
one. `/cabinet/wallet` stays in `rotor-site` until P6.

`docs/process/task-tracking.md` requires one sub-issue per `tasks.md` section.
This change creates P0-P6 sub-issues under its epic; the `blocked by:` edges are
the ones in the section headings, and `scripts/sync-board.mjs` mirrors them.

Open pull requests at the time of writing:

- **#451** `feat(web): migrate /key to Astro…` — touches `data/routes.json`,
  `scripts/check-ssot.mjs`, `web/src/lib/{wasm-core,key-core,
  address-codecs}.ts`. It must not add a second address codec; P2's ABI
  snapshot is its guard.
- **#462** `test(web): browser E2E, axe and visual regression gate` — touches
  `projects.json`, `PROJECTS.md`, `web/tests`, `data/vendor.lock.json`. Its
  browser fixtures become part of the P2/P3 parity evidence.
- **#477** `test(web): pin /key address-format scope…` — based on #462; no core
  change, but its `/key` format fixtures belong in the parity suite.

The working tree is currently on `pr451-rebuild` with an unrelated
`.impeccable/config.json` modification. P1 must start in a separate worktree
under `.claude/worktrees/` per `AGENTS.md`; do not share a tree with the /key
migration.

## Risks / unknowns

| Risk | Severity | Mitigation |
|---|---|---|
| TON canonical version is a product decision, not a code decision | High | P1 exposes `TonV4R2` and `TonW5` as named encodings with fixtures; both products keep their current output until a separate decision; no silent switch. |
| WASM binary reproducibility is **not verified** (`crates/rotor-wasm/AGENTS.md`) | Medium | Do not claim binary reproducibility. Gate on output blobs, the ABI snapshot and functional freshness (`smoke.mjs`, `worker-test.mjs`). |
| WASM size grows when core pulls dependencies | Medium | `cargo tree -p rotor-wasm` gate; size budget baseline + 5%; no `getrandom`, `tiny_http`, `ureq` in core. |
| `sha2 0.10` / `0.11` split in the WASM crate (`crates/rotor-wasm/Cargo.toml:12-15`) | Medium | Keep both digest families in core if the keystore math needs them; unify only in a separate, vector-gated change. |
| CI and CodeQL cost multiply after the repository split | High | Four repositories × CodeQL, dependency alerts, secret scanning, audit and release workflows. Consolidate core/search/protocol/WASM in one `rotor-sdk` repo; use reusable workflows; run cross-repo e2e nightly and on tags, not on every PR. |
| Version skew between products and `rotor-sdk` | High | Pin exact tags; `compatibility.json`; a `check-compat` gate in every repo; dual-serve protocol versions for one deprecation window. |
| Double maintenance during the transition | High | P1 is a move, not a rewrite; delete the old module in the same phase; freeze new crypto implementations until P2 lands; no feature flags keeping two implementations alive. |
| Splitting the pool server from desktop may change chunk/challenge bytes | High | `Split`/`SplitMix64`/`thread_seed` and the manifest move to `rotor-search`; the P0 vectors pin chunk math and challenge offsets; a byte difference fails P1. |
| GPL-3.0 source availability across repositories | Medium | Every repo stays `GPL-3.0-only`; every WASM release records the source tag and build recipe; no product wraps core in a way that hides source. |
| A repository split without a trigger adds coordination cost for no benefit | Medium | P4-P6 are triggered by release cadence, access boundary or CI cost; otherwise land a directory split with the same contracts. |
| `rotor-core` becomes a monolith with optional features | Medium | Core has no feature flags for network/GPU; search, protocol and adapter live outside it. |

**Not verified:** whether an external consumer needs a published crate; whether
GitHub CodeQL for Rust can be centralized across repositories without losing
alerts; the real CI runtime of a four-repository split.

## References

- `Cargo.toml:1-48` — one root package, two binaries, one workspace member.
- `crates/rotor-wasm/Cargo.toml:11-27` — independent WASM dependency set.
- `crates/rotor-wasm/src/lib.rs:53-63` — `#[path]` source reuse.
- `crates/rotor-wasm/src/lib.rs:933-1250` — 24 exported ABI functions.
- `src/lib.rs:1-33` — desktop, search, coordinator and monitor in one crate.
- `src/address/mod.rs:262-318` — TON v4R2.
- `crates/rotor-wasm/src/ton.rs:1-21` — TON W5.
- `tests/chain.rs:8-12` — documented TON divergence.
- `src/mnemonic.rs:95-141`, `apps/site/seed-crypto.js:229-260` — two BIP32
  implementations.
- `apps/site/address-codecs.js:37,88,160,213` — JS SHA-256, Base58Check and
  CashAddr.
- `src/coordinator/state.rs:20-27`, `src/coordinator/chunk_loop.rs:21-22`,
  `src/coordinator/client.rs:13-14` — pool server/client source coupling.
- `src/monitor/auth.rs:105-133` — `k256` recovery, a second ECDSA path.
- `crates/rotor-wasm/smoke.mjs:6` — the WASM module has no imports.
- `apps/site/rotor_wasm.wasm` — 501 119 bytes at 2026-11-24.
- `openspec/changes/repo-structure/{proposal,design,tasks}.md` — existing
  workspace split plan.
- `openspec/changes/rust-desktop-all-chains/design.md` D1/D4 and `tasks.md`
  section 6 — desktop chain and TON plan.
- `openspec/changes/tx-sign-broadcast/tasks.md` section 1 — WASM crypto plan.
- `openspec/changes/frontend-platform/{proposal,tasks}.md` — site cutover.
- `openspec/changes/ssot/proposal.md` — chain identity SSOT.
- `docs/process/task-tracking.md` — epic/sub-issue convention.
- `data/routes.json` — route families that P5 moves.
