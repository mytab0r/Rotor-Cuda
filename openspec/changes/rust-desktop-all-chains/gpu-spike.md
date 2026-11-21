# GPU spike: WGSL vs rust-gpu against the CUDA secp kernel

Status: **decision recorded 2026-11-21**. This document is the inventory and
time-boxed spike required by tasks 1-4 of
`openspec/changes/rust-desktop-all-chains/tasks.md`. It is evidence, not a
production design: no kernel, build flag or production path is changed by this
change.

Machine: Windows 11 Enterprise (10.0.26300), NVIDIA GeForce RTX 5070 (12 GB,
compute capability 12.0 / sm_120), driver 616.92, CUDA UMD 13.4, Vulkan
1.4.341. Rust 1.100.0 stable (x86_64-pc-windows-gnu). CUDA Toolkit / `nvcc`
is **not** installed on this machine.

## 1. What the CUDA path is today

### 1.1 Source inventory

| File | Lines | Bytes | Role |
|---|---:|---:|---|
| `Rotor-Cuda/GPU/GPUCompute.h` | 1200 | 37969 | Kernel bodies: address/xpoint single/multi, ETH single/multi |
| `Rotor-Cuda/GPU/GPUHash.h` | 857 | 27369 | Device SHA-256 and RIPEMD-160 |
| `Rotor-Cuda/GPU/GPUMath.h` | 933 | 24720 | 256-bit field arithmetic, grouped modular inverse, generator tables |
| `Rotor-Cuda/GPU/GpuAddressAbi.cu` | 468 | 21050 | Device translation unit and C ABI |
| `Rotor-Cuda/bsgs/BsgsGpu.cu` | 647 | 30776 | BSGS kernel |
| `Rotor-Cuda/bsgs/BsgsGpuAbi.cu` | 100 | 3278 | BSGS host ABI |
| `Rotor-Cuda/bsgs/BsgsGpu.h` | 91 | 4801 | BSGS declarations |
| **Total** | **4296** | **~150 KB** | |

The address kernel is not a generic double-and-add loop. `GPUCompute.h`
(`ComputeKeysSEARCH_MODE_SA`, line 514) fills a per-group table of `Gx[i] - P.x`
deltas, inverts the whole table once with `_ModInvGrouped`, then derives
`P + i*G` and `P - i*G` with 3 field operations per key (one `_ModMult`, one
`_ModSqr`, one `_ModMult`) plus the SHA-256/RIPEMD-160 check. `GRP_SIZE` and
`STEP_SIZE` are both 2048 (`GPUMath.h:24`, `src/gpu_plan.rs`). This matters for
the comparison: a naive WGSL scalar multiplication is not the same algorithm.

### 1.2 Build requirements (from `build.rs` and CI)

- `cargo build --release --features gpu` requires `nvcc` and the CUDA Toolkit's
  `cudart` component. `build.rs` resolves `ROTOR_NVCC`, then `CUDA_PATH` /
  `CUDA_HOME` / `CUDA_PATH_V*`, then `PATH`, and fails loudly if none is found.
- Windows also needs the MSVC C++ toolchain: `build.rs` passes `NVCC_CCBIN` to
  `nvcc` and CI locates `cl.exe` with `vswhere`. C++14 is passed to `nvcc`.
- Release CI pins CUDA 12.8.1 (`nvcc`, `cudart`, `visual_studio_integration`)
  and `ROTOR_CUDA_ARCHS=52,75,80,86,89,90,100,120`; sm_120 needs CUDA 12.8+.
- Two translation units are compiled (`GpuAddressAbi.cu`, `BsgsGpuAbi.cu`).
  `cudart_static` is linked, so the release executable needs only the NVIDIA
  driver at runtime; CI verifies there is no `cudart` DLL import.
- Without `--features gpu`, `build.rs` returns before looking for any C/C++
  compiler. The plain `cargo build --release` is already Rust-only.

### 1.3 Measured baseline on this GPU

The Rust `--features gpu` binary cannot be compiled here because there is no
`nvcc`. To still get a same-machine number, the published Windows release
binary was used. `gh release list` shows the latest asset is
`Rotor-Cuda-windows-x64-v0.1.0-ci.2.zip` (5,784,012 bytes), which contains the
legacy C++ `Rotor-Cuda.exe` (v2.0), not the Rust `rotor-gpu.exe`. That binary
runs the same `Rotor-Cuda/GPU/*` kernel lineage on the RTX 5070. Its `-c`
self-check passes generator/double/add/genkey/pubkey checks; the legacy binary
reports `Failed!` for the P2SH/bech32 address vectors it does not support,
which is unrelated to the CUDA field/hash throughput measured below.

Commands (run in an empty directory so `Found.txt`/checkpoints do not touch the
repository):

```sh
Rotor-Cuda.exe -g --gpui 0 --gpux 256,512 -m address --coin BTC \
  --range 1000000000:1fffffffff 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH
Rotor-Cuda.exe -g --gpui 0 --gpux 256,512 -m address --coin ETH \
  --range 1000000000:1fffffffff 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf
```

Each ran for 14-15 s; the target is key 1, outside the scanned range, so no
key can be found.

| Backend / mode | Sustained rate on RTX 5070 | Source |
|---|---:|---|
| CUDA, BTC single address, compressed, 256x512 | **1.90-1.98 Gk/s** (median ~1.94) | measured here, 14 s |
| CUDA, ETH single address, 256x512 | **1.04-1.09 Gk/s** (median ~1.05) | measured here, 14 s |
| CUDA, BTC, RTX 4090 (README sample) | 3.60 Gk/s | `README.md:527,534` |
| CUDA, RTX 4090 (README table) | 3.1 Gkeys/s | `README.md:487` |
| CUDA, RTX 5090 (README table) | 6.2 Gkeys/s | `README.md:488` |
| Rust CPU, 32 threads, BTC benchmark | 23.38 Mk/s | measured here (`--benchmark`) |
| Rust CPU, 4 threads (README) | 5.3 Mk/s | `README.md:735` |

The same-GPU CUDA number is the baseline for the 98% floor: **>= 1.90 Gk/s**
for the secp-hash160 single-address kernel and **>= 1.03 Gk/s** for the EVM
single-address kernel.

### 1.4 Binary size

- CPU-only Rust release binary on this machine:
  `target/release/rotor.exe` = **12,363,472 bytes (12 MiB)**, no C/C++ objects.
- The Rust `--features gpu` binary size was **not measurable** here: `nvcc` and
  `cudart` are absent. CI builds it and copies it to `rotor-gpu.exe`, but the
  latest GitHub release predates the Rust port and only contains the legacy
  C++ executable, so its size is not a valid substitute.
- What is known structurally: two CUDA objects for eight `sm` targets plus
  static `cudart` are linked into the same executable.

## 2. Acceptance criteria for the decision

Owner rule (hard): **do not remove CUDA until a measured 98% parity between CPU
and GPU results on the published fixtures**. If parity cannot be measured in
the spike, the decision must be "keep CUDA, revisit after parity harness".

Performance floor from the proposal and `design.md` D5: the candidate must
reach **>= 98% of the CUDA keys/s on the same GPU**, measured for >= 30 s, with
the same results, on Windows and Linux.

A candidate therefore needs all of:

1. A published-fixture parity harness comparing CPU and GPU output for every
   supported family. This spike did **not** build that harness.
2. A port of the real inner loop (grouped inversion, precomputed generator
   table, hashing), not only a generic `k*G`.
3. A sustained rate >= 1.90 Gk/s on the RTX 5070 for the BTC kernel and
   >= 1.03 Gk/s for the EVM kernel.
4. Windows and Linux runs.

## 3. Spike A: wgpu + WGSL

### 3.1 Implementation

Standalone crate: `spike/wgpu-secp/` (its own `[workspace]`, never a member of
the root workspace, so `cargo build --release` on a machine without a GPU is
unaffected). Shader: `spike/wgpu-secp/src/secp.wgsl` (12,154 bytes).

- Field arithmetic: Montgomery multiplication over sixteen 16-bit limbs
  (`array<u32,16>`). WGSL has no `u64`; a 32x32 product is emulated with
  16-bit limbs. Constants: p, R = 2^256 mod p, R^2 mod p, `N0 = 0x3531`.
- Points: Jacobian `array<u32,48>`; mixed addition and doubling for
  y^2 = x^3 + 7.
- Scalar multiplication: 4-bit window over 64 nibbles, table of 15 affine
  multiples of G uploaded from the host, 4 doublings + 1 mixed addition per
  window. This is **not** the CUDA grouped-inversion loop; it is the
  straightforward WGSL baseline.
- Second entry point: a dependent chain of `ITER = 512` Montgomery
  multiplications per invocation, to measure field throughput separately from
  the scalar-multiplication schedule.

Toolchain: wgpu 30.0.2, naga 30.0.2, stable Rust 1.100.0, Vulkan backend.

### 3.2 Correctness

The host verifies every GPU result against k256 and num-bigint before timing:

- keys 1..16 (base 0): 16/16 affine x and y matched k256;
- base `2^128 + 0xdeadbeef`, 64 consecutive scalars: 64/64 matched k256;
- 512 dependent Montgomery multiplications: output equals the host bigint
  chain;
- every verified point satisfies y^2 = x^3 + 7 mod p.

### 3.3 Measurements

Three full runs (numbers vary by ~1.5% between runs; the final run is quoted):

```text
ADAPTER      : NVIDIA GeForce RTX 5070 | backend Vulkan | driver NVIDIA (616.92)
K*G CHECK    : 16/16 keys matched k256 (base 0, keys 1..16)
K*G CHECK    : 64/64 keys matched k256 (base 2^128+0xdeadbeef)
FIELD CHECK  : 512 dependent Montgomery multiplications matched host bigint
K*G RATE     : 1.696 Mkeys/s (8388608 keys in 4.947 s, 4-bit window)
MODMUL RATE  : 2.238 Gmodmul/s (8589934592 modmuls in 3.838 s)
EST. STEPPED : 0.746 Gkeys/s upper bound for a 3-modmul/key CUDA-style loop, hash excluded
```

Run-to-run range: K*G 1.696-1.724 Mkeys/s, modmul 2.238-2.256 Gmodmul/s,
optimistic bound 0.746-0.752 Gkeys/s.

Derived comparison (conservative end of the range):

| Metric | Value | vs CUDA 1.94 Gk/s (BTC) | vs CUDA 1.05 Gk/s (ETH) |
|---|---:|---:|---:|
| Measured generic `k*G` | 1.696 Mkeys/s | 0.087% | 0.162% |
| Optimistic stepped bound (3 modmuls/key, **no hashing**) | 0.746 Gkeys/s | 38.5% | 71.0% |

Even the bound that assumes the CUDA grouped-inversion schedule, ignores
SHA-256/RIPEMD-160/keccak entirely, and uses the measured field throughput is
below the 98% floor for both families. The measured generic kernel is three
orders of magnitude below it.

### 3.4 Build size and platform status

- Spike harness executable (wgpu + k256 + num-bigint + bytemuck, release):
  13 MB. This is the harness, not a production delta; the shader itself is
  12.2 KB of WGSL source.
- Windows: measured. Linux: not tested on this host; no Linux runner was
  produced in the time box. The crate and shader are cross-platform in
  principle, but Linux is unverified, as `design.md` D5 requires.

### 3.5 Interpretation limits

- 16-bit limb emulation is the obvious WGSL approach (no `u64`), but a more
  optimized 32-bit-limb schedule or subgroup operations could improve the
  field rate. This spike did not attempt them; the measured number is a
  baseline, not a proven upper bound for WGSL.
- The generic `k*G` number must not be compared directly with CUDA: CUDA
  amortizes one inverse over 2048 keys and performs 3 field operations per key.
  The modmul-derived 0.746-0.752 Gkeys/s bound is the fairer comparison, and it still
  excludes all hashing.
- The hash stage is not implemented in WGSL here. A production port must add
  SHA-256 + RIPEMD-160 (secp) or keccak (EVM), which can only lower the bound.

## 4. Spike B: rust-gpu (SPIR-V)

### 4.1 Toolchain pin and driver

- `cargo-gpu` 0.11.0 (`cargo install cargo-gpu --version 0.11.0 --locked`)
  resolves rust-gpu 0.11.0 / `spirv-std` 0.11.0 and installs the pinned
  toolchain **`nightly-2026-08-15`** (rustc 1.99.0-nightly,
  `d453bdd8f 2026-08-14`) with `cargo, rustc, rust-std, clippy, rust-src,
  rustc-dev, llvm-tools`.
- Shader crate: `spike/rust-gpu-secp/` (`[workspace]`, `spirv-std = "0.11.0"`,
  `target = "spirv-unknown-vulkan1.2"`). It contains a minimal compute entry
  point (not the secp kernel) to test the toolchain end to end.
- Driver: RTX 5070, Vulkan 1.4.341, NVIDIA 616.92. wgpu 30 with the `spirv`
  feature can load SPIR-V directly, so the same host can run the output.

### 4.2 Build result on this machine: works only after host workarounds

The shader compiles and runs here, but not through the documented path without
workarounds. The exact steps and failures:

1. `cargo gpu build --auto-install-rust-toolchain` installs the pinned
   toolchain and then builds `rustc_codegen_spirv` 0.11.0 with
   `cargo +nightly-2026-08-15`. `rustup` resolves the bare channel to the
   **MSVC** host (`nightly-2026-08-15-x86_64-pc-windows-msvc`), because the
   rustup default host is `x86_64-pc-windows-msvc`. This machine has no MSVC
   `link.exe` or Windows SDK: the build fails with `link: extra operand` (the
   `link.exe` on `PATH` is Git Bash's GNU `link`) and with
   `failed to write ...target\release\build\...rmeta: os error 17`
   (`os error 17` = cross-device move; `%LOCALAPPDATA%` for this process is
   redirected to `D:\WpSystem\...` while `%TEMP%` is on `C:`).
2. Building the codegen backend with the **GNU** host instead
   (`cargo +nightly-2026-08-15-x86_64-pc-windows-gnu build --release` with
   `CARGO_TARGET_DIR` on the same drive) succeeds: a 40 MB
   `rustc_codegen_spirv.dll` in 2m02s from `spirv-tools` 0.13.3 and the
   rust-gpu crates. The same build with
   `-C link-arg=-static-libgcc -C link-arg=-static-libstdc++` also completed,
   but the DLL still imports `libgcc_s_seh-1.dll` / `libstdc++-6.dll`, so the
   static flags did not remove the host-runtime dependency.
3. `cargo gpu build` still selected the MSVC host for the shader build, so a
   local `cargo.exe` wrapper (placed next to `cargo-gpu.exe`, because Windows
   `CreateProcess` searches the application directory before `PATH`) rewrote
   `+nightly-2026-08-15` to the GNU host. The shader build then used the GNU
   rustc, but loading the codegen DLL failed with
   `LoadLibraryExW failed: ... (os error 127)` (missing procedure): rustc loads
   the toolchain's older `libgcc_s_seh-1.dll` / `libwinpthread-1.dll` from its
   own directory ahead of the GCC 16 runtime the codegen DLL was linked
   against.
4. Temporarily placing the GCC 16 `libgcc_s_seh-1.dll`,
   `libwinpthread-1.dll` and `libstdc++-6.dll` next to the GNU rustc made the
   codegen load. The shader then compiled:

   ```text
   Finished `release` profile [optimized] target(s) in 19.98s
   rust_gpu_secp_spike.spv   764 bytes
   manifest.json             115 bytes
   ```

   The temporary runtime swap was reverted immediately afterwards; the
   toolchain is back to its installed state.

### 4.3 Measured result and remaining blocker

- Builds at all: **yes, after the host workarounds above** (GNU nightly,
   GNU-built codegen, compatible MinGW runtime). The documented one-command
   path does not work on this host.
- Runtime: wgpu 30 with the `spirv` feature loaded the 764-byte module on the
  RTX 5070 (Vulkan 1.4.341, driver 616.92) and dispatched it. All 64 threads
  matched the expected pattern:

  ```text
  SPV ADAPTER  : NVIDIA GeForce RTX 5070 | backend Vulkan | driver NVIDIA
  SPV CHECK    : 64 threads ran rust-gpu SPIR-V and matched the expected pattern
  ```

- secp performance: **not measured**. The spike tested a minimal compute entry
  point, not the secp kernel. Porting the field arithmetic and the grouped
  inversion loop to rust-gpu was outside the time box, so no rust-gpu keys/s
  number exists.
- The toolchain is not CI-ready as found: it needs a specific GNU host
  workaround, `rustc-dev`, and a MinGW C++ runtime matched to the codegen
  DLL; the default MSVC host path needs a full Visual Studio/Windows SDK
  install. Linux was not attempted.

## 5. Comparison

| | CUDA (today) | wgpu/WGSL | rust-gpu/SPIR-V |
|---|---|---|---|
| Host language | C++/CUDA + nvcc | Rust + WGSL | Rust |
| Build on this machine | blocked (no nvcc) | works | works after host workarounds |
| BTC keys/s, RTX 5070 | 1.94 Gk/s (measured) | 1.696-1.724 Mkeys/s measured; 0.746-0.752 Gkeys/s optimistic bound, no hash | not measured (trivial kernel only) |
| EVM keys/s, RTX 5070 | 1.05 Gk/s (measured) | same upper bound, no keccak | not measured |
| Correctness in spike | legacy `-c` self-check passes | 80/80 scalars + 512 modmuls match k256/bigint | 64/64 threads on the trivial kernel; secp not ported |
| Windows | works | works | builds/runs after workarounds |
| Linux | not measured here (README/CI builds) | not tested | not tested |
| Additional toolchain | CUDA 12.8.1 + MSVC | none (wgpu) | nightly-2026-08-15 + rustc-dev + GNU-host/MinGW workaround |

## 6. Decision

**Keep CUDA feature-gated. Mark the Rust-only and GPU-port goal blocked.**

Reasons, in order of the owner's rule:

1. **Parity is not measured.** The spike verified a WGSL kernel against k256
   for 80 scalars and against bigint for the field chain, but it did not build
   the required CPU-vs-GPU fixture harness over the published fixtures and all
   families. The hard rule therefore applies unchanged: do not remove CUDA
   before that harness exists and passes. Revisit after a parity harness.
2. **The 98% performance floor is not met.** On the same RTX 5070, CUDA is
   1.94 Gk/s (BTC) and 1.05 Gk/s (ETH). The WGSL generic kernel is 1.696-1.724
   Mkeys/s (0.087-0.089% of BTC). The optimistic CUDA-schedule bound from the
   measured modmul rate is 0.746-0.752 Gkeys/s (38.5-38.8% of BTC, 71.0-71.6%
   of ETH) with all hashing excluded. A backend below the floor does not justify deleting a
   faster one.
3. **rust-gpu has no measurable secp candidate.** Its pinned toolchain
   (`nightly-2026-08-15`) installs, its codegen backend builds with the GNU
   host, and a 764-byte SPIR-V module runs on this GPU. But that module is a
   trivial 64-thread kernel: the secp field/inversion loop was not ported, so
   there is no rust-gpu keys/s number and no parity result. The documented
   one-command build also does not work on this host without a GNU-host
   wrapper and a matched MinGW runtime, so it is not yet a CI-reproducible
   path.

What would unblock a future change:

- A fixture parity harness (CPU vs GPU, 18 chains) on the published fixtures,
  committed before any CUDA deletion.
- A port of the real grouped-inversion inner loop, with SHA-256/RIPEMD-160
  and keccak, to both candidate backends; the WGSL baseline and the rust-gpu
  toolchain are separate experiments, not a port.
- A clean, reproducible rust-gpu host toolchain (MSVC + Windows SDK, or a
  documented GNU-host + MinGW runtime setup) before it can be a release
  backend.
- A >= 30 s measurement on Windows and Linux on the same GPU, meeting
  >= 98% of the recorded CUDA baseline (>= 1.90 Gk/s BTC, >= 1.03 Gk/s ETH
  on this RTX 5070; re-measure per GPU).

Until then, `--features gpu` remains the fast path and no CUDA source, `nvcc`
branch or CI step is removed.

## 7. Reproduce

The wgpu spike is standalone (no GPU needed to compile; a GPU is needed to
run):

```sh
cd openspec/changes/rust-desktop-all-chains/spike/wgpu-secp
cargo run --release            # correctness + throughput; exits non-zero on a mismatch
cargo run --release -- --spv ../rust-gpu-secp/rust_gpu_secp_spike.spv
```

The rust-gpu probe (requires the pinned nightly and a host linker; not part of
the workspace). On this host the one-command path fails as described in 4.2;
the working sequence was: build `rustc_codegen_spirv` with the GNU nightly,
run the shader build through a GNU-host `cargo` wrapper, and provide the
matching MinGW runtime for the codegen DLL.

```sh
cargo install cargo-gpu --version 0.11.0 --locked
cd openspec/changes/rust-desktop-all-chains/spike/rust-gpu-secp
cargo gpu build --auto-install-rust-toolchain
```

Both crates carry `[workspace]`, so the root `cargo build --release` and
`cargo test --release` do not compile them. The `.spv` path in the second wgpu
command only exists after the rust-gpu build; the generated `.spv` is not
committed, the shader source is.

## 8. Files

- `openspec/changes/rust-desktop-all-chains/gpu-spike.md` (this document)
- `openspec/changes/rust-desktop-all-chains/spike/wgpu-secp/` (Cargo.toml,
  Cargo.lock, src/main.rs, src/secp.wgsl)
- `openspec/changes/rust-desktop-all-chains/spike/rust-gpu-secp/` (Cargo.toml,
  Cargo.lock, src/lib.rs)
