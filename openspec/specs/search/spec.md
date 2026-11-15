# Search domain

## Existing behavior
Rotor-Cuda searches address/hash and xpoint targets over a configured scalar range using CPU and CUDA brute-force backends.

## Planned BSGS behavior
The BSGS mode is an explicit backend. It must report `CPU-BSGS` or `GPU-BSGS`; it must not silently combine backends in one job.

### Scenario: deterministic fixture
- GIVEN a fixed secp256k1 scalar fixture, its target public key, and a bounded canonical scalar range
- WHEN CPU-BSGS runs sequentially
- THEN it finds the fixture scalar, returns exit code 0, and emits the same canonical scalar encoding on repeat

### Scenario: CPU/GPU equivalence
- GIVEN the same table manifest and deterministic fixture
- WHEN CPU-BSGS and GPU-BSGS run with equivalent bounds
- THEN both return the same scalar; GPU evidence requires an NVIDIA self-hosted runner

### Scenario: checkpoint mismatch
- GIVEN a checkpoint whose table, filter, range, or format checksum differs from the requested job
- WHEN the job resumes
- THEN it refuses resume with non-zero exit code and does not mutate the checkpoint

### Scenario: sequential restart
- GIVEN a valid checkpoint written atomically after a completed giant-step batch
- WHEN the same job restarts
- THEN it resumes at the recorded next position without skipping or repeating a completed batch

### Scenario: random mode
- GIVEN random BSGS mode
- WHEN no tested random-state/table restoration exists
- THEN CLI marks it non-resumable or rejects checkpoint resume; it must not claim safe recovery

## Requirements

### Requirement: explicit BSGS backend selection
The executable MUST expose BSGS as an explicit mode and MUST distinguish CPU and CUDA execution in startup and periodic statistics. Existing address/xpoint modes MUST remain selectable.

### Requirement: sequential recovery
Sequential BSGS MUST persist a checkpoint that identifies table/filter/range and current position. Restart MUST reject a mismatched or corrupted checkpoint instead of silently continuing.

### Requirement: random recovery safety
Random BSGS MUST NOT claim resumability until table identity and random-state restoration are tested. Until then, CLI MUST either disable random recovery or clearly mark it non-resumable.

## Rust CPU implementation (v2, 2026-11-15)

The CPU search engine, address/xpoint/ETH modes, CPU-BSGS and checkpoint files are
implemented in the Rust crate at the repository root (`cargo build --release`).
The CUDA kernels remain in `Rotor-Cuda/` and are not part of this requirement set.

### Requirement: CLI compatibility
The Rust binary MUST accept every option documented in `Main.cpp` usage with the same
meaning and C++-compatible exit codes (0 for success/found, non-zero for errors).

#### Scenario: GPU unavailable
- GIVEN a build without the GPU feature
- WHEN `-g` is passed
- THEN the process reports that GPU code is not compiled and exits non-zero
  (deliberate deviation from the C++ no-op).

### Requirement: CPU search parity
For a bounded scalar range and a target address/xpoint/ETH hash, the Rust CPU engine
MUST find the same scalar as the C++ engine and MUST write a `Found.txt` block of the
same shape (`PubAddress`, `Priv (WIF)` for BTC, `Priv (HEX)`, `PubK (HEX)`, 86-`=`
separator), and it MUST NOT report a member of a loaded `.bin` set as absent.

### Requirement: BSGS parity
CPU-BSGS MUST recover the scalar for a known public key inside `--range`, with the
same canonical uppercase hex output as C++, and MUST re-verify every candidate with
`k*G == target` so a fold collision cannot yield a wrong key.

### Requirement: input format compatibility
`.bin` inputs MUST be read as headerless records of 20 bytes (hash160/keccak) or
32 bytes (xpoint); a length that is not a positive multiple of the record size MUST
fail loudly. Records are sorted internally (the C++ binary requires a pre-sorted file).

### Requirement: no silent fallbacks
If the requested backend or target cannot be honored (GPU not compiled, invalid public
key, unsupported mode/coin pair, malformed range or file), the process MUST fail with
a non-zero exit code instead of switching backends.

### Requirement: checkpoint compatibility
Sequential runs with `-n` MUST write `Rotor-Cuda_Continue.bat` in the C++ layout and
resume by shifting the start by the stored count; `Rotor-Cuda_START.bat` MUST be
written when no checkpoint exists. Random mode (`-r`) MUST NOT resume from checkpoints.
