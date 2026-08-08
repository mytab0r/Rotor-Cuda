# Design: GPU BSGS batch modular inversion

## Montgomery's trick over W walks
Per step each walk j needs `1/dx_j` where `dx_j = Sx - Ax_j`. Instead of W
independent inversions:

1. prefix products `pre_0 = dx_0`, `pre_j = pre_{j-1} * dx_j`
2. one inverse of the full product: `inv = 1 / pre_{W-1}`  (single `_ModInv`)
3. unwind: for j = W-1..1, `1/dx_j = pre_{j-1} * inv`; then `inv *= dx_j`;
   finally `1/dx_0 = inv`

Cost: 1 `_ModInv` + 3(W-1) `_ModMult` for W inversions (was W `_ModInv`).

This is exactly the shape GPUMath.h already uses for `_ModInvGrouped` over the
GRP_SIZE batch; here it is applied across walks in a thread rather than across a
generator group.

## Why per-thread W walks (not per-step batching)
A single walk is strictly sequential: `R_{i+1} = R_i - S` depends on `R_i`, so
its steps cannot be batch-inverted. Independent walks sharing S can. Folding W
walks into one thread turns W sequential inverse chains into one batched
inverse per step.

## Output layout (unchanged)
Point (walk, step) is written at index `walk*nSteps + step`, identical to
`launch_giant`. gpu_smoke / any verifier consumes both kernels the same way.

## Field representation caveat (carried over)
Device X is VanitySearch quasi-reduced: congruent mod P but not the least
residue. Verifiers compare X mod P; Y parity is informational (y vs y+P flips
it because P is odd). Documented in gpu_smoke and BATCH_INVERT.md.

## W bound
`RC_BSGS_MAXW = 8` caps per-thread register arrays (W*[4] x several temps).
Larger W raises register pressure and lowers occupancy; measured sweet spot is
W=4. Launcher rejects W==0 or W>8.

## Trade-offs
- Win is conditional: at low parallelism occupancy drops (nWalks/W threads) and
  the bench is memory-bound (stores every point), so batch can be slower there.
  The real payoff is when combined with on-device filtering that removes the
  per-point store — batch keeps the arithmetic cheap regardless.
- Extra device code lives in the same translation unit (unity include into
  GPUEngine.cu) to avoid the LNK2005 duplicate-symbol issue the fork hit before.
