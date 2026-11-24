# Design: crate boundaries, contracts and repository topology

Status: proposed, 2026-11-24. This document decides the target shape; it does
not move code.

## Decision

**Extract one product-neutral crypto library, keep the search and GPU layers
out of it, make the WASM crate a thin adapter, and replace the pool code
dependency with a versioned contract. Keep the current repository through P3;
split products only when their release cadence or CI cost justifies it.**

Four decisions carry the rest:

1. `rotor-core` is the only place a first-party cryptographic primitive is
   implemented.
2. `rotor-search` (CPU search + protocol math) exists so the pool server and
   the desktop share code without either importing the other product.
3. `rotor-wasm` keeps its 24-export pointer/length ABI and contains no crypto
   algorithm after P2.
4. Pool and site API changes are versioned contracts, tested across products,
   never in-place field renames.

## Target layering

```
                         +-------------------------------+
                         |          rotor-core           |
                         | curves, hashes, base58/bech32 |
                         | mnemonic/BIP32, WIF, keystore |
                         | address codecs, signing,      |
                         | chain descriptors             |
                         | no net, no GPU, no BSGS, no FS|
                         +------+---------------+--------+
                                |               |
              +-----------------+               +------------------+
              |                                                   |
   +----------v-----------+                          +------------v-------------+
   |      rotor-wasm      |                          |       rotor-search       |
   | thin pointer/length  |                          | CPU chunk math, target   |
   | ABI + JSON framing   |                          | filter, BSGS manifest,   |
   | no crypto            |                          | checkpoint format        |
   +----------+-----------+                          +-----+--------------+-----+
              |                                            |              |
              | wasm artifact                              |              |
   +----------v----------------------------+        +-------v------+  +----v-----------+
   |             rotor-site                |        | rotor-desktop|  | pool server    |
   | Astro/JS pages + wallet + pool server |        | core + search|  | (inside site)  |
   | consumes core, search and contract    |        | + CUDA + CLI |  | core + search  |
   | never imports desktop source          |        | + pool client|  | + protocol     |
   +----------+----------------------------+        +-------+------+  +----+-----------+
              |                                             |
              +----------- pool contract (v1) --------------+
```

The arrows are dependency directions, not deploy paths. `rotor-core` has no
arrow to a product. `rotor-search` depends on core. `rotor-wasm` depends on
core. Products depend on core, search (Rust products only), the WASM artifact
and the contract packages. No product depends on another product.

The site box contains the pool server because the puzzle, leases, proofs and
leaderboard are a site product obligation (`PROJECTS.md` route map and
`openspec/changes/product-strategy/design.md` D6.4). The pool server is a
consumer of `rotor-search` and the pool contract, not of `rotor-desktop`.

The wallet is a site surface until P6. After P6 it is a separate consumer of
`rotor-core` (through the WASM artifact or a native build); it never depends on
`rotor-desktop` or the pool server.

## Why `rotor-search` exists

The brief's simplified layering says "desktop = core + BSGS + CUDA". That is
true for the desktop *binary*, but the pool server also needs chunk math and
challenge offsets today:

- `src/coordinator/state.rs:20-27` imports `cli::U256`,
  `engine::{Split, SplitMix64, thread_seed}`, `field::Fe`, `point`, `scalar`,
  `secp`.
- `src/coordinator/chunk_loop.rs:21-22` imports `crate::engine` and
  `crate::scalar::Scalar`.

If BSGS/search lives only in `rotor-desktop`, the pool server must import
desktop source, which violates the product rule. `rotor-search` is the smallest
crate that removes that dependency:

- `Split`, `SplitMix64`, `thread_seed` and chunk range math (deterministic
  protocol arithmetic).
- `TableManifest`, table identity and checkpoint format (protocol data).
- Target filtering and target-set parsing used to validate a result.
- CPU search primitives that the pool server needs for proof verification.

It does **not** contain the CLI, the scan engine's thread orchestration, GPU
dispatch, CUDA, `tiny_http`, `ureq`, or any blocking input loop. The desktop
keeps its engine and GPU layers and depends on `rotor-search` for the shared
pieces. This is the only place where the target diagram in the brief is refined;
the reason is the "site must not depend on desktop code" rule itself.

## `rotor-core` boundary

### In

| Module (target) | Current source | Notes |
|---|---|---|
| `curve` | `src/{field,scalar,point,secp}.rs` | secp256k1 arithmetic, point parse/format |
| `hashes` | `src/hashes.rs` | SHA-256, double SHA-256, RIPEMD-160, hash160, keccak256 |
| `base58` | `src/base58.rs` | Base58Check, WIF, Ripple alphabet |
| `bech32` | `crates/rotor-wasm/src/bech32.rs` | Bech32/Bech32m, segwit encode |
| `address` | `src/address/mod.rs` + `crates/rotor-wasm/src/{btc,evm,tron,ton}.rs` | one codec per encoding; P2PKH/P2SH/P2WPKH/P2TR, CashAddr, EIP-55, TRON, Solana, Sui, TON v4R2 and W5 |
| `mnemonic` | pure parts of `src/mnemonic.rs` and the BIP39/BIP32 logic now in `apps/site/seed-crypto.js` | BIP39 wordlist/seed, BIP32 CKDpriv, path parsing; entropy is caller-supplied |
| `keystore` | `crates/rotor-wasm/src/keystore.rs` | Ethereum JSON keystore KDF/cipher (scrypt, PBKDF2, AES-CTR, MAC) |
| `sign` | `crates/rotor-wasm/src/sign.rs` | ECDSA sign/verify/recover, RFC6979, low-S/DER |
| `message` | EIP-191 and TRON `signMessageV2` paths in `crates/rotor-wasm/src/{evm,tron}.rs` | typed message signing |
| `tx` | transaction builders/signers in `crates/rotor-wasm/src/{btc,evm,tron}.rs` | BIP143 P2WPKH, EIP-1559, TRON TransferContract; serialization and local verify |
| `chain` | `src/chain.rs` + `src/generated/chains.rs` | descriptors; consumes generated data |

### Explicitly out

| Concern | Where it goes | Why |
|---|---|---|
| BSGS solver, table build, workfile | `rotor-search` / `rotor-desktop` | search, not key material; may be expensive and stateful |
| GPU, CUDA, wgpu, device discovery | `rotor-desktop` | hardware-specific, not portable to WASM/wallet |
| Target filtering, checkpoints | `rotor-search` | product search state |
| CLI parsing, usage, exit codes | `rotor-desktop` | product UI |
| Scan engine, chunk leasing loop | `rotor-desktop` and pool server | orchestration and network |
| Pool server state, jobs, accounts, leaderboard | `rotor-site` backend | server product logic |
| HTTP client/server (`tiny_http`, `ureq`) | products | no network in core |
| Monitor, analytics, admin, notifications | `rotor-site` backend | server product logic |
| Self-update, self-check, filesystem state | `rotor-desktop` | OS and deployment concerns |
| `getrandom` / OS entropy | products | core accepts entropy; it does not read the OS |

Core may use `std` (the current code does) but MUST NOT read the clock, the
filesystem, environment variables or the network. A caller that needs a random
key or mnemonic supplies entropy from the OS RNG or an environment secret, per
the root `AGENTS.md` security rule.

### Feature policy

Core has no `gpu`, `network` or `server` feature. Optional features are allowed
only for size/compile-time choices that cannot change output (for example
`std` vs `alloc` later). A feature that changes a derivation, a signature or a
serialized byte is a bug in the boundary, not a feature.

### TON is two encodings, not two implementations

P1 must preserve both current outputs:

- `TonWallet::V4R2` — desktop (`src/address/mod.rs:262-318`).
- `TonWallet::W5` — site/WASM (`crates/rotor-wasm/src/ton.rs:1-21`).

Each encoding is implemented once in core and carries fixtures. The chain
descriptor names which encoding a product displays. A later product decision
may converge the site and desktop on one wallet version; P1 does not make that
decision and does not silently change an address.

## `rotor-wasm` as a thin adapter

After P2 the crate contains:

- the allocator, `Session`, result/error buffers and the `alloc`/`dealloc`/
  `result_ptr`/`result_len`/`clear_result`/`error_ptr`/`error_len` ABI;
- request parsing for the JSON-shaped operations (EVM/BTC/TRON transaction
  requests, keystore frames);
- JSON serialization of the derivation report and review objects;
- the 24 exported functions with their current names and signatures;
- calls into `rotor-core` for every cryptographic operation.

It contains no curve arithmetic (except the core re-export it calls), no hash
implementation, no address encoder, no BIP32, no keystore KDF and no ECDSA.

The ABI is frozen by a committed snapshot (`wasm-abi.json`) listing export
names, parameter counts and result semantics. The snapshot is checked by a Node
test against the built artifact. A new export is allowed only with a new
snapshot entry and a compatibility note; renaming or removing an export is a
breaking ABI change and needs a site/wallet migration.

### Output-parity evidence

P2 is accepted only when, for the P0 vector set:

- `derive_report` and `derive_report_network` return byte-identical JSON;
- `public_key_report`, `public_key_add`, `public_key_subtract`,
  `public_key_mul` return byte-identical blobs;
- `keystore_decrypt` returns the same key or the same error text;
- `evm_sign_tx`, `evm_unsigned_tx`, `evm_sign_message`, `btc_sign_tx`,
  `btc_unsigned_tx`, `tron_sign_tx`, `tron_unsigned_tx` return byte-identical
  hex/JSON;
- `scan` and `samples` return the same blobs for the same fixed job;
- error paths return the same status code and the same fixed English message.

Binary reproducibility of the `.wasm` file is **not verified** and is not
claimed (`crates/rotor-wasm/AGENTS.md`). Freshness stays functional: build the
artifact, run `smoke.mjs` and `worker-test.mjs` against both the fresh and the
committed file. Size is a guardrail, not a parity claim: the artifact must not
exceed the P0 baseline (501 119 bytes) by more than 5% without an explicit
decision.

### What stays in the adapter, not core

- The derivation report's JSON field order, labels and string formatting. It is
  a browser ABI payload. Core returns typed rows; the adapter serializes them.
- The keystore request frame parser. Core takes a typed request.
- The transaction review JSON. Core returns a typed transaction; the adapter
  formats it.

If the wallet app later needs the same JSON outside WASM, the serializer can
move to a small `rotor-report` module after a parity test, not by copying it.

## Pool and site API contracts

### Sources

```
contracts/
  pool/v1/
    job.json
    lease.json
    heartbeat.json
    result.json
    bsgs-state.json
    error.json
    examples/*.json
  site-api/v1/
    jobs.json
    status.json
    me.json
    monitor/*.json
  compatibility.json
```

`contracts/pool/v1` covers the client protocol: `GET /api/v1/jobs`,
`POST /api/v1/lease`, `POST /api/v1/heartbeat`, `POST /api/v1/result`,
`GET|POST /api/v1/bsgs/state`, plus the error envelope. These are the paths the
desktop client uses today (`src/coordinator/client.rs:119-233`) and the browser
worker uses through `apps/site/rotor-worker.js`.

`contracts/site-api/v1` covers the site-facing API families in
`data/routes.json` and `src/coordinator/mod.rs`: jobs/status/me, public
summaries, monitor, admin and chain helpers. It is a contract for the site and
wallet, not for the desktop.

The typed Rust bindings live in `crates/rotor-pool-protocol` and are generated
from, or validated against, the schemas. TypeScript bindings for the site are
generated from the same source. Do not hand-maintain two type sets.

### Versioning rules

1. **Major** — removing or renaming a field, changing a type, changing a
   status code, changing a unit or a semantic. Requires a new path
   (`/api/v2`) and a dual-serve window of at least one product release.
2. **Minor** — adding an optional request or response field that older clients
   ignore. No path change. The schema marks it optional and the server never
   requires it from an old client.
3. **Patch** — documentation, examples, error text that is not matched by
   clients. Error text used by a client is a major change.
4. **Protocol version** — every request/response carries an explicit version
   or is served under a versioned path. The server rejects an unknown major
   with a typed error, never a silent fallback.
5. **WASM ABI** — the export set is a contract versioned with the artifact.
   A change follows the same major/minor logic; the site/wallet pin the artifact
   digest.
6. **Data schema** — `data/chains.json` and `data/assets.json` carry a schema
   version. Generated outputs record the source digest. A consumer fails loudly
   when the digest does not match its lock.

`compatibility.json` is the matrix:

```json
{
  "products": {
    "rotor-desktop": [
      { "version": "3.0.0", "core": "1.0.0", "protocol": "1", "wasm_abi": null }
    ],
    "rotor-site": [
      { "version": "2026.12", "core": "1.0.0", "protocol": "1", "wasm_abi": "1", "data": 1 }
    ],
    "wallet": [
      { "version": "0.1.0", "core": "1.0.0", "protocol": "1", "wasm_abi": "1", "data": 1 }
    ]
  }
}
```

A release is invalid if its row is missing. `scripts/check-compat.mjs` in each
repository reads its own row and fails when the versions it builds against are
not listed.

### Cross-product end-to-end

One suite, run on every contract change and nightly across repositories:

1. **Desktop to pool server.** Create a job, lease a chunk, scan it, submit a
   result and challenge, receive acceptance. Uses the packaged protocol types,
   not either product's internal state.
2. **Browser worker to pool server.** The same flow through the WASM artifact
   and `rotor-worker.js`; proves the site's client path.
3. **Core to WASM.** The P0/P2 vectors through the built artifact.
4. **Wallet to core.** Seed/key/WIF restore and derivation for every chain,
   compared with the core fixture set.
5. **Protocol compatibility.** The previous major version's client against the
   current server during the dual-serve window.

The suite is the only place that imports more than one product. It lives with
the contracts and runs in CI, not in a product build.

## Repository topology

### Recommendation

| Repository | Contents | Split phase | Reason |
|---|---|---|---|
| `rotor-sdk` | `rotor-core`, `rotor-search`, `rotor-pool-protocol`, `rotor-wasm`, `contracts/`, `data/chains.json` + generator | P4 (created with the desktop split) | These artifacts version together; splitting them would multiply releases and CodeQL runs without isolating anything |
| `rotor-desktop` | CLI, engine, GPU/CUDA, checkpoints, pool client | P4 | Heaviest CI, different release cadence, no site dependency |
| `rotor-site` | Astro site, `apps/site` assets, pool/API server, wallet until P6 | P5 | Continuous content deploy, different toolchain, owns the HTTP surface |
| `rotor-wallet` | Wallet app | P6 | Different threat model and release cadence; only after it exists as an app |

Why not one repository forever: the desktop CUDA build and the site content
deploy have incompatible cadences, and CodeQL/audit triage is easier when the
served surface and the offline tool are separate. Why not six repositories
(core, search, protocol, wasm, desktop, site): every extra repository adds a
CodeQL run, dependency alerts, secret scanning, a release workflow, a tag and a
compatibility row. Core, search, protocol and WASM change together; one
`rotor-sdk` repository is the smallest split that removes the product coupling.

### Split triggers

A phase's repository split happens only when at least one holds:

- the product needs a release cadence the monorepo cannot provide (desktop CUDA
  versus site content);
- an access boundary requires contributors to see only one product;
- the product's CI dominates the pipeline or cannot run on every PR.

If no trigger holds, the phase may land as a directory split (`apps/desktop`,
`apps/site`, `crates/*`) with the same contracts and pinned versions. The
contracts, not the repository count, are what the architecture requires.

### CI and CodeQL cost

| Cost | One repository today | Four repositories |
|---|---|---|
| CodeQL Rust/JS runs | 1 | 3-4 (SDK, desktop, site; wallet later) |
| Dependency alerts / Dependabot | 1 queue | 4 queues |
| Secret scanning / audit workflow | 1 | 4 |
| Release workflow and credentials | 1 | 4 |
| Cross-repo e2e | none | 1 suite, multiple checkouts and pinned tags |
| Branch protection / required checks | 1 set | 4 sets |

Mitigations:

- Reusable workflows for audit, CodeQL and release; one aggregate status per
  repository.
- Cross-repo e2e nightly and on contract tags, not on every product PR.
- `rotor-sdk` is the only repository with the crypto code, so CodeQL's highest
  value target exists once, not three times.
- A single security-alert dashboard or a per-repository owner; the existing
  `.github/workflows/codeql-alerts.yml` rule ("fail daily while any alert is
  open") must not become an untriaged queue.

## Migration sequence and gates

| Phase | Move | Gate |
|---|---|---|
| P0 | Capture vectors and freeze new crypto code | Vectors reproduce on current `main`; baseline recorded |
| P1 | Extract `rotor-core` and `rotor-search` in place | Full test matrix; every P0 vector identical; boundary check |
| P2 | Make `rotor-wasm` an adapter | ABI snapshot; per-export byte parity; size budget |
| P3 | Contracts and compatibility matrix | Schemas validate; e2e green; matrix complete |
| P4 | Create `rotor-sdk`; split desktop | Clean-clone build with and without CUDA; pinned tag; e2e |
| P5 | Split site | Astro + pool server + UI gates; pinned wasm digest; e2e |
| P6 | Wallet app | Seed/key/WIF restore; vectors; key-leak test |

Each phase is one PR (or one small PR series) and can stop without leaving two
implementations alive. P1 deletes the moved modules; it does not leave a
compatibility shim. P2 deletes any crypto left in the adapter. A phase that
cannot delete the old path is not finished.

## Alternatives considered

| Option | What it buys | Cost | Verdict |
|---|---|---|---|
| Keep the current layout | No migration work | Divergence continues; pool coupling stays; release cadence stays shared | Reject |
| Move everything into one "core" including search/GPU | One crate | Core becomes hardware- and server-coupled; wallet/WASM pull dead weight; violates the requested boundary | Reject |
| Publish `rotor-core` to crates.io first | Semver and external consumers | Release ceremony for a GPL crate with no external consumer; slows every change | Defer until a consumer exists |
| Git submodules for core/protocol | Nominal code sharing | Detached HEADs, pinned SHA drift, no atomic change; agents skip `submodule update` | Reject (same reasoning as `repo-structure/design.md`) |
| Six repositories | Maximum isolation | Six CodeQL queues, six release graphs, six compatibility rows | Reject |
| Four repositories with `rotor-sdk` | Product isolation where it matters; one crypto CI target | Four release graphs | **Adopt** |
| Keep wallet inside the site forever | No extra repo | Wallet cannot release independently and shares the site's deploy risk | Reject after P6 trigger |

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| P1 changes a byte | P0 vectors for every export and every address family; the phase fails on a diff; no algorithm changes in P1 |
| TON decision is made implicitly | Both encodings are explicit and tested; the chain descriptor chooses; a change requires a separate proposal |
| Core dependency set grows | `cargo tree` gate: core has no `tiny_http`, `ureq`, `ctrlc`, `xorf`, `getrandom`, `build.rs` CUDA link, `bsgs`, `engine`, `cli`, `coordinator`, `selfupdate` |
| WASM size grows | Baseline + 5% budget; no network/server/OS crates in core; review any new dependency |
| `sha2` 0.10/0.11 split leaks into core | Keep both digest families if needed for byte parity; unify later with vectors |
| Version skew | Exact tags, `compatibility.json`, `check-compat` gate, dual-serve window, nightly cross-repo e2e |
| Double maintenance | Phase deletes the old path; freeze new crypto code until P2; no long-lived feature flag |
| Pool chunk bytes change | P0 vectors pin chunk math and challenge offsets; `rotor-search` moves the exact code |
| CI/CodeQL cost | `rotor-sdk` consolidation; reusable workflows; nightly e2e |
| GPL source obligation | Every repo keeps `GPL-3.0-only`; WASM releases record the source tag and build recipe |
| Product team cannot see the SDK | Public repositories and pinned artifacts; `PROJECTS.md` documents the reading order |

## Open questions

1. Which TON wallet version should the site and desktop converge on after
   parity? (Product decision; P1 does not answer it.)
2. Should `rotor-core` become `no_std`-friendly for a future embedded/extension
   target, or is `std` acceptable? (No current consumer needs `no_std`.)
3. Is a git tag + release artifact enough for `rotor-core`, or does the owner
   want crates.io? (Recommendation: tag first; publish only on external
   demand.)
4. Does the pool server truly need `rotor-search`, or can all shared pieces be
   protocol types plus core? (Recommendation: start with the smallest
   `rotor-search`; remove it if the protocol package absorbs the math.)
5. Which repository owns `data/chains.json` and the generator after P4?
   (Recommendation: `rotor-sdk`, with generated outputs published by digest.)
6. Is the wallet a separate repository or an app inside `rotor-site` with its
   own release tag? (Recommendation: separate after P6's trigger.)
7. Can CodeQL be centralized across the four repositories without losing
   per-repo alerts? **Not verified.**

## P0 evidence

Status: implemented 2026-11-24. This section records the behaviour-parity
baseline that every later phase must preserve.

### Fixed inputs and coverage

`tests/parity/keys.json` holds seven deterministic 32-byte inputs: secp256k1
keys `0x01`, `0x02`, `0x03`, `0xff`, and three seeds
(`000102…1e1f`, the RFC 8032 seed, and `11…11`). Every chain in
`data/chains.json` is covered — the 18 mainnet chains through the desktop
descriptor and the four testnet entries as wasm-only records, because the
desktop chain table registers mainnet chains only.

For a secp256k1 full key, both cores derive from the key directly. For a seed,
the desktop core derives the per-chain key with BIP32 along the descriptor's
`hd_path` (the path and `path_applied` flag are recorded), and the same derived
key is fed to the wasm `derive_report`; ed25519 chains use the 32 bytes as the
ed25519 seed. `crates/rotor-wasm` has no BIP32/SLIP-0010 implementation, so P0
compares address and public-key derivation on identical key material, not the
two BIP32 implementations. `apps/site/seed-crypto.js` BIP32/SLIP-0010 parity is
an open item and is not claimed here.

`tests/parity/chain-map.json` is the one mapping from a chain slug to its wasm
`derive_report` row, address format and whether the desktop WIF version byte
equals the Bitcoin mainnet byte exposed by `derive_report`. Each vector carries
the canonical `address`, the private key, the public key and WIF where the
chain defines one, the derivation path and whether it was applied, plus an
`addresses` map of every format that side exposes (Bitcoin
P2PKH/uncompressed/P2SH-P2WPKH/P2WPKH/P2TR, Litecoin's four rows, and the
single canonical row for the other chains).

### Where the vectors live

| Path | Role |
|---|---|
| `tests/parity/keys.json` | fixed inputs |
| `tests/parity/chain-map.json` | chain → wasm row / format / WIF comparability |
| `tests/parity/desktop-vectors.json` | golden desktop output (`src/`) |
| `tests/parity/wasm-vectors.json` | golden wasm output (`crates/rotor-wasm`) |
| `tests/parity/parity-allowlist.json` | accepted divergences with reason + issue |
| `tests/parity.rs` | recomputes desktop live and fails on golden drift |
| `tests/parity/parity-test.mjs` | recomputes wasm live, compares both baselines |
| `tests/parity/generate-wasm.mjs` | regenerates the wasm golden |
| `tests/parity/regenerate.mjs` | runs the whole regeneration + gate |

Both golden files are small text JSON; nothing binary or secret is recorded
(only fixed test vectors).

### Mismatch inventory

The baseline compares 126 desktop/wasm vectors (7 keys × 18 mainnet chains) and
399 fields (private key, address, public key, and WIF where the versions are
comparable). 392 fields match exactly; the 7 remaining are the TON address for
all seven keys:

| Chain | Field | Desktop | Wasm | Decision |
|---|---|---|---|---|
| `ton` | address | wallet v4R2 (`src/address/mod.rs`) | wallet W5 (`crates/rotor-wasm/src/ton.rs`) | allowlisted, issue #330; P1 exposes both explicitly, the product choice is separate |

No other chain diverges on address, public key, private key or WIF. The
allowlist test also fails when an entry stops matching a real mismatch, so the
list can only shrink.

### Regenerate and run

```sh
# after an intentional src/ or crates/rotor-wasm change
sh scripts/build-wasm.sh
node tests/parity/regenerate.mjs --wasm target/wasm32-unknown-unknown/release/rotor_wasm.wasm
```

The gate runs in `.github/workflows/rust.yml`: `cargo test --release` executes
the desktop golden test, and the `wasm-build-test` job runs
`node tests/parity/parity-test.mjs` against both the fresh and the committed
artifact. The workflow has no path filter, so any PR that touches `src/**`,
`crates/rotor-wasm/**`, `data/chains.json` or `tests/parity/**` runs it.

Baseline at capture: 24 wasm exports, `apps/site/rotor_wasm.wasm` = 501 119
bytes, parity wasm generation ≈60 ms and comparison ≈55 ms on the capture
machine. These are guardrails, not reproducibility claims.

## P1 evidence

Status: implemented 2026-11-24 (ROT-488). P1 is a move: no algorithm, address
value, JSON field, transaction byte or WASM export changed. Every P0 vector
still reproduces on both surfaces.

Scope note: this P1 PR extracts `rotor-core` and repoints the WASM adapter. The
`rotor-search` extraction, the keystore/sign move out of the adapter, and the
pool-server repoint remain P1 checklist items for later PRs; they are not
claimed here.

### Dependency graph

Before:

```text
rotor (lib + rotor + rotor-coord)
  field, scalar, point, secp, hashes, base58, address, chain, generated, mnemonic
rotor-wasm (independent workspace member)
  #[path] ../../../src/{base58,field,hashes,point,scalar,secp}.rs
  bech32, btc, evm, tron, ton, keystore, sign, derive, json
```

After:

```text
rotor-core (no net, GPU, BSGS, CLI, coordinator, FS or clock)
  field, scalar, point, secp, hashes, base58, address (+ ton), chain, generated,
  mnemonic (pure BIP39/BIP32)

rotor (desktop)            rotor-wasm (browser adapter)
  -> rotor-core              -> rotor-core
  re-exports every module    no #[path] source include
```

### What moved

| Target | Source | Notes |
|---|---|---|
| `crates/rotor-core/src/{field,scalar,point,secp,hashes,base58}.rs` | `src/{...}.rs` | verbatim; internal `crate::` paths unchanged |
| `crates/rotor-core/src/address/mod.rs` | `src/address/mod.rs` | TON branch now versioned |
| `crates/rotor-core/src/address/ton.rs` | W5 from `crates/rotor-wasm/src/ton.rs`; v3R2/v4R2 added | one implementation, explicit version |
| `crates/rotor-core/src/{chain,generated}.rs` | `src/{chain,generated}` | descriptors and generated tables; `gen-ssot.mjs` `RS_PATH` updated |
| `crates/rotor-core/src/mnemonic.rs` | pure parts of `src/mnemonic.rs` | BIP39/BIP32 helpers and their 11 unit tests |

The TON `w5_address` tests (3) moved from the adapter to core. The
field/scalar/point/secp/hashes/base58/address/chain modules had no inline unit
tests; their integration tests (`tests/crypto.rs`, `tests/chain.rs`,
`tests/parity.rs`) stay in the desktop package and now exercise the
re-exported core.

### What stayed

- Desktop: CLI (`cli`, `main`, `bin/rotor-coord`), engine, BSGS, workfile,
  checkpoint, filter, targets, GPU/CUDA, coordinator, monitor, selfcheck,
  selfupdate, benchmark, and the mnemonic audit driver (`run_audit`,
  `run_derive`, target loading, progress output).
- WASM adapter: allocator/ABI, `derive`, `json`, `bech32`, `btc`, `evm`,
  `tron`, `keystore`, `sign`, and the `ton` call site (now a re-export of
  `rotor_core::address::ton`). These move in P2.
- `rotor-search` does not exist yet.

### Module path compatibility

| Public path | Before | After |
|---|---|---|
| `rotor::{field,scalar,point,secp,hashes,base58,address,chain,generated}` | modules in `src/` | `pub use rotor_core::<module>;` |
| `rotor::address::ton_v4r2_address` | `src/address/mod.rs` | `rotor_core::address::ton`, re-exported |
| `rotor::chain::{ChainDescriptor,Family,AddressEncoding,KeyMaterial,...}` | `src/chain.rs` | `rotor_core::chain`, re-exported |
| `rotor::generated::chains::*` | `src/generated/chains.rs` | `rotor_core::generated`, re-exported |
| `rotor::mnemonic::{derive,master_from_seed,derive_path,...}` | `src/mnemonic.rs` | re-exported from `rotor_core::mnemonic`; `run_*` stays local |
| internal `crate::{field,scalar,...}` in desktop code | unchanged | resolves through the root re-export |
| internal `crate::{hashes,scalar,secp,...}` in the adapter | `#[path]` modules | `pub(crate) use rotor_core::...` aliases |

### TON wallet versions (owner decision, 2026-11-24)

The core no longer bakes one implicit TON contract into address derivation:

- `rotor_core::address::ton::TonWalletVersion` is a `#[non_exhaustive]` enum
  with `V3R2`, `V4R2` and `W5`.
- `ton_address(public_key, version)` is the single entry point;
  `AddressEncoding::TonUserFriendly(TonWalletVersion)` makes the chain
  descriptor name its version. Adding a version is a new enum variant plus one
  code cell, not a signature change.
- Current outputs are unchanged: the desktop `ton` descriptor selects `V4R2`
  and the WASM `derive_report` selects `W5`, so the P0 allowlist (issue #330,
  follow-up #505) still describes the same seven mismatches.
- v3R2 is implemented from tonweb's `WalletV3ContractR2` code cell; v4R2 is
  the pinned tonweb/`@ton/ton` cell; W5 is the moved official `wallet_v5` BoC.
  Core tests pin the code-cell hashes/depths and Tonkeeper, tonweb and
  `@ton/ton` address vectors for all three versions.

### Verification (2026-11-24)

```text
cargo test --release                          exit 0; 22 suites, 441 passed, 0 failed, 1 ignored
cargo test --release -p rotor-core            17 passed, 0 failed
cargo test -p rotor-wasm                      75 passed, 0 failed
cargo test --release --test parity            desktop_vectors_match_the_committed_baseline ok
node tests/parity/parity-test.mjs <fresh>     126 vectors, 399 fields, 392 matched, 7 allowlisted, 0 mismatches
node tests/parity/parity-test.mjs <P0 artifact> same counts, 0 mismatches
sh scripts/build-wasm.sh                      506 012 bytes; 24/24 exports unchanged
node crates/rotor-wasm/smoke.mjs              smoke ok
node apps/site/worker-test.mjs                PASS
cargo fmt --all --check                       clean
cargo clippy --workspace --all-targets -D warnings  clean
node scripts/check-projects.mjs               OK (1001/1002; Cargo.lock ignored)
node scripts/gen-ssot.mjs --check             OK (generated Rust path updated)
node scripts/check-ssot.mjs                   OK
```

WASM byte identity does **not** hold: the artifact is 506 012 bytes against
the P0 501 119-byte baseline (+4 893, +0.98%, inside P2's +5% budget), and the
SHA-256 differs (`0f2447d1…` vs `68d99e44…`). The parity vectors, not the
bytes, are the authority and are identical. The growth is the crate boundary:
the primitives now codegen in a separate rlib instead of the adapter crate, and
`rotor-core` carries the v3R2/v4R2 paths the WASM adapter does not call.
Disabling `ed25519-dalek`'s default `fast` backend in core removed the browser
artifact's new feature tables; that change alone moved the size from 538 075
(+7.4%) to 506 012 (+0.98%). A byte-identical artifact would need an LTO/profile
change, which P1 does not make.

### Mutation proof

1. Generator-constant flip in `rotor-core`:
   `0x59F2_815B_16F8_1798` → `…1799` in `crates/rotor-core/src/secp.rs`.

   ```text
   $ cargo test --release --test parity
   desktop parity baseline drifted: vector 0 (key-1/bitcoin) differs: ...
   test result: FAILED. 0 passed; 1 failed

   $ sh scripts/build-wasm.sh && node tests/parity/parity-test.mjs <fresh artifact>
   ... seed-repeat-11/zksync address: desktop="0x9fE6…" wasm="0x01b8…" ...
   parity FAILED (exit 1)
   ```

2. Root re-export removed: `secp` dropped from
   `pub use rotor_core::{...}` in `src/lib.rs`.

   ```text
   $ cargo test --release --no-run
   error[E0432]: unresolved import `crate::secp`
   error[E0433]: cannot find `secp` in the crate root
   error: could not compile `rotor` (lib) due to 5 previous errors
   ```

Both mutations were reverted; the checkout and the committed 506 012-byte
artifact are the ones measured above.

