# Site area (owner: site-ui)

Owns `web/**`. Read `../PROJECTS.md` first.

## Commands

```sh
node --check web/site.js web/key.js web/rotor-worker.js
node web/worker-test.mjs web/rotor_wasm.wasm
```

## Gotchas

- Every page and asset is a compile-time input of the coordinator:
  `include_str!`/`include_bytes!` in `src/coordinator/mod.rs:31-41`. Renaming or
  removing a file breaks `cargo build --bin rotor-coord`.
- Bump `?v=` in all `web/*.html` when `site.css`, `site.js` or `key.js` change.
  Keep pages on the same version.
- `key.js` and `rotor-worker.js` load `/rotor_wasm.wasm`. Do not hand-edit the
  wasm file; rebuild it from `crates/rotor-wasm` with `sh scripts/build-wasm.sh`.
- Served routes are fixed in `src/coordinator/mod.rs`; adding a page is also a
  coordinator change.
- No secrets or account data in static assets.
