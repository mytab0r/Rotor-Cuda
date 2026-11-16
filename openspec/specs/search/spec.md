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
resume without skipping keys: the checkpoint carries per-worker counts (an extension
after the C++ lines) and each range chunk resumes from its own offset; a checkpoint
without the extension falls back to the C++ `count / threads` model.
`Rotor-Cuda_START.bat` MUST be written when no checkpoint exists. Random mode (`-r`)
MUST NOT resume from checkpoints.

## Rust GPU backend (`--features gpu`)

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

### Requirement: CUDA compilation gate
CI MUST compile the CUDA translation units and the Rust wrapper (`cargo build
--features gpu`) on a Windows runner with the CUDA Toolkit installed; the default
build MUST NOT require CUDA.

## Coordinator (`rotor-coord`, 2026-11-16)

### Requirement: token authentication
Every `/api/v1/*` request MUST present `Authorization: Bearer <token>` compared in
constant time; a missing or wrong token MUST get 401. `GET /` MAY serve the dashboard
without a token. The coordinator MUST refuse to start with an empty token.

#### Scenario: missing token
- GIVEN a running coordinator and no Authorization header
- WHEN a client calls `GET /api/v1/status`
- THEN the response is 401 and contains `unauthorized`

### Requirement: lease and TTL semantics
`POST /api/v1/lease` MUST hand out only chunks that are not done and not covered by a
live lease, and MUST answer 204 when the matching job is found/done or every chunk is
leased. A lease MUST expire after the job's `lease_ttl`; an expired lease MUST be
reclaimable without an explicit release. A heartbeat from a non-owner or after expiry
MUST fail with 409.

#### Scenario: disjoint leases
- GIVEN one job tiled into N chunks
- WHEN N clients lease concurrently
- THEN each receives a distinct chunk and further leases answer 204 while all are held

#### Scenario: expired lease is reclaimed
- GIVEN a lease whose TTL has elapsed
- WHEN another client leases
- THEN it may receive the same chunk

### Requirement: verified results and durable state
`POST /api/v1/result` MUST verify the submitted scalar with `k*G == target` (or the
target address/hash) before accepting; an invalid proof MUST be rejected with 400 and
MUST NOT mark the job found. An accepted result marks the job found/done and drops its
leases. Jobs, chunks, leases, results and BSGS checkpoints MUST persist in one JSON
file rewritten atomically (`tmp` + rename) and MUST reload on restart.

#### Scenario: invalid proof
- GIVEN a job for a known public key
- WHEN a client submits a different scalar
- THEN the request fails with `invalid proof` and the job stays unfound

#### Scenario: restart
- GIVEN a coordinator that granted a lease and stopped
- WHEN it is restarted on the same state file
- THEN the job and the live lease are visible and the leased chunk is not re-handed out

### Requirement: request hardening
The coordinator MUST cap request bodies at 1 MiB (413 beyond it) and concurrent
request handlers at a fixed small number (503 beyond it) without new dependencies.
An API request with a missing or wrong token MUST still get 401 rather than 503.

#### Scenario: oversized body
- GIVEN an authenticated request body larger than 1 MiB
- WHEN it is posted
- THEN the coordinator answers 413 and does not parse it

## Benchmark command

### Requirement: synthetic-rate measurement
`--benchmark` MUST measure the selected backend (CPU or GPU) for the requested
duration on a synthetic, guaranteed-miss range and report `backend`, `threads`,
wall-clock `seconds`, `scanned` and `keys_per_second = scanned / seconds`, in human
text or as one JSON object with `--benchmark-json`. Multi-target, BSGS, work-file and
coordinator configurations MUST be rejected before scanning.

#### Scenario: early range exhaustion
- GIVEN a backend that exhausts the synthetic range before the requested duration
- WHEN the benchmark runs
- THEN `seconds` is the actual scan wall clock and the reported rate is not diluted by
  the remaining timer

#### Scenario: JSON purity
- GIVEN `--benchmark-json`
- WHEN the benchmark runs
- THEN stdout contains exactly one JSON object and no banner or progress lines

## BSGS work files (`--bsgs-work`)

### Requirement: work-file identity
A BSGS work file MUST identify table format, curve, baby size, range and table
checksum, and MUST be written atomically. Loading MUST validate length, header
offsets, digest/checksum and identity; a mismatched or foreign work file MUST be
rejected with the offending field named instead of being reused.

#### Scenario: foreign table
- GIVEN a work file whose table checksum differs from the rebuilt table
- WHEN the job resumes
- THEN it fails loudly and does not overwrite the file

#### Scenario: resume
- GIVEN a valid work file at giant index i
- WHEN the same job restarts
- THEN the walk resumes at i without repeating completed steps

### Requirement: coordinator BSGS progress
A BSGS job's stored `giant_index` MUST be monotonic and MUST NOT exceed the job's
last giant step (`span / baby_size + 1`); an oversized index MUST be rejected rather
than marking the job done. A resume index at the last giant step marks the job done.

#### Scenario: oversized index
- GIVEN a BSGS job and an authenticated client
- WHEN it posts a `giant_index` past the last giant step
- THEN the request is rejected and the job is not marked done

## GPU coordinator clients

### Requirement: host chunk loop
A GPU `--coordinator` client MUST lease one chunk at a time and scan it with the
device engine, heartbeating between chunks and at the end of each chunk. The engine
and table MUST be created once and reused across leases. A heartbeat lost because the
job is already found/done MUST stop the client normally; a lost lease on a still-active
job MUST abort.

#### Scenario: lease lost after another client finishes
- GIVEN a GPU client scanning a chunk while another client submits the found key
- WHEN the GPU client's next heartbeat fails with `lease lost`
- THEN the client stops normally and reports no error

#### Scenario: synchronous scan limit
- GIVEN a chunk wider than `lease_ttl × device rate`
- WHEN the GPU client scans it
- THEN it cannot refresh the lease mid-scan, so the chunk may be re-leased and rescanned

### Requirement: device verification policy
On a GPU build, coordinator address/xpoint hits MUST be re-verified by the host
(`k*G` against the target) before submission, and kernel candidates that fail MUST be
discarded. `-m bsgs -g --coordinator` MUST be rejected because coordinator BSGS uses
the CPU path.

#### Scenario: false positive from the device
- GIVEN a device candidate that is not the exact target
- WHEN the host processes the hit
- THEN nothing is submitted and the scan continues

## Self-update

### Requirement: checksum-verified self-update
The Windows binary MUST support `--check-update` and `--update`, downloading the
release asset for its build variant (`rotor.exe`, or `rotor-gpu.exe` with the
`gpu` feature) together with its `.sha256`, and MUST verify the checksum before
replacing the running executable. The C++ `Rotor-Cuda.exe` asset MUST NOT be used.

#### Scenario: checksum mismatch
- GIVEN a release asset whose downloaded bytes do not match the published sha256
- WHEN `--update` runs
- THEN the process exits non-zero, the current executable is left untouched, and
  no `.new` file remains.

#### Scenario: unsupported platform
- GIVEN a non-Windows build
- WHEN `--check-update` or `--update` is passed
- THEN the process reports that self-update is not supported and exits non-zero.

## Text target lists

### Requirement: text target input
Multi-target modes MUST accept `--targets-text FILE` (or `-` for stdin) with one
BTC/ETH address or 64-hex xpoint per line, skip blank lines and `#` comments,
and fail with the 1-based line number on a malformed line. It MUST be mutually
exclusive with `-i`, and CPU and GPU paths MUST share the same decoding.

#### Scenario: malformed line
- GIVEN a text list whose third line is not a valid target
- WHEN the run starts
- THEN it exits non-zero with an error naming line 3.

#### Scenario: stdin
- GIVEN a target list piped to stdin with `--targets-text -`
- WHEN the multi-target search runs
- THEN it finds the same keys as the equivalent `.bin` input.
