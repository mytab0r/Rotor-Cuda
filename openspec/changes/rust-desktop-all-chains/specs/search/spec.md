# search delta: Rust-only desktop, all chains

## ADDED Requirements

### Requirement: chain descriptor coverage
The desktop binary MUST accept every chain slug exposed by the site:
`bitcoin`, `ethereum`, `bnb`, `arbitrum`, `optimism`, `base`, `polygon`,
`avalanche`, `zksync`, `solana`, `tron`, `xrp`, `litecoin`, `bitcoin-cash`,
`dogecoin`, `zcash`, `sui`, `ton`. `--coin` remains a deprecated alias.
`--list-chains` MUST print slug, family, curve and supported modes.

#### Scenario: unknown chain
- GIVEN `--chain dogecoin` and an addresses target
- WHEN the CLI parses
- THEN it derives the Dogecoin P2PKH encoding and rejects a Bitcoin-only option

### Requirement: family semantics
secp-hash160 chains MUST share one search primitive and differ only in display
encoding. EVM and TRON MUST share the keccak target. Ed25519 chains MUST search
32-byte seed ranges and MUST NOT offer xpoint or BSGS. TON MUST derive the
v4R2 address hash from the ed25519 key. Unsupported combinations MUST fail with
a non-zero exit code, never fall back to another backend.

#### Scenario: ed25519 wrong mode
- GIVEN `--chain solana --mode xpoint`
- WHEN the CLI parses
- THEN it exits non-zero and names the unsupported combination

### Requirement: Rust-only build
A release build MUST NOT require a C/C++ compiler, `nvcc`, the CUDA toolkit or
a `.cu`/`.h` kernel source. GPU acceleration, when enabled, MUST use a Rust
source kernel or an explicitly gated temporary CUDA backend documented as a
blocker, never a silent mixed build.

#### Scenario: clean machine
- GIVEN a machine with Rust and no CUDA toolkit
- WHEN `cargo build --release` runs
- THEN it succeeds and `--version` reports the build without CUDA

### Requirement: fixture parity
For every chain, the desktop encoder MUST produce the same address and
`Found.txt` secret format as the site's `derive_report` for the same key/seed.
CPU and GPU MUST find the same fixture, and a mismatch MUST fail CI.

#### Scenario: key 1 across chains
- GIVEN key 1 and the site fixtures for all supported chains
- WHEN the desktop fixture test runs
- THEN every derived address matches the site output byte-for-byte

### Requirement: coordinator chain
Job, lease, result and proof payloads MUST carry a chain identifier when the
protocol version is current. Legacy jobs without one MUST be treated as
`bitcoin`; unknown chains MUST be rejected. A worker MUST NOT receive a job
family it does not advertise.

#### Scenario: wrong worker
- GIVEN a secp-only worker and a Solana job
- WHEN the scheduler leases
- THEN the worker is skipped and the job remains for a capable worker
