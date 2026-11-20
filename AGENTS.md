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

## UI/UX gate (all site changes)

- Before designing or changing a page/component, query the installed
  `ui-ux-pro-max` skill:
  `python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "<page or problem>" --domain ux`
  (use `--domain style`, `--domain icons` or `--stack html-tailwind` for
  specific questions). Apply its accessibility/touch/responsive rules.
- Data-heavy pages use compact tables/rows with icon-only row actions, not a
  grid of explanatory cards. Cards are for navigation, empty states and
  summaries only.
- Every icon-only action needs `aria-label`, `title`, a visible copied/active
  state and a >=44px touch target.
- Run the `ui-checklist` and verify 375/768/1280, light/dark, keyboard,
  reduced-motion and no horizontal overflow before claiming a UI fix.
- Run the automated gate before reporting done:
  `node scripts/ui-audit.mjs --serve` (or against a running coordinator).
  It checks all of the above plus small text/targets, unlabeled icon controls,
  duplicated address-type components, half-empty cards and manual balance
  controls. The failure table and the fix-the-class rule live in the project
  skill `.claude/skills/ui-self-review/SKILL.md`. A UI change with violations
  is not done; do not weaken the audit to get a green run.
- One control per purpose. Do not render the same filter twice (chips and a
  select, two toolbars of the same chips); do not let controls clip at any
  width; column sets and multi-column fact lists must end level (±2px).
- Never show a raw path where a label belongs: links and table cells render a
  human-readable text (numbers with thousands separators, page titles), with
  the path only in `href`/`title`.
- Independent review is mandatory: the author may not approve their own UI PR.
  A different agent (designer/`critic`) must open the built page at
  375/768/1280, screenshot it, and paste the computed geometry (clipped
  controls, column spreads, overflow) into the PR. Self-reported "audit
  passed" is not evidence.
- Any behaviour change updates the specs/docs in the same PR: the
  `docs/site-map` ledger and, for non-trivial changes, the matching
  `openspec/` change. Stale docs are a review blocker.

