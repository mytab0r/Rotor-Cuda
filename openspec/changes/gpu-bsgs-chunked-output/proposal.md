# Chunked GPU-BSGS giant output

## Goal

Remove the current `uint32_t maxHits` ceiling from exhaustive GPU-BSGS CLI recovery. Preserve exact coverage, canonical-X folding, device selection, and fail-loud behavior.

## Current ceiling

`solve_gpu()` allocates one exhaustive `DpResult` for all giant points and passes `(uint32_t)emittedPoints` as `maxHits`. Ranges requiring more than `UINT32_MAX` emitted points cannot run safely; current behavior returns an error before launch or on truncation.

## Minimal design

Add a bounded chunk launcher call in `solve_gpu()`:

1. Keep one shared baby table for entire solve.
2. Partition giant indices into batches with `nWalks * nSteps <= maxHits` and `nWalks * nSteps <= UINT32_MAX`.
3. Build only batch start points on host.
4. Call existing `launch_giant_dp()` once per batch with `dpBits=0` and `maxHits=batchPoints`.
5. Process each hit immediately through existing fold/filter/map/exact-EC verification path.
6. Return on exact match; otherwise continue next batch.
7. Treat launcher failure or truncation as hard error. No CPU fallback.
8. Preserve host infinity handling at each batch boundary.

## Deliberate ceiling

The launcher still uses 32-bit walk/step coordinates. Larger ranges are covered by repeated batches, not wider kernel indices. Multi-GPU scheduling remains out of scope.

## Verification

- Existing CPU self-test unchanged.
- Existing GPU self-test fixtures pass.
- Add a GPU fixture whose giant point count exceeds one small test batch via an internal test-only batch limit, or expose a constant test override without changing CLI behavior.
- Verify malformed key and no-device errors remain nonzero.
