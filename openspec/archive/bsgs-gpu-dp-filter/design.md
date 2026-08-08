# Design: GPU BSGS on-device distinguished-point (DP) filter

## Canonicalization before the DP test
The device walk keeps X in VanitySearch quasi-reduced form: congruent to the
true X mod P but possibly `>= P` (never `>= 2P`, since X < 2^256 < 2P). A
distinguished-point test on the low bits must run on the *canonical* least
residue, or the same EC point would be judged distinguished or not depending
on its representation.

secp256k1 P = 2^256 - 2^32 - 977, so the top three 64-bit limbs of P are all
`0xFFFFFFFFFFFFFFFF` and limb0 is `0xFFFFFFFEFFFFFC2F`. Therefore
`X >= P  iff  x[3]==x[2]==x[1]==0xFFFF...FF && x[0] >= 0xFFFFFFFEFFFFFC2F`.
`canonicalize_X` does exactly one conditional `SubP` (the 5-limb subtract macro
already in GPUMath.h) when that holds — at most one subtract, no loop.

## DP test
`is_distinguished(x, dpBits)`: `dpBits==0` → always true (emit all, parity with
the plain walk). Otherwise mask the low `dpBits` bits of the canonical limb0
and require zero. dpBits ≤ 64 so only limb0 is involved; the launcher rejects
dpBits > 64.

## Emission: atomic cursor + true total
Distinguished points are rare and their positions are data-dependent, so a
fixed per-(walk,step) slot (as in the plain kernel) does not fit. Each hit does
`slot = atomicAdd(outCount, 1)` and writes to SoA arrays `outWalk/outStep/outX/
outParity` only when `slot < maxHits`. After the launch, `outCount` is the TRUE
number of DPs found. Host sets `truncated = total > maxHits` and copies back
`min(total, maxHits)` hits. This keeps `total` honest even when the caller
under-sizes the buffer — the count is never silently capped.

## Output shape
`DpResult { vector<DpHit> hits; uint64_t total; bool truncated; }`, `DpHit {
walk, step, x[4] (canonical), parity }`. Unlike the raw quasi-reduced
launchers, DP hits carry canonical X — that is the whole point (an external
matcher can compare bytes directly, no mod P needed).

## Why this reuses the batch walk unchanged
The DP kernel calls the same `point_sub_S_batch` per step; only the store is
replaced by the canonicalize+test+maybe-emit. So the batch-inversion win is
preserved and the removed per-point store is pure gain — which is why DP beats
plain batch by up to x2.06 in the memory-bound micro-benchmark.

## Field representation caveat (carried over)
Y parity is derived from the quasi-reduced Y (y vs y+P flips it because P is
odd), so parity is informational, not a match key. Verdicts use canonical X.

## W bound / TU
`RC_BSGS_MAXW = 8` unchanged. Device code stays in the single BsgsGpu.cu TU
(unity-included into GPUEngine.cu) to avoid the LNK2005 duplicate-symbol issue
from GPUMath.h's external-linkage `__device__` helpers.

## Trade-offs
- SoA hit arrays sized to `maxHits`; a `maxHits` of 0 is clamped to 1 so
  cudaMalloc never gets 0 bytes. Truncation is reported, never hidden.
- No dedup across walks — the same EC point reached by two walks would be two
  hits. Out of scope until there is a real consumer that cares.
