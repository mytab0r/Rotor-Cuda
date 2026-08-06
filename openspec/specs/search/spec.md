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
