# Research backlog

Research stays separate from production behavior until reproducible correctness and performance evidence exists. Scope remains authorized public puzzle events only.

## Priority A — correctness and coverage

- [ ] Replace one-value `fold32 -> j` baby map with collision buckets or canonical full-X keys; prove no fold collision false-negative.
- [ ] Replace low-64-bit `span` assumptions with checked `Int` arithmetic; reject unsupported wide ranges loudly.
- [ ] Add overflow checks for `m*2`, `i*m`, `covered*m`, and `strideStep`.
- [ ] Make self-tests independent of `NDEBUG` or add explicit return-code checks.
- [ ] Add boundary device fixtures: `A == S`, `A == -S`, infinity, infinity marker, tail clipping.
- [ ] Add crash-safe test for truncation and launcher failure.

## Priority B — range scheduling and resumability

- [ ] Define interval identity as `(target, start, end, algorithm, backend, table-manifest-version)`.
- [ ] Use append-only journal plus periodic compact snapshot; fsync before marking interval complete.
- [ ] Store `planned`, `running`, `completed`, `failed`, and `unknown-after-crash` states. Never mark a crashed interval complete.
- [ ] Merge completed intervals with canonical half-open `[start,end)` union; test overlap, adjacency, gaps, and restart recovery.
- [ ] Select random work from uncovered intervals, weighted by remaining size; use deterministic seed and per-run nonce for reproducibility.
- [ ] Avoid replacement by sampling an interval ID/offset from uncovered measure, not by repeatedly guessing random starts.
- [ ] Keep scheduler outside GPU kernel. GPU receives bounded immutable work units.
- [ ] Add progress report: covered keys, uncovered keys, percentage, rate, ETA, last checkpoint, journal generation.
- [ ] Define multi-process lock policy before enabling concurrent workers.

Recommended minimum design: SQLite is not required for first version. A small append-only JSONL journal plus atomic snapshot is enough for one local worker; upgrade to SQLite when multiple workers or query/report load justifies it.

## Priority C — BSGS variants

- [ ] Compare classic BSGS, multi-baby-table layouts, negation-map BSGS, and bounded-memory table variants.
- [ ] Measure canonical-X full-key storage versus fold filter plus collision buckets.
- [ ] Evaluate GLV endomorphism for secp256k1, including key decomposition, signed scalar handling, table layout, and proof that target/reverify semantics remain exact.
- [ ] Evaluate negation symmetry and parity handling without introducing duplicate or missing candidates.
- [ ] Compare affine, Jacobian, mixed Jacobian-affine, and batch-normalized GPU kernels.
- [ ] Measure batch inversion W=1..8 by range shape, occupancy, register pressure, and boundary frequency.
- [ ] Investigate warp-level scheduling, shared-memory table staging, coalesced SoA output, and register limits.

## Priority D — Pollard kangaroo

- [ ] Keep current classic two-herd baseline as reference.
- [ ] Compare jump-table sizes, distinguished-point density, collision table memory, and restart behavior.
- [ ] Research negation-map kangaroo, automorphism/GLV kangaroo, and parallel collision search.
- [ ] Investigate SOTA constants such as K≈1.15 only after baseline profiler evidence.
- [ ] Evaluate persistent kernels and resumable DP state only with crash/restart tests.
- [ ] Define host collision verification and memory pressure behavior before CLI exposure.

## Priority E — GPU runtime/toolchain

- [ ] Benchmark CUDA 13.x minor updates and newer NVIDIA driver on RTX 5070; record compiler, driver, PTX, SASS, occupancy, and thermal clocks.
- [ ] Compare normal launches with CUDA Graphs for repeated bounded batches.
- [ ] Measure persistent kernels against bounded relaunches; reject if watchdog/restart/debug behavior worsens.
- [ ] Test architecture-specific `sm_120` build and PTX fallback separately.
- [ ] Keep hosted compile CI and self-hosted device smoke as separate gates.

## Priority F — external comparison

Study and cite only as engineering input, not copy-paste authority:

- VanitySearch and JeanLucPons GPU point arithmetic/layouts;
- KeyHunt/BSGS-derived table and search approaches;
- Rotor-Cuda upstream range/random scheduling;
- libsecp256k1 and secp256k1-zkp arithmetic/endomorphism decisions;
- open Pollard kangaroo implementations;
- academic work on discrete logarithm search, distinguished points, GLV, and GPU elliptic-curve arithmetic.

For every adopted idea record: source URL/paper, license compatibility, exact hypothesis, fixture, baseline, measured device/toolchain, and rollback condition.

## Non-goals until explicitly reopened

- mass scanning;
- de-anonymization;
- credential testing;
- silent CPU fallback;
- multi-GPU scheduler;
- persistent DP continuation as part of initial GPU-BSGS integration;
- speculative SOTA algorithm claims without local evidence.
