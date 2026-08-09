# Tasks: chunked GPU-BSGS giant output

- [x] Replace one-shot exhaustive launcher call with bounded batch loop.
- [x] Preserve canonical-X fold, filter, exact map lookup, EC reverify, and immediate hit return.
- [x] Preserve fail-loud launcher/truncation/device errors and no CPU fallback.
- [x] Add/adjust self-test coverage for multiple host batches if practical without large runtime.
- [x] Run CPU regression, GPU self-test, CUDA compile, Windows build, and CLI smoke.
- [x] Update README with large-range chunking behavior and known limits.
- [ ] Archive change after all acceptance evidence passes.
