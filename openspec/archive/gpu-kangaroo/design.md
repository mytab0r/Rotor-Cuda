# Design: GPU Pollard kangaroo baseline (track B)

## Algorithm (classic 2-herd, K≈2.0)
Interval-ECDLP: find scalar `k` with `k·G == Q`, `k ∈ [kStart, kStart+range)`.
- **Tame** kangaroos start at a known point `kStart·G` (+ per-thread offset),
  carrying a known accumulated distance `d`.
- **Wild** kangaroos start at the target `Q` (+ per-thread offset), distance `d`
  relative to the unknown `k`.
- Both walk the SAME deterministic jump function, so once a tame and a wild
  kangaroo step onto the same point, they follow identical trails and both hit
  the next distinguished point (DP) together. That DP collision yields
  `kStart + d_tame − d_wild ≡ k (mod n)`.

## Jump function (deterministic, shared by both herds)
`f(P) = canonical_X(P).limb0 & (nJumps−1)` selects one of `nJumps` precomputed
jump points, `jump[i] = 2^i · G` (host-precomputed, `nJumps` a power of two,
default 32). Step: `P += jump[f(P)]`, `d += 2^{f(P)}`. Determinism is on the
**canonical** X (reuse `canonicalize_X` from A2) — a jump chosen on the
quasi-reduced representation would diverge between representations and break the
tame/wild trail-merge invariant. This is the same canonicalization reason DP
needed it, applied one layer earlier.

## Why point ADD, not the batch SUB walk
The BSGS walk is a fixed stride `R -= S`. Kangaroo needs a data-dependent
`P += jump[f(P)]` — a general affine add, not a fixed subtract. So the jump step
uses the fork's affine add primitive from `GPUMath.h` directly. Batch inversion
across a warp is possible (all threads invert one denominator each — the exact
Montgomery-trick shape `point_sub_S_batch` already uses) and is the ponytail
upgrade path, but the baseline does **one `_ModInv` per jump** for a correct,
readable first cut. `// ponytail: one _ModInv per jump; warp batch-invert is
the A1-shaped upgrade, wire when perf matters.`

## DP emission (reused from A2 verbatim)
A jump result is emitted only when `is_distinguished(canonical_X, dpBits)`.
Emission = A2's `atomicAdd(outCount,1)` cursor into SoA arrays, honest `total`,
host `truncated = total > maxHits`. Each hit additionally carries `kind`
(tame/wild) and the 4-limb accumulated `dist`. No new emission machinery.

## Collision solve (host-side, guarded)
Host buckets hits by canonical DP X. For any X hit by both a tame and a wild
kangaroo: `cand = (kStart + d_tame − d_wild) mod n`. **Reverify** `cand·G == Q`
via the existing host SECP path before reporting — identical guard discipline to
the BSGS baby-table probe, so a spurious DP match (or a same-herd collision,
which carries no key) can never surface a wrong key. Same-herd collisions and
non-solving pairs are dropped silently.

## Output shape
`KangHit { uint8_t kind; uint32_t kang; uint64_t dpX[4] (canonical); uint64_t dist[4];
uint8_t parity; }`, `KangarooResult { vector<KangHit> hits; uint64_t total;
bool truncated; }`. `kang` maps each hit to its per-kangaroo start offset for the
host collision solve. Parity stays informational (carried over caveat: derived
from quasi-reduced Y, y vs y+P flips it, P odd). Verdicts use canonical X +
distance, never parity.

## Termination (baseline)
The kernel walks a fixed `nSteps` per launch and returns all DPs; the host
solves across the returned set and re-launches (continuing trails) if no
solving collision yet. Baseline keeps the re-launch loop in the smoke test /
future consumer, not in the kernel — the kernel is a pure bounded DP producer,
mirroring `bsgs_giant_kernel_dp`. `// ponytail: fixed-step producer, host drives
continuation; on-device persistent walk is a later change if launch overhead
dominates.`

## TU / arch
Device code stays in the single `BsgsGpu.cu` TU (unity-included into
`GPUEngine.cu`) — same LNK2005-avoidance as batch/DP. `gpu-bsgs-compile.yml`
already triggers on `BsgsGpu.cu`, so the nvcc compile gate covers the new kernel
with no workflow change; add `gpu_smoke_kangaroo.cu` to the `paths` trigger and
the self-hosted `device-run` script alongside the existing smokes.

## Trade-offs
- Classic K≈2.0, not SOTA K=1.15 — ~1.8× more ops/storage than RCKangaroo.
  Deliberate: correctness of the collision-solve first, SOTA as its own change.
- No dedup of DP trails across launches beyond the host bucket map — fine for a
  bounded smoke; a long-run consumer needs a persistent DP store (out of scope).
- `nJumps` and average jump size `2^{nJumps/2}` are un-tuned constants; leave the
  knob, don't hard-optimize a baseline. `// ponytail: default nJumps=32, tune
  against DP rate when there's a real workload.`
