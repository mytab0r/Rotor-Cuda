# Design: Rust GPU backend

## Layering

```
main.rs / bsgs::run_cli      CLI selection, loud errors
        |
src/bsgs.rs::solve_gpu       baby table, walk planning, hit filtering, EC reverify
        |
src/gpu.rs                   safe FFI wrapper (buffers, error strings)
        |
BsgsGpuAbi.cu                extern "C" shim over launch_giant_dp
        |
BsgsGpu.cu                   unchanged kernels + host launcher
```

The C++ `solve_gpu` (`BsgsCpu.cpp:169`) is the reference implementation. Its
semantics are reproduced exactly:

- `giantPoints = span / m + 1`, `nSteps = 1024`, `nWalks = ceil(giantPoints/nSteps)`,
  `W = 8`, `dpBits = 0` (emit every point).
- Walk `w` starts at `Q - w*nSteps*S`; the batch emits `nWalks*nSteps` points.
- Hit index `i = walk*nSteps + step`; `kp = i*m + j`; reject `i >= giantPoints` and
  `kp > span`; accept only after `kp*G == target` (exact EC reverify).
- A walk start at infinity is resolved on the host when its `kp` is in range.
- Launcher failure or truncation (`total > maxHits`) is an error. No CPU fallback.

## C ABI

```c
int rotor_gpu_device_count(char* err, unsigned err_len);            /* -1 on error */
int rotor_gpu_device_name(int device, char* buf, unsigned buf_len); /* 0 ok */
int rotor_bsgs_gpu_giant_dp(
    const uint64_t* start_xy, const uint64_t* stride_xy,
    uint32_t n_walks, uint32_t n_steps, uint32_t w, uint32_t dp_bits,
    uint32_t max_hits, int device_index,
    uint32_t* out_walk, uint32_t* out_step, uint64_t* out_x,
    uint8_t* out_parity, uint64_t* out_total, uint32_t* out_stored,
    char* err, unsigned err_len);                                    /* 0 ok */
```

Caller-allocated output buffers: no heap crosses the ABI. `err` is always
NUL-terminated on failure.

## X-coordinate handling

The DP kernel emits canonical (least-residue) X as 4 little-endian limbs
(`BsgsGpu.cu:165`). The host converts limbs to 32 big-endian bytes and folds with
the same FNV-1a/64 used by the CPU baby table, so GPU and CPU agree on identity.

## Build

`build.rs` runs only when `CARGO_FEATURE_GPU` is set. It:

1. Locates nvcc via `ROTOR_NVCC`, `CUDA_PATH`, `CUDA_HOME`, then PATH.
2. Compiles each `.cu` to an object in `OUT_DIR` with `-std=c++14 -I Rotor-Cuda`
   and `-gencode` per entry of `ROTOR_CUDA_ARCHS` (default `75`, plus PTX for the
   highest arch so newer GPUs JIT).
3. Passes `-ccbin $NVCC_CCBIN` when set (Windows without a VS prompt).
4. Emits `cargo:rustc-link-arg-bins/tests=<obj>`, `cargo:rustc-link-search` and
   `cargo:rustc-link-lib=dylib=cudart`.

Missing nvcc or a failed compile is a build-script panic with the command and the
compiler output, never a silent CPU-only build.

## CLI behavior

- `-g` + BSGS: GPU-BSGS, device from `--gpui` (first id).
- `-g` + address/xpoint: error, exit 2 ("GPU address search is not implemented in
  the Rust build").
- `-g` without the feature: error, exit 2, naming `--features gpu`.
- `-l`: lists CUDA devices when compiled with the feature, otherwise the current
  message.
- `--gpux` is accepted and ignored in BSGS mode, matching the C++ caller
  (`Main.cpp:488` passes only the device id).

## Tests

- `gpu::plan_walks` unit test (no device): starts equal `Q - w*1024*S` and the
  infinity boundary resolves on the host.
- `tests/gpu_bsgs.rs` (`--features gpu`): CPU and GPU recover the same scalar on a
  small fixture; not-found agrees; prints a skip line when no CUDA device exists.
- CLI test: `-g` without the feature exits non-zero with a GPU message.
