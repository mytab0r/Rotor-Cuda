# architecture — delta specification

## ADDED Requirements

### Requirement: One implementation of every first-party cryptographic primitive

Every cryptographic primitive implemented by first-party code MUST have exactly
one implementation, and that implementation MUST live in `rotor-core`. This
covers curve arithmetic, hashes, Base58/Base58Check, Bech32/Bech32m, address
encoders, BIP39/BIP32, WIF, Ethereum keystore KDF/cipher, ECDSA signing and
recovery, message signing and transaction signing.

Platform-provided primitives (the browser `WebCrypto` API, the OS RNG) are not
counted as first-party implementations, but a product MUST reach them through
one adapter, not through ad-hoc copies.

#### Scenario: a second address encoder is proposed

- GIVEN a product change adds a new address encoding
- WHEN the encoder duplicates an algorithm that already exists in `rotor-core`
- THEN the architecture gate fails with detector `crypto-duplicate`
- AND the change is reworked to call the core implementation or to add the
  encoding once in core

#### Scenario: a product-specific derivation path

- GIVEN the site needs a new BIP32 path preset
- WHEN it is implemented
- THEN the path parsing and CKDpriv are core calls; the page supplies the path
  string and renders the result
- AND no HMAC, scalar arithmetic or public-key multiplication is added to
  JavaScript, TypeScript or the WASM adapter

### Requirement: Core purity

`rotor-core` MUST NOT contain or depend on:

- network clients or servers (`ureq`, `tiny_http`, sockets);
- GPU code, CUDA build scripts, `wgpu` or device discovery;
- BSGS, search engines, checkpoints, workfiles or target scanning;
- CLI parsing, process exit handling or terminal output;
- the pool/API server, jobs, accounts, leaderboard, monitor or analytics;
- self-update, self-check or filesystem state;
- the OS RNG or the clock. Entropy and time MUST be supplied by the caller.

#### Scenario: a GPU dependency reaches core

- GIVEN a change adds a CUDA or `gpu` feature to `rotor-core`
- WHEN the boundary check runs
- THEN it fails and names the offending dependency
- AND the code stays in `rotor-desktop` (or `rotor-search` if CPU-only and
  shared)

#### Scenario: entropy is requested

- GIVEN a caller needs a new mnemonic or key
- WHEN it calls core
- THEN it passes entropy obtained from the OS RNG or a configured secret
- AND core never calls `getrandom`, reads the OS entropy device, the registry or
  an environment variable itself

### Requirement: WASM is a thin adapter

`rotor-wasm` MUST contain only the pointer/length ABI, memory management,
request framing, JSON formatting and calls into `rotor-core`. It MUST NOT
contain a curve, hash, KDF, address encoder, BIP32, keystore or signature
implementation.

The export set and the pointer/length ABI MUST remain stable. A committed ABI
snapshot MUST list every export; a rename, removal or semantic change is a
breaking ABI change and requires a coordinated site/wallet migration.

#### Scenario: crypto appears in the adapter

- GIVEN a WASM change adds a hash or encoder inside `crates/rotor-wasm`
- WHEN the architecture gate runs
- THEN the change fails
- AND the implementation moves to `rotor-core`

#### Scenario: ABI drift

- GIVEN a change renames an exported function or changes its result semantics
- WHEN the ABI snapshot test runs
- THEN it fails until the snapshot is updated and the site/wallet migration is
  included in the change

#### Scenario: output parity

- GIVEN the P0 golden vectors
- WHEN the rebuilt WASM artifact is exercised
- THEN every export returns a byte-identical result blob and error buffer
- AND the artifact does not exceed the baseline size budget without an explicit
  decision

### Requirement: Product independence

A product MUST NOT import another product's source. The dependency direction MUST
be:

- `rotor-wasm` -> `rotor-core`;
- `rotor-search` -> `rotor-core`;
- `rotor-desktop` -> `rotor-core`, `rotor-search`, `rotor-pool-protocol`;
- `rotor-site` -> `rotor-core`, `rotor-search`, `rotor-pool-protocol`;
- `wallet` -> `rotor-core`.

`rotor-site` MUST NOT depend on `rotor-desktop` source. `rotor-desktop` MUST NOT
depend on the pool server's state module. A shared type needed by both MUST live
in `rotor-core`, `rotor-search` or `rotor-pool-protocol`.

#### Scenario: the pool server needs chunk math

- GIVEN the pool server needs `Split`, `SplitMix64` or a table manifest
- WHEN the dependency is added
- THEN it comes from `rotor-search` or `rotor-pool-protocol`
- AND the server does not import `engine`, `cli` or `bsgs` from the desktop

#### Scenario: the desktop pool client needs a protocol type

- GIVEN the desktop client needs a lease or job shape
- WHEN the type is defined
- THEN it lives in `rotor-pool-protocol`
- AND the client does not import `coordinator::state`

### Requirement: Pool and API contracts are versioned

Every pool request/response and every site API family MUST have a schema, an
example and a version. A breaking change (removed or renamed field, changed type
or status, changed unit or semantic) MUST bump the major version and the path
(`/api/v2`) and MUST provide a dual-serve window of at least one product release.

Adding an optional field is a minor change and MUST NOT require the field from
an old client. Error text matched by a client is part of the contract and MUST
NOT change silently.

#### Scenario: a breaking protocol change

- GIVEN a field is renamed in a lease response
- WHEN the change is proposed
- THEN a `v2` schema and path are added, the `v1` path serves both versions for
  the window, and the compatibility matrix records the transition
- AND the old client continues to pass the e2e suite during the window

#### Scenario: an additive field

- GIVEN a new optional field is added to a result response
- WHEN an old client receives it
- THEN the client ignores it and the response remains valid against `v1`

### Requirement: Compatibility matrix and cross-product e2e

Every product release MUST appear in `compatibility.json` with the
`rotor-core`, protocol, WASM ABI and data-schema versions it builds against. A
release whose row is missing MUST fail the release gate.

The cross-product e2e suite MUST prove: desktop to pool server, browser worker
to pool server, core to WASM, wallet to core, and the previous-major client
against the current server during a dual-serve window.

#### Scenario: unpinned release

- GIVEN a product release build
- WHEN its versions are absent from `compatibility.json`
- THEN `check-compat` fails and the release is blocked

#### Scenario: protocol skew

- GIVEN a desktop client pinned to protocol `v1`
- WHEN it runs against a server serving `v1` and `v2`
- THEN the e2e suite passes; when the server drops `v1`, the client fails loudly
  with a typed version error

### Requirement: Shared data has one source

Chain identity and public endpoints MUST have one machine source
(`data/chains.json` and `data/providers.json`) and one generator. After a
repository split, generated Rust and JavaScript outputs MUST be published by the
shared repository with a digest, and consumers MUST fail when the digest does
not match their lock.

#### Scenario: generated output drifts

- GIVEN a consumer builds against a generated chain table
- WHEN the table digest differs from the lock
- THEN the build fails and names the expected and actual digests

### Requirement: Repository splits are gated

A product MUST move to its own repository only when at least one split trigger
holds: an independent release cadence, an access boundary, or a CI cost that
cannot be paid in the monorepo. A split MUST pin the shared SDK by exact version
and MUST add the compatibility row and the cross-product e2e.

#### Scenario: split without a trigger

- GIVEN no release, access or CI trigger holds
- WHEN a split is proposed
- THEN a directory split with the same contracts is preferred and recorded as
  the decision
