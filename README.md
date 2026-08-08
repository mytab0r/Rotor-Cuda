# Rotor-Cuda (mytab0r fork)

Maintained by **mytab0r** — https://github.com/mytab0r/Rotor-Cuda

A secp256k1 key-search tool for **authorized public puzzle events** — known
addresses, known bit ranges, official rewards. It is **not** for mass scanning
or de-anonymization, and this fork is developed with that scope as a hard rule.

This fork descends from Mehdi256's Rotor-Cuda v2 and reuses code from KeyHunt
and VanitySearch (JeanLucPons). Licensed under **GPLv3.0**; original copyrights
are retained. Everything below marked as fork work is by mytab0r.

## What this fork adds

- **CPU BSGS — `--mode bsgs`** — recover the scalar of a **known public key**
  inside `--range START:END` with baby-step/giant-step over secp256k1. Baby
  table + binary-fuse fast-reject + EC re-verify. End-to-end recover-scalar
  test runs in CI on every commit. Use only when the pubkey is public
  (authorized puzzles).
- **GPU BSGS giant-step kernel (internal)** — device giant-walk with
  **batch modular inversion**: W independent walks sharing one stride fold
  their per-step inverses into a single `_ModInv` (Montgomery's trick). Proven
  on an RTX 5070 (sm_120) against a GMP ground truth — 65536 points, 0 mismatch
  — at up to x1.71 vs the scalar path. Not yet wired to the CLI; see
  `bsgs/BATCH_INVERT.md` and `bsgs/GPU_SMOKE.md` for evidence.
- **Filter catalog** — a binary-fuse filter alongside the classic bloom filter
  for large hash160 sets (lower false-positive rate at similar memory).
- **Self-update** — SHA-256 verified binary self-replace (WinHTTP + MoveFileEx
  rename-trick, Windows).
- **Cloud CI/CD** — the full Windows build (MSBuild + CUDA) and the release
  pipeline run entirely on GitHub Actions; no local toolchain is required.

Inherited from Rotor-Cuda v2 (upstream, not fork-authored): GPU search over
single/multi BTC & ETH addresses, sequential range and `-r` random modes.
These still work but are not the focus of this fork.

## CPU BSGS usage

Recover the scalar of a known compressed public key within a range:

```sh
./Rotor --mode bsgs   --range 400000000000000000:7fffffffffffffffff   02CEB6CBBCDBDF5EF7150682150F4CE2C6F4807B349827DCDBDD1F2EFA885A2630
```

- `--range START:END` — hex scalar bounds to search.
- The final positional argument is the target **public key** (compressed hex).
- `-r` random mode is rejected for BSGS: a BSGS run is non-resumable, so random
  section-hopping would silently skip work.

## Inherited GPU search (upstream Rotor-Cuda v2)

Single BTC address in a range:

```sh
./Rotor -g --gpui 0 --gpux 256,256 -m address --coin BTC   --range 400000000:7ffffffff 1PWCx5fovoEaoBowAvF5k91m2Xat9bMgwb
```

Multiple addresses from a `.bin` hash160 set:

```sh
./Rotor -g --gpui 0 --gpux 256,256 -m addresses --coin BTC   --range 400000000:7ffffffff -i Btc-h160.bin
```

ETH works the same with `--coin ETH`. If a weaker GPU crashes with an explicit
grid, drop `--gpux 256,256` and let it auto-assign. Build the `.bin` set with
the helper in `BinSort/` (see `BinSort/README.md`).

## Build

**Cloud (recommended):** push to the fork; GitHub Actions builds the Windows
x64 executable and publishes it as an artifact. No local compiler needed.

**Local Linux:**

```sh
sudo apt install -y libgmp-dev

# CPU-only
make all

# GPU — set CCAP to your card's compute capability
# (see https://arnon.dk/matching-sm-architectures-arch-and-gencode-for-various-nvidia-cards)
make gpu=1 CCAP=89 all    # e.g. SM_89 (RTX 40xx)
make gpu=1 CCAP=120 all   # SM_120 (RTX 50xx) — verified with CUDA 13.3
```

The GPU BSGS device code is compiled as a single translation unit (unity
include) to avoid duplicate-symbol link errors.

## License

GPLv3.0. Reused components (KeyHunt, VanitySearch / JeanLucPons, Rotor-Cuda v2
/ Mehdi256) retain their original copyrights.

## Disclaimer

All code and information here are for educational and authorized use only. Use
at your own risk. The developer is not responsible for any loss, damage, or
claim arising from use of this program.
