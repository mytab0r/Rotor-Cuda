# Agent rules

Area map: [PROJECTS.md](PROJECTS.md); machine-readable map: `projects.json`.

- Pick one area before editing. Only edit paths owned by that area.
- Before touching another area, read its contracts in `PROJECTS.md` and include
  both areas in one PR/commit. Cross-area changes are not "someone else's
  problem".
- Site assets carry no cache-busting query: never add a `?v=` token. HTML is
  served with `no-store` and references every first-party asset as
  `/a/<build>/<path>`; those URLs are immutable (the build changes on every
  deploy), while bare asset paths (old links, curl) stay `no-cache` with a
  content `ETag`. `node scripts/check-projects.mjs` fails if a token returns
  and `scripts/ui-audit.mjs` fails on a bare asset reference.
- `crates/rotor-wasm` change: run `sh scripts/build-wasm.sh`, run both JS
  tests, commit `apps/site/rotor_wasm.wasm`.
- Run the area test commands from `projects.json`; then
  `node scripts/check-projects.mjs`.
- Design tokens: `design/tokens/tokens.json` is the source. After editing it run
  `node scripts/build-tokens.mjs`; `node scripts/build-tokens.mjs --check` is a
  CI gate and fails when `apps/site/site.css` or
  `design/generated/tokens.ts` is stale. Never hand-edit the marked region.
- Parallel writers: use a worktree under `.claude/worktrees/` per area/change.
  Do not share a working tree with another writer.
- New top-level files/directories must be added to an area in `projects.json`;
  the coverage check fails otherwise.
- Do not hand-edit generated artifacts (`target/`, wasm output) or add secrets.

Reading order: this file -> `PROJECTS.md` -> area `AGENTS.md` -> `openspec/`.

## Single source of truth

Chain identity and public RPC/API endpoints have one machine source:
`data/chains.json` and `data/providers.json`. Do not copy a provider host,
explorer URL or chain identity into a page script.

- Generate the consumers with `node scripts/gen-ssot.mjs`:
  `apps/site/chains.generated.js` (`window.RotorChains`,
  `window.RotorProviders`) and `src/generated/chains.rs`.
- `node scripts/gen-ssot.mjs --check` fails when either output is stale.
- `node scripts/check-ssot.mjs` validates the data and fails when a first-party
  `apps/site/*.js` file contains a canonical provider/explorer host literal.
  Known textual exceptions live in `data/ssot-allow.json` (`file`, `match`,
  `reason`, `owner`, `expires`); the list is shrink-only and expired entries
  fail.
- The coordinator embeds and fingerprints `/chains.generated.js` and injects it
  into every served document before the page scripts. Node tests that load a
  migrated consumer call `require("./chains.generated.js")` first.
- Never hand-edit either generated file.

## Security alerts

- Code scanning alerts are triaged within one working day. `.github/workflows/codeql-alerts.yml`
  fails daily while any alert stays open, so an ignored alert turns the monitor red.
- Fix a real finding; dismiss a false positive only with `dismissed_reason` and a
  written comment naming the evidence (for example: deterministic test fixture
  inside `#[test]`, never used by production code). Never dismiss silently and
  never suppress a whole rule to clear a list.
- Production cryptographic values (keys, nonces, salts) come from the OS RNG or
  environment variables; only tests may use fixed vectors.

## UI/UX gate (all site changes)

- Before designing or changing a page/component, query the installed
  `ui-ux-pro-max` skill:
  `python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "<page or problem>" --domain ux`
  (use `--domain style`, `--domain icons` or `--stack html-tailwind` for
  specific questions). Apply its accessibility/touch/responsive rules.
- Data-heavy pages use compact tables/rows with icon-only row actions, not a
  grid of explanatory cards. Cards are for navigation, empty states and
  summaries only.
- Every icon-only action uses the shared `.icon-button` component with
  `aria-label` + `data-tooltip` (the tooltip primitive; no native `title` beside
  it), a visible copied/active state and a 44px touch target (28 only in a
  dense table row whose row is the target).
- Run the `ui-checklist` and verify 375/768/1280, light/dark, keyboard,
  reduced-motion and no horizontal overflow before claiming a UI fix.
- Run the automated gate before reporting done:
  `node scripts/ui-audit.mjs --serve` (or against a running coordinator).
  It checks all of the above plus small text/targets, unlabeled icon controls,
  duplicated address-type components, half-empty cards and manual balance
  controls. The failure table and the fix-the-class rule live in the project
  skill `.claude/skills/ui-self-review/SKILL.md`. A UI change with violations
  is not done; do not weaken the audit to get a green run.
- The design system is normative: `docs/design-system/DESIGN-SYSTEM.md` defines
  the token scales and component grammar, `inventory.md` records the baseline,
  and `plan.md` owns the migration order. New UI uses `--space-*`,
  `--radius-*`, `--text-*`, `--weight-*`, `--duration-*` and the semantic roles;
  do not add a literal radius, control height or font size outside the scale.
- One status/badge grammar: `.status` (aliases `.badge`, `.key-badges span`,
  `.puzzle-badge`, `.puzzle-status`, `.pz-pill`, `.ws-chain-status`,
  `.monitor-chain`, `.balance-refresh-count`) is 20px high, 12px text,
  `2px var(--space-2)` padding and pill radius. The audit ID is
  `status-pill-geometry`; never add a page-local pill.
- One field grammar: `label`/`.field` + `input`/`select`/`textarea` are 44 high
  (56 for `.field--hero`), radius 10 (16 hero), 12px label, focus ring and
  `[aria-invalid="true"]` error state. One `.segmented` track (4px pad, radius
  12, 44px items, exactly one `aria-pressed="true"`) and one `.chip` (44px,
  pill, `aria-pressed`/`aria-current`). Audit IDs: `control-height-scale`,
  `field-geometry`, `segmented-geometry`; never add a page-local control size.
- One card/stat grammar: cards pad 16/20/24, radius 12/16, no translateY hover;
  stat labels are 12px sentence case with no tracking, values are 20/24/28 and
  tabular. Audit IDs: `card-padding-scale`, `stat-geometry`; page-local card
  overrides (`.key-page > .card`) are not allowed.
- One table/row grammar: every table is `.data-table` inside `.table-scroll`,
  header 12/600 sentence case, cell padding `8/12`, row min-height 44, row
  actions at the trailing edge. Mobile keeps the scroll wrapper and all
  columns. Audit IDs: `table-grammar`, `table-header-style`,
  `table-row-height`, `row-action-geometry`.
- Do not add page-local `<style>` rules for a shared component. Move the rule
  into `apps/site/site.css` in the batch that owns the family
  (`docs/design-system/plan.md`); a new family needs an entry in
  `DESIGN-SYSTEM.md` and a detector or an explicit "not machine-checkable" note.
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
- Every defect gets a detector before it gets a fix: add or extend a check in
  `scripts/ui-audit.mjs` (or another gate), add an entry to
  `docs/process/defects.json`, and run `node scripts/check-defect-ledger.mjs`.
  A fix whose detector is missing is not done.
- Any behaviour change updates the specs/docs in the same PR: the
  `docs/site-map` ledger and, for non-trivial changes, the matching
  `openspec/` change. Stale docs are a review blocker.

