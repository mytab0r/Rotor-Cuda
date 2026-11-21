---
name: ui-self-review
description: "Run the Rotor site UI audit before claiming a UI change is done. Use for any page/component/CSS/JS change under apps/site or the generated coordinator routes. Catches overflow, tiny text/targets, unlabeled icon controls, duplicated or uneven components, half-empty cards, manual balance controls and route parity regressions. Not for backend-only work."
---

# UI self-review (Rotor site)

The site review loop is deterministic. A UI change is not done until
`scripts/ui-audit.mjs` passes on the affected routes at 375/768/1280 in dark and
light mode. "The page looks fine at 1280 dark" is not evidence.

## 1. Query the design rules first

Before designing or restructuring a page, ask the installed UI/UX database for
the specific problem (one intent, 2–5 terms):

```sh
python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "<page or problem>" --domain ux
python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "icon button touch target" --domain icons
python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "dense data table rows" --stack html-tailwind
```

Apply the answer; do not paste generic guidance into the page.

## 2. Run the audit

```sh
# Reuse a coordinator already running on :7879
node scripts/ui-audit.mjs

# Build-free alternative: start target/release/rotor-coord on :7899
cargo build --release --bin rotor-coord
node scripts/ui-audit.mjs --serve

# Narrow loop while fixing
node scripts/ui-audit.mjs --serve --routes key,seed --viewports 375,1280 --themes dark
node scripts/ui-audit.mjs --serve --json .claude/ui-audit/report.json
```

On Git Bash, write route values without the leading slash (`--routes key,seed`):
MSYS rewrites a bare `/key` argument into a Windows path.

The script auto-detects Chrome/Edge (override with `CHROME_PATH`). It returns
exit 0 only when there are no violations, 1 on violations, 2 when the harness
itself cannot run. Screenshots and the JSON report are written under a temp
directory and printed at the end.

## 3. Read every violation

| ID | What it means | Fix at the right level |
|---|---|---|
| `horizontal-overflow` | `scrollWidth > clientWidth` | Fix the shared container/grid/`min-width` in `site.css`; never hide overflow with `overflow-x:hidden` as the fix. |
| `small-text` | visible text below 12px | Raise the shared type token/class (`.stat-label`, `.type-desc`, etc.), not one page's rule. |
| `small-touch-target` | control below 44x44 (inline prose links exempt) | Fix the shared icon-button/nav/pager primitive so every page inherits the size. |
| `unlabeled-icon-control` | icon-only button/link without `aria-label` | Add the label to the shared component or icon helper. |
| `icon-button-scale` | `.icon-button` box not 28/36/44 or icon not 14/16/18, or missing `aria-label`/`data-tooltip` | Fix the shared `.icon-button` sizes/variants; never restyle one page's copy button. |
| `control-height-scale` | input/select/chip/segmented height outside 28/36/44/56 | Fix the shared `.field`/`.segmented`/`.chip` geometry, not the page. |
| `field-geometry` | field radius not 10/16, label below 12px, or no focus ring | Fix the shared field grammar in `site.css`. |
| `segmented-geometry` | track padding/radius wrong, item under 44, or not exactly one selected | Fix the shared `.segmented` component; one control per purpose. |
| `card-padding-scale` | card padding outside 16/20/24 or radius outside 12/16 | Fix the shared card component in `site.css`; never restore a page-local `.key-page > .card` override. |
| `stat-geometry` | stat label under 12px/uppercase/tracked, or value outside 20/24/28 with non-tabular digits | Fix the shared stat grammar; use `.stat--sm` for small values. |
| `table-grammar` | table without `.data-table`/`.table-scroll`, cell padding not 8/12, or uneven header heights | Fix the shared table shell; never add a page-local table style. |
| `table-header-style` | header not 12px/600 sentence case, or uppercase/tracked | Fix `.data-table thead th`/`.keys-header` in `site.css`. |
| `table-row-height` | a row below 44px without a 44px action | Raise the shared row floor or add the row action. |
| `row-action-geometry` | row action not 44x44, radius 10, or unlabelled | Fix the shared icon-button/row action component. |
| `status-pill-geometry` | a status/badge pill outside the shared box: text <12px, height outside 18–32px, non-pill radius, or inline padding outside 6/8/10/12 | Fix the shared `.status`/`.badge` geometry in `site.css`; never restyle one page's pill. |
| `duplicate-address-type-implementation` | `.key-types`/`.key-btc-panel` and `.address-type-panel` both used | Unify on one address-type component and delete the other markup/CSS family. |
| `address-type-width-spread` | cards in one row differ by >15% | Fix the grid (`repeat(auto-fit, minmax(...))` or equal `1fr`) in the shared component. |
| `mostly-empty-block` | card/section taller than 220px is >45% empty | Rebalance the shared card layout, split the block, or remove the fixed height. |
| `manual-balance-control` | visible `Check balances`, `Check public balances`, `Online balance lookups`, `#check-balances`, `#seed-balances` | Balances must auto-compute from derived rows; delete the button/checkbox, do not restyle it. |
| `key-calculate-button` / `key-auto-derive` | `/key` needs an explicit action | Derive on input (debounced) and keep the form as the only control. |
| `seed-form-narrow` | `/seed` form uses ≤80% of the card width | Fix the shared seed form grid, not a page-local width. |
| `brainwallet-row-count` / `puzzle-row-count` | directory/home row count regressed | Restore the 60 / 160 row contract or update the audit deliberately with the change spec. |
| `site-map-still-served` | `/site-map` returns 200 | After the docs move it must 404; remove the route rather than hiding the link. |

Console errors are recorded as warnings, not failures. A warning still needs a
look when it comes from the page you changed.

## Thresholds (do not tune per page)

- **Touch target:** visible box below 44px in either dimension. Inline prose
  links are exempt (WCAG inline-text exception), and a checkbox/radio inside a
  label that is at least 44×44 inherits the label's hit area. The box is the
  control element itself: a `::before` overlay with a negative inset does not
  enlarge it for this check, so give the button/link its own 44×44 box and set
  the overlay to `inset: 0`.
- **Small text:** visible element with its own text below 12px. Hidden,
  `aria-hidden` and `visually-hidden` text is ignored.
- **Half-empty block:** `section`/`.card` taller than 220px where visible direct
  children cover less than 55% of the content box.
- **Address-type spread:** cards in one visual row differ by more than 15% in
  width.
- **Balance controls:** visible `#check-balances`, `#seed-balances`,
  `#online-toggle`, or the exact texts `Check balances`, `Check public
  balances`, `Online balance lookups`. Auto-balance checkboxes whose label says
  the rows are checked automatically are not flagged.
- **Row counts:** `/brainwallet/<chain>` = 60 rendered `.bw-row`;
  `/bitcoin-puzzle` = 160 `[data-puzzle-row]`.
- **Themes:** `Emulation.setEmulatedMedia` sets `prefers-color-scheme`; a page
  whose `data-theme` does not match the requested theme fails.

Shared chrome issues (for example 40px header links or 11px muted labels) are
expected to be fixed once in the header/typography token, not page by page.

## 4. Fix the class, not the page

- One bug seen twice becomes a component/token change in `site.css` or the
  shared JS helper. Do not add `body.<page> .card { ... }` overrides.
- Keep the address-type, row, badge, icon-button and card grammars identical
  across `/key`, `/private-keys/<chain>`, `/mnemonic-seeds/<chain>`,
  `/brainwallet/<chain>` and `/bitcoin-puzzle`.
- If a check is genuinely noisy, change the threshold in
  `scripts/ui-audit.mjs` together with a comment explaining the measurement,
  and say so in the PR. Never add a per-page bypass.
- Do not weaken row counts, balance-control checks or the `/site-map` 404 check
  to make a run green.

## 5. Re-run and report

1. Re-run the same route/viewport/theme matrix after the fix.
2. Run the area commands from `projects.json` (`node --check ...`, site tests)
   and `node scripts/check-projects.mjs`.
3. In the PR description include: the command you ran, the routes/viewports/
   themes covered, `ui-audit PASS` (or the exact remaining violation IDs and why
   they are outside the change), and the screenshot directory or attached
   before/after images. Do not paste the whole JSON report.

The audit is the gate. A visual check in the browser pane is additional
evidence, not a replacement.

## 6. Independent review and the defect ledger

- The author never signs off their own UI change. A second agent (`critic` or
  a dedicated reviewer) opens the built page at 375/768/1280 in both themes,
  screenshots the affected blocks, and pastes the computed geometry into the
  PR: number of controls outside their scroll container, column spreads,
  `scrollWidth/clientWidth`, and every remaining violation id.
- Every defect, whether found by the owner or by a reviewer, adds a check
  before it adds a fix: extend `scripts/ui-audit.mjs` (or another gate), add an
  entry to `docs/process/defects.json`, and run
  `node scripts/check-defect-ledger.mjs`. CI runs both on every PR
  (`.github/workflows/ui.yml`).
- A PR that only fixes the symptom without a detector and a ledger entry is
  incomplete, even if the snapshot looks right.
