# Delta: Rust CPU implementation

## ADDED Requirements

### Requirement: CLI compatibility
The Rust binary MUST accept every option documented in `Main.cpp` usage/`README.md`
with the same meaning, and MUST return C++-compatible exit codes (`0` found/ok,
non-zero error).

#### Scenario: help
- GIVEN no arguments
- WHEN `rotor` runs
- THEN usage text is printed and exit code is `0`

#### Scenario: GPU unavailable
- GIVEN a build without the `gpu` feature
- WHEN `-g` is passed
- THEN the process prints `GPU code not compiled, use -DWITHGPU` and exits non-zero

### Requirement: CPU search parity
For a bounded scalar range and a target address/xpoint, the Rust CPU engine MUST find
the same scalar as the C++ engine and MUST write it to `Found.txt` in the C++ format.

#### Scenario: single address
- GIVEN the README puzzle range and address
- WHEN the Rust engine scans the range
- THEN it finds the documented key and writes one `Found.txt` block

#### Scenario: no false negatives
- GIVEN a member of a loaded `.bin` hash160 set
- WHEN the engine evaluates the set through the filter
- THEN membership never returns false for that member

### Requirement: BSGS parity
CPU-BSGS MUST recover the scalar for a known public key inside `--range`, with the same
canonical hex output as the C++ implementation.

#### Scenario: puzzle fixture
- GIVEN a compressed public key and its bounded range
- WHEN `--mode bsgs` runs
- THEN the recovered key equals the fixture scalar and exit code is `0`

### Requirement: input format compatibility
`.bin` inputs MUST be read as headerless records of 20 bytes (hash160) or 32 bytes
(xpoint); a length that is not a positive multiple of the record size MUST fail loudly.

#### Scenario: wrong size
- GIVEN a `.bin` file of 37 bytes in address mode
- WHEN the file is loaded
- THEN the process exits non-zero with an explicit size error

### Requirement: no silent fallbacks
If the requested backend or target cannot be honored (GPU not compiled, invalid public
key, unsupported mode/coin combination), the process MUST fail with a non-zero exit code
instead of switching backends.
