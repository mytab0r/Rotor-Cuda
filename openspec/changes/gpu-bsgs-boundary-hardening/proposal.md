# GPU BSGS boundary hardening

## Why

The chunked GPU-BSGS path now handles bounded output, but affine giant-step boundary points need explicit semantics. `A == S` must not send zero denominator into `_ModInv`; infinity must cross the device/host boundary without pretending to have canonical X.

## Scope

- Add device infinity state and safe affine transitions.
- Emit an explicit infinity marker.
- Map valid infinity hits to the scalar candidate on host.
- Keep canonical-X folding, exact table lookup, EC re-verification, bounded batches, fail-loud errors, and no fallback unchanged.
- Add boundary device evidence.

Out of scope: GLV, full-X collision buckets, wide-range arithmetic migration, persistent DP continuation, and multi-GPU scheduling.
