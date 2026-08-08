# Proposal: GPU BSGS on-device distinguished-point (DP) filter

## Why
The batch giant-step kernel (`launch_giant_batch`) still stores every point it
computes. In the micro-benchmark that store is the dominant cost — the kernel
is memory-bound, which is exactly why batch inversion only showed up to x1.44
there. A real BSGS baby-table match / DP-kangaroo never needs every point: it
needs only the *distinguished* ones (points whose canonical X has `dpBits`
low bits zero). Filtering on-device removes the per-point store for the
overwhelming majority of steps and leaves only the rare hits to copy back.

## What
- Add `bsgs_giant_kernel_dp` + `launch_giant_dp` on top of the existing batch
  walk. Same batch-inversion math (`point_sub_S_batch`), same W in 1..8.
- A point is emitted only when its **canonical** (least-residue) X has the low
  `dpBits` bits zero. `dpBits == 0` emits every point (parity with the plain
  walk). Device X is VanitySearch quasi-reduced, so the kernel canonicalizes
  with a single conditional subtract of P before the low-bit test — DP
  semantics then match any external least-residue consumer.
- Hits go to SoA output arrays via an atomic cursor; `DpResult.total` is the
  TRUE count of distinguished points (may exceed `maxHits` → `truncated`, host
  keeps the first `maxHits`).
- Keep `launch_giant` and `launch_giant_batch` untouched. This is additive and
  opt-in. No CLI change — GPU BSGS is still not user-exposed.

## Out of scope
- Wiring GPU BSGS into the CLI backend selector.
- Matching hits against a real baby-table / target set (a DP *consumer*; this
  change only produces DPs).
- Multi-GPU.

## Evidence
Correctness + completeness: RTX 5070 (sm_120), `bsgs/gpu_smoke_dp.cu` vs GMP
double-and-add ground truth. Every stored hit's canonical X matches, every hit
is genuinely distinguished, and the device DP `total` equals a brute-force GMP
DP count — verified for dpBits ∈ {0, 8, 12, 16}, W ∈ {1, 4, 8}, plus the
truncation path (total=4096, maxHits=100). Perf: DP is **x2.06 vs batch /
x2.97 vs scalar** at 131072×8 W=8, and **x1.77 vs batch / x2.25 vs scalar** on
a long 16384×256 W=4 walk with real hits. See `bsgs/DP_FILTER.md`.
