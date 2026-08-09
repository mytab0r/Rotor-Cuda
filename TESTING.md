# Testing and operations

## Repository and shells

Repository root: `/home/test/Rotor-Cuda`. Source directory: `/home/test/Rotor-Cuda/Rotor-Cuda`.

Run builds from WSL. Host Windows Git cannot reliably access the WSL UNC path. Hosted CI cannot execute GPU device tests.

## CPU build

```bash
cd /home/test/Rotor-Cuda/Rotor-Cuda
make clean
make all
```

## GPU build

```bash
cd /home/test/Rotor-Cuda/Rotor-Cuda
make clean
make gpu=1 CCAP=120 all
```

Equivalent Windows invocation from an external shell:

```bash
wsl.exe -d Ubuntu -- bash -lc 'cd /home/test/Rotor-Cuda/Rotor-Cuda && make gpu=1 CCAP=120 all'
```

`CCAP=120` targets RTX 5070 `sm_120`. CUDA is `/usr/local/cuda`; expected local device is NVIDIA GeForce RTX 5070, driver 610.88, CUDA 13.3.

## CPU BSGS self-test

Source: `Rotor-Cuda/bsgs/bsgs_selftest.cpp`.

Expected successful output:

```text
auto-m hits: OK
explicit-m hits: OK
out-of-range reject: OK
deterministic re-run: OK
table manifest identity + reject: OK
ALL BSGS CPU SELFTESTS PASSED
```

Manual links must not list an object twice. GPU symbols require `GPU/GPUEngine.o`; `BsgsGpu.cu` is already included there.

## GPU evidence

Existing smoke sources:

- `Rotor-Cuda/bsgs/gpu_smoke.cu`
- `Rotor-Cuda/bsgs/gpu_smoke_batch.cu`
- `Rotor-Cuda/bsgs/gpu_smoke_dp.cu`
- `Rotor-Cuda/bsgs/gpu_smoke_kangaroo.cu`
- `Rotor-Cuda/bsgs/bsgs_gpu_selftest.cpp`

Before boundary hardening, device evidence passed:

- `4×8`: mismatches `0`;
- `32×64`: mismatches `0`;
- `256×256`: checked `65536`, mismatches `0`;
- batch inversion, DP filter, and kangaroo fixtures passed on RTX 5070.

Boundary acceptance still required:

- `A == S` produces infinity without `_ModInv(0)`;
- `A == -S` produces doubling;
- infinity minus `S` produces `-S`;
- infinity marker reaches host and maps only in-range giant index;
- out-of-range tail points are ignored;
- launcher failure and `truncated` return errors; no CPU fallback.

## CLI smoke

Use authorized public puzzle fixtures only. Malformed public-key input must fail loudly. Do not use mass scans or de-anonymization targets.

GPU-BSGS shape:

```bash
./Rotor --mode bsgs -g --gpui 0 --range START:END PUBKEY
```

Expected behavior: selected GPU required; invalid device, no device, launcher failure, and truncation are errors.

## Cleanup

```bash
cd /home/test/Rotor-Cuda/Rotor-Cuda
rm -rf obj Rotor
```

Verify with `git status --short`; only intentional source/docs/spec changes remain.

## CI

- `bsgs-selftest.yml`: CPU BSGS regression.
- `gpu-bsgs-compile.yml`: CUDA compile gate.
- `win-build.yml`: Windows build.
- `codeql.yml`: C++ static analysis.

CI success does not replace local RTX device evidence.
