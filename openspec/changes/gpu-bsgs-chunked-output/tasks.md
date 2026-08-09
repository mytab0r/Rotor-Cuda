# Tasks: chunked GPU-BSGS giant output

- [ ] Replace one-shot exhaustive launcher call with bounded batch loop.
- [ ] Preserve canonical-X fold, filter, exact map lookup, EC reverify, and immediate hit return.
- [ ] Preserve fail-loud launcher/truncation/device errors and no CPU fallback.
- [ ] Add/adjust self-test coverage for multiple host batches if practical without large runtime.
- [ ] Run CPU regression, GPU self-test, CUDA compile, Windows build, and CLI smoke.
- [ ] Update README with large-range chunking behavior and known limits.
- [ ] Archive change after all acceptance evidence passes.
