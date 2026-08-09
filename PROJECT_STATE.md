# Project state

## Repository

- Git root: `/home/test/Rotor-Cuda`
- Source tree: `/home/test/Rotor-Cuda/Rotor-Cuda`
- GitHub remote: `https://github.com/mytab0r/Rotor-Cuda.git`
- Working branch: `ci/security-gates`
- Last committed base: `d936b071c16be7711232dcf050491d7985d31491` (`feat: chunk GPU BSGS output`)
- Host working directory `D:\magic\Documents\VSCode\Python\New` is not repository. Do not commit or push there.

## Current source changes

Boundary hardening is uncommitted in:

- `Rotor-Cuda/bsgs/BsgsCpu.cpp`
- `Rotor-Cuda/bsgs/BsgsGpu.cu`
- `Rotor-Cuda/bsgs/BsgsGpu.h`

Build artifacts `Rotor-Cuda/Rotor` and `Rotor-Cuda/obj/` are disposable and must be removed before commit.

## Architecture

- CLI path: `--mode bsgs -g --gpui 0 --range START:END PUBKEY`.
- `-g` explicitly selects GPU-BSGS. Launcher/device errors and output truncation fail loudly. No silent CPU fallback.
- One GPU supported. Multi-GPU scheduling remains future work.
- `GPU/GPUEngine.cu` unity-includes `bsgs/BsgsGpu.cu`; never compile or link `BsgsGpu.cu` as a second CUDA translation unit.
- GPU giant walk uses bounded host batches, 32-bit kernel walk/step coordinates, canonical X reconstruction, binary-fuse fast reject, exact map lookup, and authoritative EC re-verification.
- Infinity is represented transiently in device code and emitted through `DpHit.infinity`; host maps valid infinity index back to `kStart + i*m`.
- GPU math reuses existing `GPU/GPUMath.h`; do not invent `_ModAdd` (not available).

## Known implementation ceilings

- Baby-table fold currently maps one folded value to one `j`; full-X collision buckets are future hardening.
- `build_baby()` uses low 64-bit span; wide ranges need checked `Int` arithmetic before claiming support.
- Overflow checks for `m*2`, `i*m`, `covered*m`, and `strideStep` need separate work.
- Self-tests use `assert`; `NDEBUG` removes them.
- GPU boundary patch still needs device execution evidence for `A == S`, `A == -S`, infinity, and DP infinity marker.

## Environment and credentials

- Real device: NVIDIA GeForce RTX 5070, driver 610.88, CUDA 13.3, WSL2, `sm_120`.
- CUDA path inside WSL: `/usr/local/cuda`.
- Hosted CI has no GPU. CUDA compile and real device smoke are separate gates.
- Git operations must run inside WSL repo and use user's personal GitHub credentials. Do not use Windows Git against `\\wsl.localhost` paths. Do not push with service identity.
- Never copy or commit Telegram bot tokens. Any old external launcher token must be revoked/rotated; future notifications use environment/credential store.

## Verified history

- `4690553`: GPU-BSGS wired to CLI.
- `6fa8a4f`: GPU kangaroo baseline, internal only.
- `16dd6d1`: on-device DP filter.
- `ee3b3fe`: batch modular inversion.
- `d936b07`: bounded/chunked GPU BSGS output.
- Archived OpenSpec changes exist under `openspec/archive/` for CLI, kangaroo, batch inversion, DP filter, fusion, and chunked output.

## Security boundary

Use only authorized public puzzle events with exposed public keys/addresses and official ranges. No mass scanning, de-anonymization, credential collection, or token reuse.
