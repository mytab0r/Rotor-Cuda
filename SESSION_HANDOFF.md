# Session handoff

## Start here

1. Work from WSL: `/home/test/Rotor-Cuda`.
2. Inspect `git status` before edits.
3. Read `PROJECT_STATE.md`, this file, `TESTING.md`, and active OpenSpec changes.
4. Keep build output out of commits.
5. Do not push until all gates pass and personal GitHub authentication is confirmed.

## Immediate next work

1. Finish `gpu-bsgs-boundary-hardening`.
2. Run clean GPU build:

```bash
wsl.exe -d Ubuntu -- bash -lc 'cd /home/test/Rotor-Cuda/Rotor-Cuda && rm -rf obj Rotor && mkdir -p obj/GPU obj/hash obj/bsgs && make gpu=1 CCAP=120 all'
```

3. Run CPU self-test with a complete, non-duplicated object list. Expected output is recorded in `TESTING.md`.
4. Run GPU self-test/smoke on RTX 5070. Add explicit `A == S`, `A == -S`, infinity, and DP infinity checks.
5. Remove `Rotor` and `obj/`.
6. Commit with OpenSpec change ID in message. Push only from WSL with personal token.

## Working tree facts

The latest clean CUDA build passed after restoring the missing header declarations and namespace structure. Remaining compiler output is pre-existing format warnings in `Rotor.cpp` plus CUDA internal-header warnings. This is compile evidence only; it does not prove device boundary correctness.

Current branch starts at `d936b07`. Boundary hardening is not committed. Do not reset it blindly; inspect the three modified BSGS files first.

## Build topology

`Makefile` compiles C++ with `g++` and `GPU/GPUEngine.cu` with `nvcc`. `GPUEngine.cu` includes `../bsgs/BsgsGpu.cu`. A manually assembled self-test link can create duplicate hash symbols or missing launcher symbols; prefer Makefile object lists or a carefully deduplicated command.

## Scope decisions

Already accepted:

- explicit GPU-BSGS backend;
- one GPU;
- bounded host batching;
- batch inversion;
- DP filter;
- internal kangaroo baseline;
- no silent fallback;
- no SOTA kangaroo K≈1.15 yet;
- no persistent/continuation DP in initial GPU-BSGS integration;
- no multi-GPU scheduling.

Future research must produce evidence before code. See `RESEARCH_BACKLOG.md`.

## Handoff failure traps

- Current shell may resolve `/home/test/Rotor-Cuda/Rotor-Cuda` through a mounted path. Confirm with `git rev-parse --show-toplevel`; the repository root is `/home/test/Rotor-Cuda`.
- Host directory `D:\magic\Documents\VSCode\Python\New` is unrelated.
- `nvcc` may be absent on host but present in WSL at `/usr/local/cuda/bin/nvcc`.
- `nvidia-smi` device evidence is not a build proof.
- Never copy secrets from `D:\magic\Downloads\BTC\rotor_smart_launcher.ps1`; rotate any exposed Telegram token.
