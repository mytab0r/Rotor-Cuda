# UI checklist (gate for web changes)

The site has no build step: plain HTML/CSS/JS in `apps/site/`, served by the
coordinator. Before calling a UI change done, walk this list and keep the
evidence (a screenshot or the DOM check below).

## Automated audit (required)

- [ ] `node scripts/ui-audit.mjs --serve` passes (exit 0) for the affected
      routes at 375/768/1280 in dark and light mode. Details and the violation
      table are in `.claude/skills/ui-self-review/SKILL.md`.
- [ ] If the change fixed a shared component, run the full default route set,
      not only the page you touched.
- [ ] If a genuine violation remains outside the change, name its exact ID in
      the PR; do not weaken the threshold in `scripts/ui-audit.mjs` or add a
      page-local bypass.

## Design system
- [ ] New UI uses the tokens and component APIs in
      `docs/design-system/DESIGN-SYSTEM.md`; the baseline and migration order
      are in `inventory.md` and `plan.md`.
- [ ] Spacing is on the 4px scale (`--space-*`); control heights are
      28/36/44/56; radii are 4/8/10/12/16/20/pill. No new literal values.
- [ ] Status/badges use one grammar: 20px high, 12px text, `2px 8px` padding,
      pill radius (`status-pill-geometry` in the audit).
- [ ] Fields use one grammar: 44px control (56 hero), radius 10 (16 hero), 12px
      label, visible focus ring and `aria-invalid` error state
      (`control-height-scale`, `field-geometry`).
- [ ] Segmented controls use `.segmented` with 4px track padding, radius 12,
      44px items and exactly one `aria-pressed="true"`; filters, presets and
      directory tabs use `.chip` (`segmented-geometry`).
- [ ] Cards use padding 16/20/24 and radius 12/16 with no translateY hover;
      stat labels are 12px sentence case and values are 20/24/28 with tabular
      digits (`card-padding-scale`, `stat-geometry`).
- [ ] Tables use `.data-table` inside `.table-scroll`; headers are 12px/600
      sentence case, cell padding is 8/12, rows are ≥44 and row actions sit at
      the trailing edge (`table-grammar`, `table-header-style`,
      `table-row-height`, `row-action-geometry`). Mobile keeps the scroll
      wrapper and all columns.
- [ ] Navigation uses one 44px link grammar with 18px icons and
      `aria-current="page"`; search/theme are `.icon-button` and the cabinet is
      a `.chip` (`nav-link-height`). No `.nav-pill` or one-off icon wrapper.
- [ ] Breadcrumbs are one `<nav class="breadcrumbs" aria-label="Breadcrumb">`
      with `.breadcrumbs__sep` separators and exactly one human
      `aria-current="page"` label (`breadcrumb-grammar`,
      `breadcrumb-current`). The landing page and app/cabinet shells have none.
- [ ] Pagers are `.pager` + `.pager-btn` (44px, radius 10,
      `aria-disabled` and `.pager-btn--random`), with one `.page-jump` form and
      one `.page-info-text` status line (`pager-grammar`, `pager-geometry`).
- [ ] Public content pages render exactly one `.site-footer` (FAQ, Disclaimer,
      Donate, Docs, GitHub, copyright, asset version); `/app`, `/run`, `/me`,
      `/cabinet` and `/cabinet/wallet` render none (`footer-presence`).
- [ ] No page-local `<style>` rule re-implements a shared component; move it
      to `site.css` in the batch that owns the family.
- [ ] Every icon-only action uses `.icon-button` (quiet/outline/solid,
      sm/md/lg) with `aria-label` + `data-tooltip`, a visible copied/active
      state and a 44×44 box (28 only in a dense table row); adjacent icon
      controls keep ≥8px gap.

## States
- [ ] Every async surface has loading, empty, error and success states with
      actionable text; a failed fetch never leaves a blank card.
- [ ] Busy controls are disabled and say what is happening; destructive or
      long actions have a visible Stop.
- [ ] Zero data is a deliberate message, not a bare table header.

## Layout
- [ ] No horizontal overflow at 375 px:
      `document.documentElement.scrollWidth === clientWidth`.
- [ ] Long mono values (addresses, keys, tokens) wrap inside cards.
- [ ] Tap targets are at least 44×44 px; the nav is usable at 375 px.
      The 44 px box must be the control's own element box: a `::before`
      overlay with a negative inset does not count (the audit measures
      `getBoundingClientRect`), so size icon buttons themselves.
- [ ] Breakpoints: 375 (phone), 768 (tablet), 1280 (desktop); check all three.

## Hierarchy and text
- [ ] One `h1` per page, section `h2`s, muted helper text for constraints.
- [ ] One primary action per card; secondary actions are visually quieter.
- [ ] Numbers have units (keys/s, %, seconds) and are not over-promised.

## Motion and accessibility
- [ ] Transitions are short (<=150 ms) and respect
      `prefers-reduced-motion`.
- [ ] Inputs have labels, focus is visible, and the flow works from the
      keyboard (start/stop, forms).
- [ ] Text contrast holds in the default dark theme; no text baked into images.

## Verification
- [ ] Open the page in the Browser pane at mobile and desktop sizes, check the
      console for errors, and re-read the empty state.
- [ ] For the browser worker: `node apps/site/worker-test.mjs` and a real lease on a
      local coordinator (done only after the full chunk).
- [ ] Changed `site.css` or `site.js`? Bump the `?v=` query in every page
      (`site.css?v=...`, `site.js?v=...`): Cloudflare caches those URLs for
      four hours regardless of the origin `Cache-Control`.
