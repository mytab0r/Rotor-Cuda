# Site area (owner: site-ui)

Owns `apps/site/**`. Read `../../PROJECTS.md` first.

## Commands

```sh
node --check apps/site/site.js apps/site/key.js apps/site/rotor-worker.js \
  apps/site/brainwallet.js apps/site/brainwallet-engine.js
node apps/site/worker-test.mjs apps/site/rotor_wasm.wasm
node apps/site/brainwallet-test.mjs apps/site/rotor_wasm.wasm
```

## UI gate

Any visible change must pass the shared audit (375/768/1280, dark/light):

```sh
node scripts/ui-audit.mjs --serve          # or --base http://127.0.0.1:7879
```

Violation IDs, thresholds and the "fix the class, not the page" rule are in
`.claude/skills/ui-self-review/SKILL.md`. Do not weaken a check to get green.

## Gotchas

- Every page and asset is a compile-time input of the coordinator:
  `include_str!`/`include_bytes!` in `src/coordinator/mod.rs:31-41`. Renaming or
  removing a file breaks `cargo build --bin rotor-coord`.
- Never add a `?v=` cache token to a page or script: HTML is served with
  `no-store` and references assets as `/a/<build>/<path>` (immutable); bare
  asset paths revalidate by `ETag`. `check-projects.mjs` rejects a returning
  token and `ui-audit.mjs` rejects a bare asset reference.
- `key.js` and `rotor-worker.js` load the wasm artifact through the build
  prefix (`window.RotorAssets.url('/rotor_wasm.wasm')`; a worker derives it
  from its own `/a/<build>/` URL). Do not hand-edit the wasm file; rebuild it
  from `crates/rotor-wasm` with `sh scripts/build-wasm.sh`.
- Served routes are fixed in `src/coordinator/mod.rs`; adding a page is also a
  coordinator change.
- `admin.html`, `admin.js` and `admin.css` belong to the operator cabinet and
  are served with `no-store`/CSP admin headers. They may not contain inline
  script or style, a secret, or a raw token; the login flow keeps the token only
  in the request body and reads the CSRF cookie afterwards.
- No secrets or account data in static assets.
