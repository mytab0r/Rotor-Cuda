# Design: chunked GPU-BSGS giant output

## API

Keep `launch_giant_dp()` ABI unchanged. Change only host orchestration in `solve_gpu()` so existing CUDA kernel, CI compile, and smoke callers remain stable.

## Batch shape

Use fixed `nSteps = 1024` and cap each launch at a safe `kMaxBatchPoints` below `UINT32_MAX`. For each `batchBase`:

- `batchPoints = min(remaining, kMaxBatchPoints)`;
- `batchWalks = ceil(batchPoints / nSteps)`;
- host builds `batchWalks` starts from `Q - batchBase*S*nSteps`;
- launcher emits `batchWalks*nSteps`; host rejects indices at or beyond `giantPoints`;
- next batch starts after `batchWalks*nSteps`, preserving complete coverage without overlap.

`kMaxBatchPoints` is an implementation constant, not CLI configuration. It leaves headroom for vector sizing and keeps all launcher counts representable as `uint32_t`.

## Processing

Extract current per-hit logic into one local helper or keep it as a loop in the batch loop, whichever yields the shorter diff. Fold GPU canonical X through `Secp256K1::GetXBytes`, then binary-fuse reject, exact map lookup, range check, and `k*G == target` reverify. Return immediately on match.

## Errors

Set `BsgsResult.error` on launcher failure or truncation. Do not fall back to CPU. Preserve explicit no-device and invalid-device errors from launcher.

## Infinity

Check every batch start for infinity before copying affine coordinates. Resolve the exact boundary scalar on host when it is in range. An infinity inside a walk is already a giant-boundary point and is represented by the next batch only when its index is a batch start; with `nSteps` fixed, handle only starts as current implementation and retain the existing finite-affine limitation comment unless tests demonstrate another boundary.

## Test strategy

Use existing RTX 5070 self-test as regression gate. Add a compile-time test-only batch cap only if needed to force multiple launches without huge EC work; avoid exposing production knobs. CPU-only builds must remain unchanged.
