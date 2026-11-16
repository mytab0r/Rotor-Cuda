# Wasm core area (owner: wasm-core)

Owns `crates/rotor-wasm/**`. Read `../../PROJECTS.md` first.

## Commands

```sh
cargo build -p rotor-wasm --target wasm32-unknown-unknown --release
sh scripts/build-wasm.sh
cargo test -p rotor-wasm
node crates/rotor-wasm/smoke.mjs target/wasm32-unknown-unknown/release/rotor_wasm.wasm
node apps/site/worker-test.mjs target/wasm32-unknown-unknown/release/rotor_wasm.wasm
```

## Gotchas

- `scripts/build-wasm.sh` copies the artifact to `apps/site/rotor_wasm.wasm`. That
  committed file is embedded by the coordinator and served to the browser, so
  rebuild and commit it in the same change.
- Imports/exports are consumed by `apps/site/key.js` and `apps/site/rotor-worker.js`; keep
  the protocol stable or coordinate with the site area.
- Byte-level reproducibility of the committed wasm is not verified. Freshness
  is checked functionally: run both JS tests against the fresh artifact and the
  committed one.
- `Dockerfile` rebuilds the wasm during the image build; keep the script path
  and output target in sync.
