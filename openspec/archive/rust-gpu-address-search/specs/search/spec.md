# Delta: search — GPU address/xpoint search

## ADDED Requirements

### Requirement: GPU address/xpoint search in the Rust binary
A build with the `gpu` feature MUST execute `-m address|addresses|xpoint|xpoints`
(BTC and ETH) on the selected CUDA device and MUST NOT fall back to the CPU on
any GPU error.

#### Scenario: CPU/GPU equivalence on a fixture
- GIVEN a fixed secp256k1 scalar and its BTC or ETH address inside a bounded range
- WHEN the same search runs on the CPU and with `-g` on the GPU
- THEN both write the same private key block to the output file

#### Scenario: compression modes
- GIVEN a compressed address, an uncompressed address, or `-b`
- WHEN the GPU search runs
- THEN the kernel checks the requested mode(s) and the host emits the matching
  address/WIF

#### Scenario: false positive
- GIVEN a bloom/target candidate that is not an exact target
- WHEN the batch is processed
- THEN the host rejects it and writes nothing

#### Scenario: key outside the thread slice
- GIVEN a kernel group that overruns a short chunk or the range end
- WHEN the hit is processed
- THEN the host discards it; no key outside the requested range is reported

#### Scenario: no device or invalid device
- GIVEN a `gpu` build with no usable CUDA device or an invalid `--gpui` id
- WHEN `-g` is passed
- THEN the process reports the launcher error and exits non-zero

#### Scenario: truncated output
- GIVEN more candidates than the output buffer holds
- WHEN the batch is read back
- THEN the process reports an error and exits non-zero; no silent loss

#### Scenario: unsupported options
- GIVEN `-r`, `-n`, or more than one `--gpui` id
- WHEN `-g` runs an address/xpoint search
- THEN the process rejects the combination before scanning

### Requirement: CUDA compilation gate (address TU)
CI MUST compile `Rotor-Cuda/GPU/GpuAddressAbi.cu` together with the Rust wrapper
(`cargo build --features gpu`) on a Windows runner with the CUDA Toolkit; the
default build MUST NOT require CUDA.

## MODIFIED Requirements

### Requirement: loud GPU gating
#### Scenario: feature absent
- GIVEN a build without the `gpu` feature
- WHEN `-g` is passed
- THEN the process reports that GPU support is not compiled and exits non-zero

#### Scenario: address mode with GPU
- GIVEN a `gpu` build with the CUDA Toolkit
- WHEN `-g` is passed with an address/xpoint mode
- THEN the search runs on the GPU; an unsupported option combination or a
  runtime failure is reported loudly and MUST NOT silently run the CPU engine
