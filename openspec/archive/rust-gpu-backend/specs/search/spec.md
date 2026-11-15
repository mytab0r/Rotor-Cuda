# Delta: search — Rust GPU backend

## ADDED Requirements

### Requirement: GPU-BSGS in the Rust binary
A build with the `gpu` feature MUST execute BSGS giant steps on the selected CUDA
device and MUST NOT fall back to the CPU on any GPU error.

#### Scenario: CPU/GPU equivalence on a fixture
- GIVEN a fixed secp256k1 scalar, its public key, and a bounded range
- WHEN `--mode bsgs` runs on the CPU and with `-g` on the GPU
- THEN both report the same scalar, or both report not-found

#### Scenario: no device
- GIVEN a `gpu` build with no usable CUDA device
- WHEN `-g` is passed
- THEN the process reports the launcher error and exits non-zero

#### Scenario: truncation
- GIVEN a GPU batch whose emitted points exceed the launcher limit
- WHEN the batch runs
- THEN the process reports an error and exits non-zero; no CPU retry

### Requirement: loud GPU gating
#### Scenario: feature absent
- GIVEN a build without the `gpu` feature
- WHEN `-g` is passed
- THEN the process reports that GPU support is not compiled and exits non-zero

#### Scenario: address mode with GPU
- GIVEN a `gpu` build
- WHEN `-g` is passed with an address/xpoint mode
- THEN the process reports that GPU address search is not implemented in the Rust
  build and exits non-zero; it MUST NOT silently run the CPU engine

### Requirement: CUDA compilation gate
CI MUST compile the CUDA translation units and the Rust wrapper (`cargo build
--features gpu`) on a Windows runner with the CUDA Toolkit installed.
