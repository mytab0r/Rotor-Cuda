# Agent rules

Area map: [PROJECTS.md](PROJECTS.md); machine-readable map: `projects.json`.

- Pick one area before editing. Only edit paths owned by that area.
- Before touching another area, read its contracts in `PROJECTS.md` and include
  both areas in one PR/commit. Cross-area changes are not "someone else's
  problem".
- Site change to `site.css`, `site.js` or `key.js`: bump `?v=` in every
  `apps/site/*.html`.
- `crates/rotor-wasm` change: run `sh scripts/build-wasm.sh`, run both JS
  tests, commit `apps/site/rotor_wasm.wasm`.
- Run the area test commands from `projects.json`; then
  `node scripts/check-projects.mjs`.
- Parallel writers: use a worktree under `.claude/worktrees/` per area/change.
  Do not share a working tree with another writer.
- New top-level files/directories must be added to an area in `projects.json`;
  the coverage check fails otherwise.
- Do not hand-edit generated artifacts (`target/`, wasm output) or add secrets.

Reading order: this file -> `PROJECTS.md` -> area `AGENTS.md` -> `openspec/`.
