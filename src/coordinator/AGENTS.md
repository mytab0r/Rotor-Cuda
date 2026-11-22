# Coordinator area (owner: coordinator)

Owns `src/coordinator/**`, `src/bin/rotor-coord.rs`, `tests/coordinator_*`.
Read `../../PROJECTS.md` first.

## Commands

```sh
cargo build --release --bin rotor-coord
cargo test --test coordinator_api --test coordinator_client
```

## Gotchas

- `src/coordinator/mod.rs:31-41` embeds the site with
  `include_str!`/`include_bytes!`. A missing/renamed `apps/site/` file is a compile
  error; site edits may require a coordinator rebuild.
- The served route list in `src/coordinator/mod.rs` is a contract. Changing it
  requires a matching site change and a `PROJECTS.md` update.
- Operator auth lives in `src/coordinator/admin.rs`: signed `rotor_admin` cookie
  (12 h, `Path=/cabinet/admin`), CSRF bound to the cookie nonce and the shared
  per-IP login limiter. `/cabinet/admin*` is gated in `handle` before SEO/static;
  the design gallery is `/cabinet/admin/design` and `/design` is retired (404).
- `/api/v1/*` and the state schema are covered by
  `tests/coordinator_api.rs`; update the spec under `openspec/specs/coordinator/`
  when they change.
- `state.rs` is large; keep persistence changes covered by tests.
- Do not edit `apps/site/**` here; hand site work to the site area.
