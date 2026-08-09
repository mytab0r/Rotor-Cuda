# Proposal: Rotor-Cuda CPU/GPU search fusion

## Why
Rotor-Cuda has CUDA brute/xpoint search but no BSGS mode. Existing GPU-BSGS reference is Collider/Etayson (PureBasic), while existing C++ projects provide CPU BSGS and filter variants. This change defines a cloud-built C++/CUDA path without requiring local toolchains.

## Scope
- Keep current Rotor address/xpoint CPU and GPU modes.
- Add CPU BSGS as a distinct mode with resumable sequential work.
- Add GPU BSGS as a distinct CUDA backend using Rotor secp256k1 math.
- Keep Bloom compatibility; add binary-fuse/xor filter as an explicit alternative only after format tests.
- Build Windows artifacts and releases in GitHub Actions.
- Store independent filter/table sets by coin, bit width, and range without overwrite.

## Out of scope
- Random-mode recovery until its state/table invariant is specified and tested.
- GPU validation on hosted runners; requires an NVIDIA self-hosted runner.
- Breaking existing Bloom files is acceptable for first prototype, but no silent reuse of incompatible formats.
