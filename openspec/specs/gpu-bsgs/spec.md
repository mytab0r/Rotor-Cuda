# GPU BSGS specification

## Contract

`--mode bsgs -g --gpui 0` selects one explicit CUDA BSGS backend. It accepts a public target and an inclusive scalar interval. It returns a key only after exact elliptic-curve re-verification.

GPU failure, invalid device, no device, allocation/copy/launch failure, or truncated output returns an error. No silent CPU fallback. Multi-GPU scheduling is out of scope.

## Search model

Build baby points for `j*G`, fold canonical X for fast rejection, retain exact verification data, and walk giant points from `target - kStart*G` by `S=m*G`. For giant index `i`, candidate scalar is `kStart + i*m + j` where the exact point equation succeeds.

GPU output uses little-endian limbs. Host reconstructs canonical X through the existing `Secp256K1::GetXBytes` path before folding. GPU arithmetic reuses `GPU/GPUMath.h`.

## Bounded output

Host divides giant work into bounded batches. Kernel walk and step coordinates remain `uint32_t`; host `batchBase` carries the global giant index. Tail points beyond the requested giant count are ignored. A batch's true output count must not exceed capacity.

## Boundary semantics

Affine subtraction must handle:

- infinity minus `S` as `-S`;
- `A == S` as infinity;
- `A == -S` as doubling `2A`;
- zero denominator without calling `_ModInv(0)`.

Infinity has no canonical X. Device output carries an explicit marker; host converts only in-range markers to `kStart + i*m`.

## Acceptance

- CPU regression passes;
- clean CUDA build passes for `sm_120`;
- device smoke compares GPU points with GMP/reference points;
- boundary fixtures cover equality, opposite point, infinity, and tail clipping;
- launcher/truncation tests prove fail-loud behavior;
- README and operational docs match behavior.

## Deferred

Collision buckets/full-X table keys, checked wide-`Int` range arithmetic, GLV/endomorphism, persistent kernels, SOTA kangaroo constants, and multi-GPU scheduling require separate evidence-backed changes.
