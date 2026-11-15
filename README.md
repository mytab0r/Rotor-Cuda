# Rotor-Cuda v2.0-rotor (mytab0r fork)

![Rotor-Cuda](Others/Rotor-Cuda.jpg)

Maintained by **mytab0r** — https://github.com/mytab0r/Rotor-Cuda

This is a modified version of KeyHunt v1.7 ...
A secp256k1 key-search tool for authorized public puzzle events. This fork reuses code from KeyHunt, VanitySearch / JeanLucPons, and Mehdi256's Rotor-Cuda v2. Licensed under GPLv3.0; original copyrights are retained. It is not for mass scanning or de-anonymization.

## What this fork adds (mytab0r) :
- **BSGS mode `--mode bsgs`** — recover a scalar from a known **public key** inside a `--range START:END` (baby-step/giant-step over secp256k1, CPU). Baby table + binary-fuse fast-reject + EC re-verify. For authorized public puzzles where the pubkey is exposed.
- **GPU BSGS backend `--mode bsgs -g`** — explicit one-GPU giant walk with
  shared baby table, canonical-X folding, exhaustive `dpBits=0` output, and
  final EC re-verification. No silent CPU fallback; multi-GPU scheduling is
  deferred.
- **GPU address/xpoint search `-g`** — the CUDA kernels from `GPU/` run behind
  `--features gpu` for `-m address|addresses|xpoint|xpoints` (BTC and ETH):
  range split into one chunk per GPU thread, bloom/target prefilter on device,
  exact target lookup and EC re-verification on the host. One GPU per run;
  random mode (`-r`) and checkpoints (`-n`) are rejected loudly.
- **GPU BSGS batch inversion** — W independent walks share Montgomery inversion;
  verified on RTX 5070 (`sm_120`) against GMP ground truth. See
  `bsgs/BATCH_INVERT.md`.
- **GPU BSGS distinguished-point filter** — canonical-X DP emission with honest
  `total` and fail-loud `truncated` reporting. See `bsgs/DP_FILTER.md`.
- **GPU Pollard kangaroo baseline** — internal and not CLI-exposed. SOTA K≈1.15,
  persistent walks, and multi-GPU remain follow-up work. See `bsgs/KANGAROO.md`.
- **Filter catalog** — binary-fuse filter alongside the classic bloom for large hash160 sets (lower false-positive at similar memory).
- **Self-update** — SHA-256 verified binary self-replace via WinHTTP + MoveFileEx rename-trick (Windows).
- **Cloud CI/CD** — full Windows build (MSBuild + CUDA) and Release pipeline run entirely on GitHub Actions; no local toolchain needed.
- Only for **authorized public puzzle events** (known addresses, known bit ranges, official rewards). Not for mass scanning or de-anonymization.

### BSGS usage (CPU) :
```
./Rotor --mode bsgs --range 400000000000000000:7fffffffffffffffff 02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```

### BSGS usage (GPU) :
```
./Rotor --mode bsgs -g --gpui 0 --range 400000000000000000:7fffffffffffffffff 02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```
The Rust build needs the CUDA Toolkit (nvcc): `cargo build --release --features gpu`
(on Windows use the MSVC Rust toolchain — CUDA ships `cudart.lib`; Linux/WSL uses
`lib64/libcudart.so`).
`ROTOR_CUDA_ARCHS` selects the target architecture (default `75` = sm_75 cubin plus
PTX so newer GPUs JIT; use `120` for RTX 50xx). `-g` selects GPU-BSGS with `--gpui`
and GPU address/xpoint search with `--gpui`/`--gpux`.
The GPU search path fails loudly on invalid devices, unsupported options, or
output truncation; it never falls back to CPU. On an NVIDIA host,
`cargo test --features gpu` runs the CPU==GPU fixtures for BSGS and for
address/xpoint search (they print a skip line when no device is present).

## Changes (upstream v2) :
- Default Random 95% (252-256) bit + 5% (248-252) bit
- Random in a given bit range (1-256)
- Random between given bit ranges -n ? -z ?
- Automatic creation of Rotor-Cuda_START.bat with the specified cmd parameters
- Many small visual improvements

### To scan in (GPUs)
- **-n ?** save checkpoint every ? minutes. (1-10000)
- If you do not specify -n ? (search without continuing)
- After the Rotor-Cuda_Continue.bat file appears, you can continue from the last checkpoint.
- To continue correctly, do not change the parameters inside the file.
- **If you do not need to continue, DELETE the Rotor-Cuda_Continue.bat !!!**
---
### For Random use - r 5 (GPUs)
- **-r ?** When you enter -r 5, it means that up to 5 billion keys are allowed to be scanned and after that, randomly selected sections will be scanned
- **-n ?** (1-256) bit. If you do not specify -n will be the default 95% (252-256) bit + 5% (248-252) bit
- **-z ?** (end random range must be greater than -n value) example: -n 252 -z 256
- Random for search [puzzle](https://privatekeys.pw/puzzles/bitcoin-puzzle-tx) 71 example:

- ```./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC -r 5 --range 400000000000000000:7fffffffffffffffff 1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU```
- If your GPU is weaker than RTX 1080 or the driver crashes. Remove **--gpux 256,256** from the row the grid will be auto-assigned
---
### GPU Bitcoin Multi Address mode :
- Range: ```./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin BTC --range 400000000:7ffffffff -i Btc-h160.bin```
- Random: ```./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin BTC -r 5 -i Btc-h160.bin```
---
### GPU Bitcoin Single Address mode :
- Range: ```./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC --range 400000000:7ffffffff 1PWCx5fovoEaoBowAvF5k91m2Xat9bMgwb```
- Random: ```./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC --range 400000000:7ffffffff -r 5 1PWCx5fovoEaoBowAvF5k91m2Xat9bMgwb```
---
### GPU ETHEREUM Multi Address mode :
- Range: ```./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin eth --range 4000000:ffffffff -i eth.bin```
- Random: ```./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin eth --rang 4000000:ffffffff -r 5 -i eth.bin```
---
### GPU ETHEREUM Single Address mode :
- Range: ```./Rotor -g --gpui 0 --gpux 256,256 -m address --coin eth --range 8000000:fffffff 0xfda5c442e76a95f96c09782f1a15d3b58e32404f```
- Random: ```./Rotor -g --gpui 0 --gpux 256,256 -m address --coin eth --range 8000000:fffffff -r 5 0xfda5c442e76a95f96c09782f1a15d3b58e32404f```

****Do not use non-standard grid sizes; dimensions must be multiples of 32.**

   |      GPU Model     |     Scanning Speed     |    Grid Size    |
   |-------------------|:--------------:|:------------------:|
   |    Tesla  T4    |   600 Mkeys   |     128×256     |
   |    RTX  3090    |   1.4 Gkeys   |     256×256     |
   |    RTX  4090    |   3.1 Gkeys   |     256×512     |
   |    RTX  5090    |   6.2 Gkeys   |     512×512     |
   |    RTX  60xx    |   x.x Gkeys   |     xxx.xxx     |


---
### Range Scan Sequentially :
```
$./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC --range 1000000000:1fffffffff 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex

  Rotor-Cuda v2.0-rotor  mytab0r

  COMP MODE    : COMPRESSED
  COIN TYPE    : BITCOIN
  SEARCH MODE  : Single Address
  DEVICE       : GPU
  GPU IDS      : 0
  GPU SIZE     : 256x256
  SSE          : YES
  BTC ADDRESS  : 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex
  OUTPUT FILE  : Found.txt

  Start Time   : Sun Sep 21 06:51:02 2025

  Global start : 1000000000 (37 bit)
  Global end   : 1FFFFFFFFF (37 bit)
  Global range : FFFFFFFFF (36 bit)

  GPU Mode     : GPU #0 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)

  Rotor info   : Divide the range FFFFFFFFF (278 bit) into GPU 65536 threads

  Thread 00000 : 1000000000 -> 10000FFFFF
  Thread 00001 : 10000FFFFF -> 10001FFFFE
  Thread 00002 : 10001FFFFE -> 10002FFFFD
  Thread 00003 : 10002FFFFD -> 10003FFFFC
  Thread 65534 : 1FFFDF0002 -> 1FFFEF0001
  Thread 65535 : 1FFFEF0001 -> 1FFFFF0000
  Thread 65536 : 1FFFFF0000 -> 20000EFFFF

  [00:00:07] [15D98444CC] [F: 0] [00:01:07] [C: 36.132813 %] [GPU: 3.60 Gk/s] [T: 24,830,279,680]
  ================================================================================================
  PubAddress: 14iXhn8bGajVWegZHJ18vJLHhntck8EEPa
  Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX5a6P5M
  Priv (HEX): 1757756A93
  PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255

  [00:00:07] [16008246F6] [F: 1] [00:01:06] [C: 37.109375 %] [GPU: 3.61 Gk/s] [T: 25,501,368,320]

```
### Range Scan Randomly :
```
$./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC --range 1000000000:1fffffffff -r 5 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex

  Rotor-Cuda v2.0-rotor  mytab0r

  COMP MODE    : COMPRESSED
  COIN TYPE    : BITCOIN
  SEARCH MODE  : Single Address
  DEVICE       : GPU
  GPU IDS      : 0
  GPU SIZE     : 256x256
  SSE          : YES
  BTC ADDRESS  : 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex
  OUTPUT FILE  : Found.txt

  Start Time   : Sun Sep 21 07:05:02 2025

  GPU Mode     : GPU #0 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)
  Base Key     : Randomly changes 65536 start Private keys every 5,000,000,000 on the counter
  ROTOR Random : Min 37 (bit) 1000000000
  ROTOR Random : Max 37 (bit) 1FFFFFFFFF

  |00:00:27| R : 17 | 17E005E2C7 | F : 0 | GPU: 3.57 Gk/s | T: 95,428,804,608 |
  ================================================================================================
  PubAddress: 14iXhn8bGajVWegZHJ18vJLHhntck8EEPa
  Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX5a6P5M
  Priv (HEX): 1757756A93
  PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255

  |00:00:27| R : 17 | 17E00605C5 | F : 1 | GPU: 3.57 Gk/s | T: 96,099,893,248 |

```
### Range Scan with Multi Address :
```
$./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin BTC --range 1000000000:1fffffffff -r 5 -i Puzzles_h160.bin

  Rotor-Cuda v2.0-rotor  mytab0r

  COMP MODE    : COMPRESSED
  COIN TYPE    : BITCOIN
  SEARCH MODE  : Multi Address
  DEVICE       : GPU
  GPU IDS      : 0
  GPU SIZE     : 256x256
  SSE          : YES
  BTC HASH160s : Puzzles_h160.bin
  OUTPUT FILE  : Found.txt

  Loading      : 160 %
  Loaded       : 160 Bitcoin addresses

  Bloom at     : 0x5b675c9509a0
  Version      : 2.1
  Entries      : 322
  Error        : 0.0000010000
  Bits         : 9259
  Bits/Elem    : 28.755175
  Bytes        : 1158 (0 MB)
  Hash funcs   : 20

  Site         : https://github.com/mytab0r/Rotor-Cuda
  Donate       : bc1qdfaj5zyvfkr7wtzaa72vqxzztpl2tz7g5zk5ug

  Start Time   : Sun Sep 21 18:06:29 2025

  GPU Mode     : GPU #0 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)
  Base Key     : Randomly changes 65536 start Private keys every 5,000,000,000 on the counter
  ROTOR Random : Min 37 (bit) 1000000000
  ROTOR Random : Max 37 (bit) 1FFFFFFFFF

  |00:00:18| R : 15 | 167ABCD68F | F : 0 | GPU: 3.53 Gk/s | T: 81,604,378,624 |
  ================================================================================================
  PubAddress: 14iXhn8bGajVWegZHJ18vJLHhntcnHyduN
  Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX5a6P5M
  Priv (HEX): 1757756A93
  PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255

  |00:00:18| R : 15 | 16F55BF6A1 | F : 1 | GPU: 3.53 Gk/s | T: 82,328,530,944 |

```
### Puzzle 71 Scan with Multi GPU :
```
$./Rotor -g --gpui 0,1,2 --gpux 256,256,256,256,256,256 -m address --coin BTC --range 400000000000000000:7fffffffffffffffff -r 15 1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU

  Rotor-Cuda v2.0-rotor  mytab0r

  COMP MODE    : COMPRESSED
  COIN TYPE    : BITCOIN
  SEARCH MODE  : Single Address
  DEVICE       : GPU
  GPU IDS      : 0, 1, 2
  GPU SIZE     : 256x256, 256x256, 256x256
  SSE          : YES
  BTC ADDRESS  : 1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU
  OUTPUT FILE  : Found.txt

  Start Time   : Tue Sep 21 16:58:42 2025

  GPU Mode     : GPU #0 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)
  Base Key     : Randomly changes 262144 start Private keys every 15,000,000,000 on the counter
  ROTOR Random : Min 71 (bit) 400000000000000000
  ROTOR Random : Max 71 (bit) 7FFFFFFFFFFFFFFFFF

  GPU Mode     : GPU #1 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)
  Base Key     : Randomly changes 262144 start Private keys every 15,000,000,000 on the counter
  ROTOR Random : Min 71 (bit) 400000000000000000
  ROTOR Random : Max 71 (bit) 7FFFFFFFFFFFFFFFFF

  GPU Mode     : GPU #2 NVIDIA GeForce RTX 4090 (128x0 cores) Grid (256x256)
  Base Key     : Randomly changes 262144 start Private keys every 15,000,000,000 on the counter
  ROTOR Random : Min 71 (bit) 400000000000000000
  ROTOR Random : Max 71 (bit) 7FFFFFFFFFFFFFFFFF

  |00:24:09| R : 1250 | 61AE654C8F21375303 | F : 0 | GPU: 10.96 Gk/s | T: 18,874,233,782,272 |

  ```
# Linux
- **Note: use Makefile targets below; do not edit Makefile for normal builds.**

- update & Install libgmp: ```sh
sudo apt update
sudo apt install -y libgmp-dev
```

- CUDA       = /usr/local/cuda-10.0 ~ 13.x (CUDA 13.3 verified for SM_120)

- CXXCUDA    = /usr/bin/g++

- To build CPU-only version :

  ```sh

   make all

  ```
- To build with CUDA (GPU)

- To get info about various Nvidia GPU CCAP value see :

   #### https://arnon.dk/matching-sm-architectures-arch-and-gencode-for-various-nvidia-cards

  ```sh

   cd Rotor-Cuda

   make gpu=1 CCAP=75 all     [SM_75]

   make gpu=1 CCAP=89 all     [SM_89]

   make gpu=1 CCAP=100 all   [SM_100]

  ```

## Rust CPU port

The CPU side of Rotor-Cuda is being ported to Rust (GPLv3, same licence). The CUDA
tree under `Rotor-Cuda/` is unchanged and remains the reference for the GPU backend.

Build (no GMP, no CUDA, no MSBuild needed):

```sh
cargo build --release
./target/release/rotor --help
```

Implemented in Rust:

- `-c/--check` self-check (secp256k1 vectors, address/WIF pairs)
- `-m address` / `-m addresses` for BTC (compressed/uncompressed/both), multi-threaded
- `-m xpoint` / `-m xpoints` (32-byte X targets)
- `-m address` / `-m addresses` for Ethereum (keccak160)
- `-m bsgs` CPU baby-step/giant-step (pubkey → scalar), manifest identity
- `-m bsgs -g` GPU-BSGS behind `--features gpu` (`-l` lists CUDA devices)
- `-r` random mode with `-n`/`-z` bit-range selection
- `-n` checkpoint files (`Rotor-Cuda_Continue.bat` / `Rotor-Cuda_START.bat`)
- `--check-update` / `--update` self-update on Windows (WinHTTP + SHA-256,
  assets `rotor.exe` / `rotor-gpu.exe` and their `.sha256`)
- headerless `.bin` targets (20-byte hash160 / 32-byte xpoint records, sorted internally)
- `Found.txt` block format and progress line of the C++ binary

Remaining gap: GPU address/xpoint search is single-GPU and rejects `-r`/`-n`
loudly; multi-GPU scheduling is deferred. The C++ binary still covers GPU
multi-GPU runs.

Known deviations from the C++ binary:

- `-g` without a GPU build exits with code 2 (C++ prints the same message but continues).
- `.bin` inputs are sorted internally; the C++ binary requires a pre-sorted file.
- CPU-BSGS uses the full 256-bit range span and rejects spans above `u128`.
- BinaryFuse acceleration is not ported (results are unchanged).
- The `Priv (WIF)` string printed in the C++ README example is not a valid WIF;
  the Rust binary prints the canonical one.
- Timestamps in the banner and checkpoint files are UTC (the C++ binary uses local time).
- BTC addresses are validated with Base58Check; the C++ binary does not verify the
  checksum and would accept a corrupted address.
- On resume, the banner shows the shifted start key that is actually scanned.
- `-n`/`-z` are validated against 0..256 even when `--range` is given (C++ checks
  them only in the bit-range branch).
- Random-mode banner lines (`ROTOR Random`, `Base Key`) are not reproduced; the
  progress line uses the same `[R: n]` field.
- Self-update is Windows-only and only accepts the Rust assets (`rotor.exe`,
  `rotor-gpu.exe`); the C++ `Rotor-Cuda.exe` is never used. It also fixes the C++
  asset-URL scan that never matched a download URL.

Rough CPU throughput on a 4-thread release build (compressed address hashing):
~5.3 Mk/s total (~1.3 Mk/s per core). CPU-BSGS solves a 2^31-wide range in ~0.13 s.

## License
- Rotor-Cuda is licensed under GPLv3.0

## Donation
- BTC: bc1qdfaj5zyvfkr7wtzaa72vqxzztpl2tz7g5zk5ug

## Disclaimer
  ALL THE CODES, PROGRAM AND INFORMATION ARE FOR EDUCATIONAL PURPOSES ONLY. USE IT AT YOUR OWN RISK. THE         DEVELOPER WILL NOT BE RESPONSIBLE FOR ANY LOSS, DAMAGE OR CLAIM ARISING FROM USING THIS PROGRAM.
