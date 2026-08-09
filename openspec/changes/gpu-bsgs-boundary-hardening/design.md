# Design

## Device representation

Keep `(0,0)` as transient infinity only inside the affine walk. Track `bool infinity[W]` per logical lane. Do not canonicalize infinity as an ordinary point.

## Transition rules

- infinity minus `S` returns `-S` and clears infinity;
- finite `A` with `A.x != S.x` uses regular affine subtraction;
- `A == S` sets infinity and avoids inversion;
- `A.x == S.x` with different Y is the opposite-point case and returns doubling;
- doubling with `Ay == 0` returns infinity.

Batch inversion uses its fast path only when all lanes are finite and non-singular. Any singular lane falls back to safe per-lane handling for that step.

## Output

DP output includes `outInfinity`. Infinity emits a marker with zero X and parity zero. Host checks the marker before canonical-X reconstruction and returns only if its global index is within `giantPoints`.

## Validation

Compile with clean `sm_120` build. Run CPU regression. Run real RTX 5070 smoke against a GMP/reference implementation for normal points and explicit boundary fixtures. Verify tail clipping and fail-loud truncation.
