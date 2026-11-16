# Tasks: chunked GPU-BSGS giant output

- [ ] Replace one-shot exhaustive launcher call with bounded batch loop.
- [ ] Preserve canonical-X fold, filter, exact map lookup, EC reverify, and immediate hit return.
- [ ] Preserve fail-loud launcher/truncation/device errors and no CPU fallback.
- [ ] Add/adjust self-test coverage for multiple host batches if practical without large runtime.
- [ ] Run CPU regression, GPU self-test, CUDA compile, Windows build, and CLI smoke.
- [ ] Update README with large-range chunking behavior and known limits.
- [ ] Archive change after all acceptance evidence passes.

## Resolution 2026-11-16

Superseded by the Rust port: `src/gpu.rs`/`src/bsgs.rs` launch giant walks in
bounded batches (`n_walks`, `max_hits`, truncation reported as an error) and the
Rust binary is now the maintained implementation. The legacy C++ tree is kept as
a reference and is not changed here. Archived without the C++ edits.
