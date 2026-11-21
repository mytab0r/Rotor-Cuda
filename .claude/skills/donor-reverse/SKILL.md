---
name: donor-reverse
description: "Reverse-engineer a donor page's density and decide what to change on the Rotor page. Use when the owner asks why ref-site-a (or another donor) is tighter, what fits above the fold, or what to add/remove/compact on the same kind of page. Produces a measured donor-vs-ours table, a per-block delta and a change list with pixel estimates. Measurement only; the UI change is a separate PR."
---

# Donor reverse-engineering and density parity

Do not answer "the donor is tighter" from a screenshot. Capture both pages at
fixed viewports, measure with `scripts/density-parity.mjs`, and turn the numbers
into a ranked change list. The instrument is the evidence; the change list is
the decision.

## 1. Fix the comparison

- One page kind on both sides: same route and state, for example donor
  `/private-keys/tron` vs ours `/private-keys/tron`.
- Viewports: `1440x900,1280x800,375x812` (the script default).
- Theme: the script defaults to one theme (dark) so a donor page is loaded once
  per viewport. Pass `--themes light,dark` only when the owner asks about both;
  that doubles page loads.
- Build and serve our side from the worktree:

  ```sh
  cargo build --release --bin rotor-coord
  ./target/release/rotor-coord \
    --bind 127.0.0.1:7915 --token density-token \
    --state "$TEMP/density/coordinator.json" \
    --monitor-state "$TEMP/density/monitor.json" \
    --monitor-interval 3600 \
    --monitor-rpc http://127.0.0.1:1 --monitor-btc-rpc http://127.0.0.1:1
  ```

  Confirm `GET /private-keys/tron` returns 200 before measuring.

## 2. Run the measurement

```sh
node scripts/density-parity.mjs \
  --donor https://ref-site-a/private-keys/tron \
  --ours http://127.0.0.1:7915/private-keys/tron \
  --json docs/donor-parity/density-<page>.json
```

The script is zero-dependency and uses the same headless Chrome/Edge CDP path as
`scripts/ui-audit.mjs`. It prints a compact table and writes the full JSON.
It reports per side and viewport:

- chrome height (document top to the first data row);
- visible rows and row height;
- interactive controls, rendered and above the fold;
- top, height, padding, margin, gap and row-gap of the named blocks;
- page-title, stat-value and table-header font sizes;
- document height and horizontal overflow.

Selectors are per side. If the markup changes, override them rather than
editing the script:

```sh
--rows-donor "table tbody tr" --rows-ours ".key-row"
--blocks-donor "header=nav.navbar,pager=.nav-bar,search=.search-bar"
--blocks-ours  "header=.site-nav,pageHeader=.page-info"
```

Never invent missing donor numbers. If the donor is unreachable (network,
anti-bot), the JSON marks `sides.donor.status` and gives the raw reason; the
script still reports our side. The one allowed retry is a normal desktop user
agent, once, recorded in `attempts`. Do not add headers, cookies or a proxy to
get around a block.

## 3. Read the report as a hierarchy

1. **Chrome height** decides whether anything useful is above the fold. Compare
   it first, then rows visible, then row height, then document height.
2. **Block deltas** explain the chrome difference. Use the block table, not a
   guess from a screenshot. A positive delta with a large height is the signal;
   an extra donor-only block (for example a global search trigger) offsets the
   comparison and must be stated.
3. **Font sizes** are evidence, not targets. Our design system is normative:
   stat values stay on 20/24/28, table headers stay 12px/600. Record a donor
   difference as a deliberate deviation instead of copying it.
4. **Controls and rows** show information density. More controls above the fold
   is not automatically better: a filter or action counts only if the page
   needs it.
5. **Density ratio** (`ours / donor` rows per 1000px chrome) is the one-line
   summary. `0.00` means no row reached the fold; it is a measured zero.

## 4. Produce the document

Write `docs/donor-parity/density-<page>.md` with:

- the exact command, URLs, commit and raw JSON path;
- the donor accessibility result (loaded, retried, or unreachable with reason);
- the full 1440x900 table, the all-viewport table and the block delta table;
- the density ratio and document-height ratio;
- the change list.

The change list is a table ordered by pixels saved and risk. Every row names:

- the change in one sentence;
- the chrome pixels saved (and document pixels, if the change affects rows);
- the risk and what to re-check;
- `file:line` anchors in `apps/site/site.css`, `src/coordinator/mod.rs` and the
  owning JS;
- the evidence (which measured block or child height produces the saving).

Finish with a cumulative estimate and an explicit "not copied" section.

## 5. Rules for the change list

- **Density and information over decorative spacing.** Removing a 40px note row
  or a wrapped form line beats shrinking a target below 44px.
- **Never copy a donor feature the page does not need.** A donor global search
  box, an extra stat, or a second filter is not parity if our page already has
  the control or does not use it.
- **Never break the design system to win a number.** 44px controls, 12px floor,
  the card/stat/table grammar and the audit IDs stay as they are.
- **Semantics first.** Fix a specificity bug (for example the jump input width)
  at its cause, not with `!important` on the page.
- **One change per commit.** A measurement PR contains no UI edits; an
  implementation PR contains the detector/evidence for each change.
- **Verify every change** with `node scripts/ui-audit.mjs --serve` and
  screenshots at 375/768/1280, then re-run `density-parity.mjs`.
- **Record before/after** rows from the same command in the PR. "Looks
  tighter" is not evidence.

## 6. Report back

Return the PR URL, the measured table, the donor accessibility result, the
change list with pixel estimates and every deviation from the plan. If a change
cannot be made without violating the design system, say so and leave it out.
