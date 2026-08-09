# Proposal: GPU Pollard kangaroo baseline (track B)

## Why
BSGS (tracks A1/A2) trades memory for a bounded giant-step count — great when
the range fits a baby table, but table storage grows with the range. For the
wide interval-ECDLP that Bitcoin-puzzle events actually pose (a known scalar
range, one target pubkey), the SOTA family is Pollard's **kangaroo**: constant
memory, ~expected `K·sqrt(range)` group ops, DP-collision detection. This is a
separate algorithm from BSGS, not an improvement to it — hence a new change.

This is the **baseline** kangaroo (classic 2-herd tame/wild, K≈2.0). The SOTA
K=1.15 method (equivalence classes + negation map, as in RCKangaroo) is a
strictly heavier layer on top and is **out of scope** here — it lands as its
own change once the baseline is verified. Ship the lazy correct version first.

## What
- Add `kangaroo_jump_kernel` + `launch_kangaroo` in the existing
  `bsgs/BsgsGpu.cu` TU (same file as the batch/DP walk — keeps the single-TU
  unity-include layout that avoids the LNK2005 duplicate-symbol issue).
- **Reuse verified primitives, do not reinvent:**
  - point add for the jump step reuses the fork's device EC math in
    `GPU/GPUMath.h` (same primitives `point_sub_S_batch` already leans on);
  - DP detection reuses `canonicalize_X` + `is_distinguished` verbatim from A2;
  - hit emission reuses the A2 atomic-cursor + honest-`total` + `truncated`
    SoA pattern.
- Each thread walks one kangaroo: pseudo-random jump `P += jump[ f(x) ]` where
  `f(x)` = low bits of canonical X select one of `nJumps` precomputed jump
  points (host-precomputed `jump[i] = 2^i · G`), accumulating a scalar distance
  `d += 2^i`. Tame herd starts at `kStart·G` (known distance); wild herd starts
  at `Q = target` (unknown offset). When a tame and a wild kangaroo emit the
  **same** canonical DP X, the host solves `key = (d_tame − d_wild) mod n` and
  EC-reverifies `key·G == target` before ever reporting — a fold/DP collision
  can never yield a wrong key (same guard discipline as the BSGS host probe).
- Output: `KangarooResult { vector<KangHit> hits; uint64_t total; bool
  truncated; }`, `KangHit { kind(tame/wild), dpX[4] canonical, dist[4], parity }`.
  Collision-solve + EC-reverify stay **host-side** (kept out of the kernel: the
  hot path only walks and emits DPs).
- `launch_giant` / `launch_giant_batch` / `launch_giant_dp` untouched. Additive,
  opt-in. **No CLI change** — like BSGS, GPU kangaroo is not user-exposed yet.

## Out of scope
- SOTA K=1.15 (equivalence classes + negation map) — its own later change.
- Wiring kangaroo into the CLI backend selector (a separate integration change).
- Multi-GPU (track A4, explicitly last).
- Checkpoint/resume for kangaroo state (needs a real consumer first).

## Evidence (to be produced on RTX 5070, sm_120)
`bsgs/gpu_smoke_kangaroo.cu` vs a GMP double-and-add ground truth: on a **small
bounded range** (so brute force is tractable) with a known fixture scalar, the
DP-collision solve MUST recover exactly that scalar and pass `key·G == target`.
Plus: DP canonical-X matches GMP, and the honest-`total`/`truncated` path holds
(same three-check discipline as `gpu_smoke_dp.cu`). Perf is secondary for the
baseline — correctness of the collision-solve is the gate. Evidence lands in
`bsgs/KANGAROO.md`.
