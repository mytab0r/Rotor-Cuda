# Acceptance evidence — rust-port (2026-11-15)

Environment: Windows 11, Rust 1.100.0, default toolchain
`stable-x86_64-pc-windows-gnu` (self-contained MinGW linker), GNU target.
No CUDA, no GMP, no Visual Studio required.

## Automated checks

| command | result |
|---|---|
| `cargo test` | green (see per-suite counts below) |
| `cargo clippy --all-targets -- -D warnings` | exit 0, no warnings |
| `cargo fmt --all -- --check` | exit 0 |

Verified suite counts (independent runs by the coordinator):
lib 5, cli 15, crypto 11, filter 7, engine 18, checkpoint 11, bsgs 9 — 0 failed
(76 tests). Engine tests cover address/addresses, xpoint/xpoints, ETH
single/multi, random-key generation bounds, stop-after-target, per-chunk
checkpoint resume (including old-format fallback), START.bat and input
validation.

`rotor -c` exits 0 and prints the C++ header plus the self-check lines
(Generator/Double/Add/GenKey, five P2PKH address/WIF pairs; the two P2SH pairs
and the bech32 pair are reported as skipped/not applicable).

## End-to-end (release binary)

1. README single-address example (key `1757756A93`):
   `rotor -m address --range 1757756A90:1757756A95 -d 0 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex`
   → found 1 key, `Priv (HEX): 1757756A93`,
   `PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255`,
   WIF `KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX6XciCX`.
2. CPU-BSGS, `[3E8, 13E7]`, target `k = 0x4D2`:
   `====> KEY FOUND: 4D2`, exit 0, output file line `<pubkey> 4D2`.
3. CPU-BSGS, `[20000000, 3FFFFFFF]`, target `k = 0x3FFFFFFF`: found `3FFFFFFF`
   in 114 ms wall clock (giant 23170, baby 23171).
4. BSGS not-found path: target outside range → exit 1, `Not found in range.`
5. Ethereum single address (`0x7e5f…5bdf`, key 1): block has `PubAddress`,
   `Priv (HEX): 1`, 128-hex `PubK (HEX)`, no WIF line; exit 0.
6. Xpoint single (X of G): BTC block with `Priv (HEX): 1` and the compressed
   address/WIF; exit 0.
7. Multi `.bin` modes: BTC hash160 (key 5) and ETH keccak (key 1) fixtures found
   by the engine tests.
8. Random mode smoke run (`-r 1 -t 2 --range 1:2`) prints `[R: n]` progress lines
   and rotates starts; the epoch threshold (1e9 keys) is covered by unit tests,
   not by a live end-to-end rotation.
9. Checkpoint mode (`-n 1`, temp cwd): `Rotor-Cuda_START.bat` is written with the
   exact 4-line format (line 2 = exe + args + trailing space). A subsequent run
   with `Rotor-Cuda_Continue.bat` count 5 prints
   `Rotor        : Continuing search from BAT file. Checkpoint created: ...`
   and does NOT find key 5 in range `1:A` (start shifted to 6).
10. Two-thread resume with the `threads: 2` / `chunks: 2,2` extension over
    `1:A`: both key 6 (chunk 0) and key 9 (chunk 1) are found, i.e. the old
    global-shift skip no longer happens.
11. Stop-after-target: single-address search over `1:FFFFFFFF` exits in 183 ms
    after finding key 1 instead of scanning the whole range.

## Performance (release, 4 threads)

Compressed-address scan of 33,554,432 keys (`--range 0:1FFFFFF`):
5.2–5.6 Mk/s total (~1.3 Mk/s per core). No SSE hashing is used; the C++ SSE
path is expected to be somewhat faster per core.

## Deviations (documented in design.md / README.md)

- `-g` without GPU support exits 2 instead of the C++ no-op.
- `.bin` records are sorted internally; C++ requires a pre-sorted file.
- CPU-BSGS uses the full 256-bit span and rejects spans above `u128`.
- BinaryFuse, Ethereum-specific negated-key retry, self-update and GPU are out
  of this change.
- The C++ README's WIF example is invalid Base58Check; the Rust output prints
  the canonical WIF.
