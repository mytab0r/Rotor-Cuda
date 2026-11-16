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
- **Distributed coordinator `rotor-coord`** — token-protected HTTP/JSON server plus an embedded dashboard; several clients (CPU or one-GPU) lease disjoint key chunks of one job, BSGS giant-walk progress is stored remotely and resumed, and found keys are re-verified with `k*G == target` before they are accepted.
- **Self-update** — SHA-256 verified binary self-replace via WinHTTP + MoveFileEx rename-trick (Windows).
- **Cloud CI/CD** — full Windows build (MSBuild + CUDA) and Release pipeline run entirely on GitHub Actions; no local toolchain needed.
- Only for **authorized public puzzle events** (known addresses, known bit ranges, official rewards). Not for mass scanning or de-anonymization.

### BSGS usage (CPU) :
```
./Rotor --mode bsgs --range 400000000000000000:7fffffffffffffffff 02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```

### BSGS work files (offline resume)
CPU-BSGS can persist the baby table and the giant-walk position in a binary work
file, so a restarted run resumes without rebuilding the table (no baby-step EC):

```sh
./target/release/rotor -m bsgs --range 400000000000000000:7fffffffffffffffff \
  --bsgs-work bsgs-job.rwork \
  02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```

`--bsgs-work FILE` writes the file at startup and then at most once every 30 s
when the giant index advanced, plus once when the walk stops (found, exhausted
or Ctrl-C). Saves are atomic (`FILE.tmp` + rename); a failed save is reported and
exits non-zero instead of looking successful.

On restart the file is loaded and validated against the run: format version,
curve, `--range`, target public key, baby size and the table checksum. Any
mismatch (or a corrupted/truncated file) fails loudly, names the differing
field and exits non-zero; a foreign table is never silently reused. Pass
`--bsgs-work-reset` to overwrite a mismatched or stale file and start again from
giant index 0. The file format is version 1 (`RBWF` magic, little-endian header,
ordered folds and a SHA-256 trailer). Work files are CPU-BSGS only; in
coordinator mode the remote state decides the resume index, while a requested
local work file is still written.

### BSGS usage (GPU) :
```
./Rotor --mode bsgs -g --gpui 0 --range 400000000000000000:7fffffffffffffffff 02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```
Building with the GPU backend needs the CUDA Toolkit (nvcc): `cargo build --release
--features gpu` (on Windows use the MSVC Rust toolchain). The build links the CUDA
runtime statically (`cudart_static`), so the resulting binary runs on a machine with
only the NVIDIA driver — no CUDA Toolkit and no `cudart` DLL on PATH.
`ROTOR_CUDA_ARCHS` selects the target architectures (default `75` = sm_75 cubin plus
PTX so newer GPUs JIT; use `120` for RTX 50xx). Release builds ship cubins for
`52,75,80,86,89,90,100,120`; building sm_120 needs CUDA 12.8+.
`-g` selects GPU-BSGS with `--gpui` and GPU address/xpoint search with `--gpui`/`--gpux`.
The GPU search path fails loudly on invalid devices, unsupported options, or
output truncation; it never falls back to CPU. On an NVIDIA host,
`cargo test --features gpu` runs the CPU==GPU fixtures for BSGS and for
address/xpoint search (they print a skip line when no device is present).

## Distributed coordinator (`rotor-coord`)

A second binary in the same crate lets several machines work one range without manual
splitting: `rotor-coord` leases disjoint key chunks, keeps progress in one JSON file, and
serves a dashboard. Clients may be CPU workers or a single-GPU `--features gpu` build.

### Quick start

Build both binaries (`target/release/rotor[.exe]` and `rotor-coord[.exe]`), then start
the coordinator (token from `--token` or `ROTOR_COORD_TOKEN`):

```sh
cargo build --release --bins
./target/release/rotor-coord --token my-secret --state coordinator.json      # Linux
target\release\rotor-coord.exe --token my-secret --state coordinator.json   # Windows
```

It listens on `http://127.0.0.1:7878` (`--bind ADDR` overrides) and serves the dashboard
at `http://127.0.0.1:7878/`. Create one job there (paste the token first), or with curl:

```sh
curl -s -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" -d '{"mode":"address","coin":"btc","comp_mode":"compressed","target":"1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU","start":"400000000000000000","end":"7fffffffffffffffff"}' http://127.0.0.1:7878/api/v1/jobs
```

Run two clients (the second with `--client-id machine-b`) on the same target and range:

```sh
./target/release/rotor -m address --coin BTC --range 400000000000000000:7fffffffffffffffff \
  --coordinator http://127.0.0.1:7878 --token my-secret --client-id machine-a \
  1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU
```

Each client leases the next free chunk (width `0x10000000`, TTL 600 s), heartbeats every
5 s and re-leases on completion, so slices never overlap. An unrefreshed lease returns to
the pool; once all chunks are done leases answer 204 and clients stop. `Found.txt` is
written locally; the found key is also POSTed, and the coordinator verifies `k*G` against
the job target before accepting and marking the job found on the dashboard.

### GPU clients

A `--features gpu` build uses the same lease/heartbeat protocol as the CPU client, but
it scans one leased window at a time synchronously on the device: heartbeats are sent
between chunks and at the end of each chunk, never during a scan. The engine and its
generator table are created once and reused across leases; each lease only rebuilds the
key plan, uploads its starting points and scans the window. If a heartbeat is lost
because another client already submitted the found key (the job is found/done), the GPU
client stops normally; a lost lease on a still-active job aborts. Build with the CUDA
Toolkit as described above, then add `-g` to the same command (one GPU per client,
`--gpui` selects it):

```sh
./target/release/rotor -g --gpui 0 -m address --coin BTC --range 400000000000000000:7fffffffffffffffff \
  --coordinator http://127.0.0.1:7878 --token my-secret --client-id rig-a \
  1PWo3JeB9jrGwfHDNpdGK54CRas7fsVzXU
```

Supported modes are `address|addresses|xpoint|xpoints` for BTC and `address|addresses` for
ETH, with the same proof submission and `Found.txt` output as the CPU path. `-r`, `-n`
and `--gpux` follow the normal GPU limits. `-m bsgs -g` is rejected with `--coordinator`:
coordinator BSGS runs on the CPU (drop `-g`). Multi-GPU scheduling remains deferred.
Because a chunk is scanned synchronously, a chunk wider than `lease_ttl × device rate`
cannot be refreshed mid-scan; its lease may expire and the chunk may be handed to
another client (and scanned twice).

### BSGS resume

A `bsgs` job is searched as one giant walk, not chunk by chunk. Create it with the
public key (66 or 130 hex chars) as target:

```sh
curl -s -H "Authorization: Bearer my-secret" -H "Content-Type: application/json" -d '{"mode":"bsgs","start":"400000000000000000","end":"7fffffffffffffffff","target":"02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630"}' http://127.0.0.1:7878/api/v1/jobs
```

Then run the client with the same public key and range:

```sh
./target/release/rotor -m bsgs --coordinator http://127.0.0.1:7878 --token my-secret \
  --range 400000000000000000:7fffffffffffffffff \
  02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```

The client rebuilds the baby table deterministically, fetches `{manifest, giant_index}`, and continues the giant walk from that index when `TableManifest::compatible` accepts it. Progress is posted every 5 s and once on exit, so a restarted client resumes where it stopped; a different table identity is rejected with `409 manifest mismatch`.

### API

`/api/v1/*` requires `Authorization: Bearer <token>` (401 otherwise); `GET /` serves the dashboard without a token, and the dashboard polls `GET /api/v1/status` every 2 s.

| Route | Method | Purpose |
|---|---|---|
| `/` | GET | dashboard HTML/JS |
| `/api/v1/jobs` | GET / POST | list jobs / create a job (201) |
| `/api/v1/lease` | POST | lease the next free chunk (200; 204 when exhausted) |
| `/api/v1/heartbeat` | POST | refresh a lease; 409 when the lease was lost |
| `/api/v1/result` | POST | submit a found key; the proof is checked first |
| `/api/v1/status` | GET | jobs, active clients, results, BSGS checkpoints |
| `/api/v1/bsgs/state` | GET / POST | read (`?job_id=...`) / store `{manifest, giant_index}` |

### Security

- The token is mandatory (`--token` or `ROTOR_COORD_TOKEN`, coordinator and clients) and
  compared in constant time.
- The coordinator binds `127.0.0.1:7878` by default and warns when bound elsewhere.
  There is no TLS: put it behind a TLS-terminating reverse proxy for remote clients.
- The dashboard keeps the token in `localStorage`; state is one JSON file (`--state`,
  default `coordinator.json`) rewritten atomically (`tmp` + rename), one process per file.
- Heartbeat `scanned`/`done` values are trusted from any holder of the shared token: the
  protocol is single-tenant and has no per-client attestation beyond the token. A client
  can therefore mark its leased chunk done without proving the scan.
- Request bodies are capped at 1 MiB (413 beyond it) and concurrent request handlers at
  32 (503 beyond it); an API request with a missing/wrong token still gets 401.

### Limitations

- Address/xpoint GPU clients (`-g --coordinator`) are supported; GPU BSGS (`-m bsgs -g`)
  is rejected because coordinator BSGS is the CPU path. `-r` (random) and `-n`
  (checkpoints) are rejected with `--coordinator`, and one GPU per client is used.
- No accounts, roles or quotas — one shared token.
- Multi-target jobs (`addresses`/`xpoints`) stop at the first confirmed key: the job is
  marked found and the remaining targets in that job are not searched.
- An expired lease can be re-leased while its owner scans the chunk's tail, so that
  slice may be scanned twice (the client aborts the chunk on the first failed heartbeat).
  For GPU clients the limit is `lease_ttl × device rate` per chunk: a wider chunk cannot
  be heartbeated mid-scan and may livelock around an expiring lease.
- BSGS `giant_index` is monotonic and bounded by the job's last giant step; an
  out-of-range index is rejected instead of marking the job done.
- Coordinator BSGS is one giant walk per job; there is no multi-GPU scheduling.
- The whole JSON state is rewritten on every mutation; it targets a handful of clients,
  not thousands.

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

Release assets: `rotor.exe` is the CPU build; `rotor-gpu.exe` is the GPU build
(static CUDA runtime, so only the NVIDIA driver is required). Each ships with a
`.sha256` file in `<lowercase hash>  <name>` format, which is what `--update` verifies.

Implemented in Rust:

- `-c/--check` self-check (secp256k1 vectors, address/WIF pairs)
- `-m address` / `-m addresses` for BTC (compressed/uncompressed/both), multi-threaded
- `-m xpoint` / `-m xpoints` (32-byte X targets)
- `-m address` / `-m addresses` for Ethereum (keccak160)
- `-m bsgs` CPU baby-step/giant-step (pubkey → scalar), manifest identity
- `--bsgs-work` CPU-BSGS work files (offline resume of the table and giant index)
- `-m bsgs -g` GPU-BSGS behind `--features gpu` (`-l` lists CUDA devices)
- `-r` random mode with `-n`/`-z` bit-range selection
- `-n` checkpoint files (`Rotor-Cuda_Continue.bat` / `Rotor-Cuda_START.bat`)
- `--check-update` / `--update` self-update on Windows (WinHTTP + SHA-256,
  assets `rotor.exe` / `rotor-gpu.exe` and their `.sha256`)
- headerless `.bin` targets (20-byte hash160 / 32-byte xpoint records, sorted internally)
- `Found.txt` block format and progress line of the C++ binary
- `--benchmark` key-rate measurement of the selected backend (human or JSON)

### Benchmark

`--benchmark` measures the selected backend on a synthetic, guaranteed-miss
range: the target is key 1 while scanning starts at `0x100000000` and ends at
`0xFFFFFFFFFFFFFFFFFFFFFFFF` (2^96 - 1, below the curve order), so the benchmark
can never find a key and no backend can exhaust the range before the timer.
`seconds` is the actual scan wall clock, not the requested duration. Backend
options (`-g`, `-t`, `-m address|xpoint`, `--coin`, `-u/-b`) select what is
measured; multi-target, BSGS and coordinator modes are rejected.

```sh
rotor --benchmark                         # CPU, 5 s
rotor --benchmark --benchmark-seconds 10  # CPU, 10 s
rotor --benchmark -t 4 --benchmark-json   # JSON on stdout, nothing else
rotor --benchmark -g                      # GPU build: measures the GPU path
```

Human output:

```
BENCHMARK    : CPU
THREADS      : 8
DURATION     : 5.02 s
SCANNED      : 26,589,184
RATE         : 5.30 Mk/s
```

`--benchmark-json` prints one object instead:

```json
{"backend":"CPU","threads":8,"seconds":5.02,"scanned":26589184,"keys_per_second":5296749.0}
```

Remaining gap: GPU address/xpoint search is single-GPU and rejects `-r`/`-n`
loudly; multi-GPU scheduling is deferred. The C++ binary still covers GPU
multi-GPU runs.

Known deviations from the C++ binary:

- `-g` without a GPU build exits with code 2 (C++ prints the same message but continues).
- `.bin` inputs are sorted internally; the C++ binary requires a pre-sorted file.
- CPU-BSGS uses the full 256-bit range span and rejects spans above `u128`.
- The CPU target prefilter is a binary fuse8 at ≥1024 records and the classic
  Bloom below that; the exact binary search always decides membership.
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
