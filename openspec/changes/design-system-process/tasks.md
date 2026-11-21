# Tasks — design-system process

## 0. Freeze

- [x] Write `design/tokens/tokens.contract.json` with the 95 current custom
      property names from the `:root` block of `apps/site/site.css` (plus the
      27 names the light block overrides).
- [x] Add a CI check that fails when a contract name disappears without a
      changelog line in `docs/design-system/DESIGN-SYSTEM.md` §9. Implemented
      as contract/JSON drift in `scripts/build-tokens.mjs --check`; the
      changelog-line condition is not machine-checked yet.

## 1. Tokens as data

- [x] Create `design/tokens/tokens.json` (W3C DTCG) mirroring the current
      primitive, semantic and component tiers, including the light-theme block.
- [x] Implement `scripts/build-tokens.mjs` writing the marked region in
      `site.css` and `design/generated/tokens.ts`; support `--check`.
- [x] Prove equivalence: compare computed styles of `/`, `/key`, `/cabinet/wallet`
      before and after generation.
- [x] Wire `node scripts/build-tokens.mjs --check` into `.github/workflows/ui.yml`
      before the audit; document the gate in `AGENTS.md` and
      `docs/process/self-checking.md`.

## 2. Token detectors

- [ ] `token-contract`: JSON token has a CSS declaration; every first-party
      `var(--x)` resolves; semantic and component tokens have consumers.
- [ ] `orphan-token` with 30-day grace or `"reserved": true`.
- [ ] `theme-parity`: each colour role has a light value.
- [ ] `radius-scale`, `raw-hex-outside-root`, `legacy-selector`.
- [ ] Ledger entries for each detector in `docs/process/defects.json`.

## 3. Component contracts and gallery

- [ ] `design/components/<name>.json` for button, icon-button, field,
      segmented, chip, status, card, stat, table, nav, breadcrumb, pager,
      empty, error, skeleton.
- [ ] `docs/design-system/components/<name>.md` from the fixed template.
- [ ] `scripts/check-components.mjs` (unknown variant/size, missing required
      attribute, page-local style for a shared family, missing gallery state).
- [ ] `scripts/build-gallery.mjs` producing `apps/site/design.html`; register
      the route in `static_asset`, the audit route list and `route-coverage`.

## 4. Review automation

- [ ] Pixelmatch visual regression inside `ui-audit.mjs`; baselines in
      `test/visual-baseline/`; regeneration via `workflow_dispatch` on ubuntu.
- [ ] Axe core injection; fail on serious/critical.
- [ ] `scripts/check-budgets.mjs` with per-route gzip budgets.
- [ ] Split `ui.yml` into a fast static job and a path-filtered render job with
      `concurrency: cancel-in-progress`.
- [ ] Stress fixtures and a `--states focus-visible` audit mode.

## 5. Route manifest

- [ ] Generate `apps/site/routes.json`.
- [ ] Switch `ui-audit.mjs` route discovery and `route-coverage` to it.

## 6. Process docs

- [ ] `docs/design-system/DESIGN-SYSTEM.md`: token pipeline, component page
      template, `audit-ids.json` as the single registry.
- [ ] `docs/process/self-checking.md`: visual diff and axe gates.
- [ ] `.claude/skills/ui-self-review/SKILL.md`: replace the duplicated violation
      table with a reference to the registry; add the design sign-off section.
- [ ] `AGENTS.md` and `apps/site/AGENTS.md`: visual change requires a signer who
      is not the author; gallery updated in the same PR.
- [ ] `CODEOWNERS` for `design/**` and `docs/design-system/**`.
- [ ] `docs/design-system/decisions.md` review log with the weekly slot.
