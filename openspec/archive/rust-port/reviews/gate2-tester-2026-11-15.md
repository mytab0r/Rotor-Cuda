# Gate #2 report - rust-port - 2026-11-15

VERDICT: PASS

GATE #1: PASS - proposal has Goal/Scope/Constraints/Acceptance; design records chosen and rejected approaches with rationale (D2 vs k256, D3 vs SSE batching, D4 vs clap) plus explicit deviations; tasks are grouped by dependency streams; delta-spec scenarios are testable.

GATE #2 (commands run from D:/Claude/Rotor-Cuda; release binary target/release/rotor.exe):

PASS 1. cargo test -> exit 0, 9 suites, 69 tests, 0 failed. cargo clippy --all-targets -- -D warnings -> exit 0, no warnings. cargo fmt --all -- --check -> exit 0.
PASS 2. CLI: no args -> exit 0 usage; -h -> exit 0; -v -> exact line "Rotor-Cuda v2.0-rotor  mytab0r"; -l -> exit 0; -g -> "GPU code not compiled, use -DWITHGPU when compiling." exit 2; -m address --range 1:2 without target -> exit 1, "Error: address mode requires exactly one address operand".
PASS 3. -m address --range 1757756A90:1757756A95 -o <tmp>/found.txt 14iXhn8bGajVWegZHJ18vJLHhntcpL4dex -> exit 0; one block: Priv (HEX): 1757756A93, PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255; separator line length 86 of "=".
PASS 4. -m bsgs --range 3E8:13E7 02E37648435C60DCD181B3D41D50857BA5B5ABEBE279429AA76558F6653F1658F2 -> exit 0, "====> KEY FOUND: 4D2", output line "<pubkey> 4D2". Out-of-range k=5096 pubkey 02E593D7B0D7B33145EA2019EAF0F48DF5B6E8C81280A27EF0686B5B6A13725D5F -> exit 1, "Not found in range.".
PASS 5. 37-byte file with -m addresses --range 1:10 -i -> exit 1, "Error: target file bad37.bin has 37 bytes, which is not a multiple of the 20-byte record length".
PASS 6. xpoint X=79BE667E...F81798 --range 1:2 -> exit 0, block with Priv (HEX): 1 and address 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH. ETH 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf --range 1:2 -> exit 0, block with Priv (HEX): 1 and PubK (HEX), no Priv (WIF) line.
PASS 7. Temp cwd, -m address --range 1:2 -n 1 -> exit 0, Rotor-Cuda_START.bat has 4 lines (":loop " / command / "goto :loop " / blank). Continue.bat with 7-line layout and count 5, rerun --range 1:A on key-5 address -> exit 0, "Continuing search from BAT file", Global start 6, key 5 not found (empty output file). Temp dir removed.
PASS 8. Repo root free of Found.txt and Rotor-Cuda_*.bat; git status unchanged (README.md modified plus expected untracked src/tests/Cargo/openspec entries).
PASS extra. rotor -c -> exit 0, "Checked successfully".

Unmet acceptance criterion: none among the eight required scenarios.
Not exercised: proposal BSGS puzzle #71 range 400000000000000000:7fffffffffffffffff (degenerate m about 2.1e9 baby entries, infeasible in this review window); small-range BSGS fixture passed.
Archive hygiene defects (non-blocking for the binary, fix before archive): tasks.md leaves section 0 START.bat, section 2 range helpers and section 7 acceptance checkboxes unchecked although done; README "Rust CPU port" still says checkpoint resume files are not implemented, while scenario 7 proves they are.
