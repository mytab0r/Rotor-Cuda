# Gate #1 blockers — resolution

Change: rust-port. Source: reviews/analyze-2026-11-15.md (VERDICT: FAIL).

1. **Acceptance unbuildable without C++** — closed. proposal.md acceptance now uses
   in-repo vectors and self-verifying checks (recover k, verify k·G == target /
   hash160(pubkey) == target); `cargo test` needs no C++/GMP.
2. **Wrong Bloom hash** — closed. tasks.md §2 and design.md "Bloom" now say
   MurmurHash2 32-bit with `Bloom.cpp:256-301` evidence.
3. **GPU mechanisms attributed to CPU-BSGS** — closed. tasks.md §6 now describes
   FNV-1a/64 over the 32-byte X, `HashMap<u64,u32>`, exact EC re-check, single giant
   walk; DP/dpBits removed.
4. **Invented checkpoint artifact (`Rotor-Cuda.user`)** — closed. design.md lists only
   Continue.bat and START.bat with exact lines; START.bat generation added to tasks §0.
5. **`-l/--list` missing** — closed. tasks.md §0 includes `-l`; cli/main already parse it.
6. **M0/M1 cycle around `-c`** — closed. `-c` moved into §1 (crypto + selfcheck).

Minor items:
- `-g` no-op deviation is now explicit in design.md "Осознанные отклонения" #1.
- BinaryFuse deferral is explicit in tasks §2 and design.md deviation #4.
- Binary name: `rotor`, packaging may alias `Rotor-Cuda.exe` (design.md).
- Manifest tests are listed in tasks §6; acceptance in §7.

Re-run of gate #1 is not required for wording-only fixes; implementation gate (#2)
will re-check against the corrected tasks.
