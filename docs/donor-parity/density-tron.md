# Density parity: `/private-keys/tron`

Measured on 2026-11-21 with `scripts/density-parity.mjs` (headless Chrome
131, DevTools protocol, one page load per viewport plus one user-agent retry on
the donor at 375px). This is a measurement document, not a redesign: no UI
change is implemented in this PR.

- Donor: <https://privatekeyfinder.io/private-keys/tron>
- Ours: `http://127.0.0.1:7915/private-keys/tron` (release
  `target/release/rotor-coord`, commit `70ed68d`)
- Raw report: [`density-tron.json`](density-tron.json)
- Command:

  ```sh
  node scripts/density-parity.mjs \
    --donor https://privatekeyfinder.io/private-keys/tron \
    --ours http://127.0.0.1:7915/private-keys/tron \
    --json docs/donor-parity/density-tron.json
  ```

## Donor accessibility

The donor loaded from this machine. Both desktop viewports answered HTTP 200
and rendered all 60 rows, but the document never reached `readyState=complete`
inside the 45s navigation ceiling (it stays `loading`, most likely a long-lived
analytics/stream connection). The script measured the rendered DOM after the
ceiling and recorded `loadTimedOut: true` in `attempts`; the row count and block
geometry were already final. At 375x812 the first navigation failed with
`net::ERR_CONNECTION_RESET`; the script retried once with a normal desktop
Chrome user agent, which reached `complete`, and recorded both attempts. No
other headers were changed and no anti-bot protection was bypassed.

The donor reports `data-bs-theme="light"` and ignores `prefers-color-scheme`;
our page follows the OS and rendered dark. Block geometry is theme-independent,
so the comparison below uses each page's default rendering.

## Definition used

- **Chrome height**: document top to the top of the first data row
  (`.key-row` on both sides). This is where the first useful row starts.
- **Visible rows**: rows intersecting the viewport at scroll 0.
- **Controls**: `a[href]`, `button`, `input`, `select`, `textarea`, `summary`,
  `[role=button]` that the browser renders; `in viewport` is the above-the-fold
  count.
- **Density ratio**: `(ours visible rows / 1000px chrome) / (donor visible rows
  / 1000px chrome)`. `0.00` means no row reached the fold.
- **Block gap**: distance from the previous block's bottom to this block's top,
  in document coordinates. A fixed header is not counted as a previous block.

## Measured run (1440x900, dark/donor-light)

| side | chrome | rows visible/total | row height | controls in viewport/all | document height | title font | stat font | table-header font |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| donor | 544 | 6/60 | 65 | 45/167 | 4963 | 16 | 16 | 16 |
| ours | 903 | 0/60 | 163 | 42/468 | 11036 | 15 | 24 | 12 |
| delta | **+359** | **-6** | **+98** | -3 | **+6073** | -1 | +8 | -4 |

Our first data row starts at 903px, three pixels below a 900px fold. The owner's
report ("chrome and zero data rows") is exactly what the instrument measures.

All three viewports:

| side | viewport | chrome | rows visible | row height | controls in viewport | document height |
|---|---|---:|---:|---:|---:|---:|
| donor | 1440x900 | 544 | 6 | 65 | 45 | 4963 |
| ours | 1440x900 | 903 | 0 | 163 | 42 | 11036 |
| donor | 1280x800 | 544 | 4 | 65 | 41 | 4963 |
| ours | 1280x800 | 903 | 0 | 163 | 42 | 11036 |
| donor | 375x812 | 695 | 2 | 86 | 37 | 6523 |
| ours | 375x812 | 1200 | 0 | 229 | 36 | 15324 |

Density ratio at 1440x900: donor 6 rows / 544px = 11.03 rows per 1000px of
chrome; ours 0 / 903 = 0.00. Ratio **0.00**. Document height is 2.22x the donor
at desktop and 2.35x at 375px.

## Block delta at 1440x900

| block | donor top/h | ours top/h | height delta (ours - donor) | gap delta | note |
|---|---:|---:|---:|---:|---|
| header | 0 / 56 | 0 / 70 | +14 | - | ours is 70px sticky; donor 56px fixed |
| global search | 72 / 43 | absent | -43 | n/a | donor has an extra search trigger before the breadcrumb; we do not |
| breadcrumb | 131 / 63 | 96 / 44 | -19 | +10 (26 vs 16) | ours is shorter but starts 26px below the header |
| chain chips | 210 / 48 | 158 / 96 | **+48** | +2 (18 vs 16) | 18 chips wrap to two 44px rows; donor fits one 48px row |
| page header | 258 / 49 | 272 / 69 | +20 | +18 (18 vs 0) | ours pads 15/18/14 and gaps 10 between text and progress |
| pager | 307 / 58 | 359 / 149 | **+91** | +18 (18 vs 0) | ours renders the jump form as three lines (123px) beside the pager |
| search | 365 / 74 | 526 / 98 | +24 | +18 (18 vs 0) | ours adds a separate 19px hint line and 12/14 padding |
| stats | 439 / 42 | 643 / 197 | **+155** | +18 (18 vs 0) | ours = two 90px cards + 61px refresh row + 42px note; donor = two 42px cards |
| gaps total | 48 | 116 | +68 | - | raw totals; the donor's extra global-search block makes the per-block deltas non-additive |

The common-block height deltas sum to +333. Adding the donor-only global-search
block (-43) and the raw gap difference (+68) gives +358, within rounding of the
+359 chrome delta. The donor's extra global-search block partially offsets our
taller blocks; even so, we lose 359px.

## Prioritized change list

Ordered by pixels saved and risk. Every line names the code that owns the
value; none of these changes is implemented in this PR.

| # | change | saved | risk | anchors |
|---:|---|---:|---|---|
| 1 | Do not render the two WIF lines inside browse rows. The row keeps HEX + copy, address and balance; WIF stays on `/key/<hex>`, where it is key-level and matches the donor. This alone takes the row from 163px to ~60-65px (60 rows: ~5,900px of document height). | ~5,900px doc | medium: WIF is one click away on the key page; the browse row loses a duplicated representation | `apps/site/browse.js:305-322` (`renderKeyCell`), `apps/site/browse.js:345` (call), `apps/site/site.css:2555-2578` (`.col-key { flex-wrap: wrap }` + `.key-wif`), `src/coordinator/mod.rs:3401-3411` (server row) |
| 2 | Collapse the stats block to the two stat cards. The 61px refresh row and the 42px note become one compact status line (or the note moves to `title`/tooltip and refresh becomes an icon-only 44px control in the summary header). The remaining 48px above the donor is the design-system 90px card vs the donor's 42px card. | **107px chrome** | medium: keep the failed/stale refresh discoverable; do not turn it into a manual balance check | `src/coordinator/mod.rs:3500-3513` (cards), `src/coordinator/mod.rs:3547-3554` (refresh + note), `apps/site/site.css:1511-1566`, `apps/site/site.css:3851-3857` |
| 3 | Fix the jump-form width specificity. The generic `input:not(...)` rule sets `width:100%` and outranks `.page-jump input { width:150px }`, so the input takes the form's full 351px and pushes the button to a third line (123px). Use `flex: 0 0 150px` (specificity-independent) or a stronger selector; the row becomes one 44px line. | **81px chrome** | low: no content change, one form | `apps/site/site.css:1020-1025` (generic field width), `apps/site/site.css:1494` (`.page-jump input`), `src/coordinator/mod.rs:3532-3536` (markup) |
| 4 | Make the chain strip one 44px row with horizontal scroll at desktop and mobile, instead of wrapping 18 chips into 2 rows at 1440 (96px) and 7 rows at 375 (304px). The nav already uses this pattern at <=860. | **52px chrome desktop, 260px at 375** | medium: off-screen chains need the scroll affordance; do not shrink the 44px chip target | `src/coordinator/mod.rs:3369-3389` (tabs), `apps/site/site.css:1446` (`.chain-tabs`), `apps/site/site.css:1174-1228` (`.chip` grammar) |
| 5 | Fold the search hint into the input placeholder or a tooltip and reduce the panel padding/gap; one 44px input row remains. | ~30px chrome | low: the hint text is already repeated in the placeholder on the same page | `apps/site/site.css:1497-1505`, `src/coordinator/mod.rs:3538-3546` |
| 6 | Compact the page header: padding 15/18/14 -> 10/14/10 and the 10px inner gap -> 6px, keeping the 22px icon and 6px progress track. | ~14px chrome | low: no target change | `apps/site/site.css:1450-1455`, `src/coordinator/mod.rs:3520-3523` |
| 7 | Reduce the browse-page gap from 18px to 16px (six gaps). | 12px chrome | low: shared browse rhythm only | `apps/site/site.css:1429` (`.browse-page { gap: 18px }`), `src/coordinator/mod.rs:3515-3561` (browse page body) |
| 8 | Reduce the shared main top padding from 26px to 16px (all pages) or override it for `.browse-page`. This removes 10px between the sticky header and the breadcrumb. | 10px chrome | medium: global page frame; visual check on every route | `apps/site/site.css:906-922`, `src/coordinator/mod.rs:2007-2038` (`site_header`) |
| 9 | Reduce the shared header min-height from 70px to 56px (44px links + 6px top/bottom). | 14px chrome | medium: global header; brand and nav tools must stay centered | `apps/site/site.css:836-849`, `src/coordinator/mod.rs:2007-2038` (`site_header`) |

Cumulative estimate at 1440x900, applying #2-#9: 903 - 107 - 81 - 52 - 30 -
14 - 12 - 10 - 14 = **583px**, about 5 rows above the fold instead of 0. After
#1 the page height is about 5,150px, close to the donor's 4,963px. These are
estimates from measured block sizes; re-run the script after each change and
record the actual numbers in the PR.

## What not to copy

- The donor's stat value and table header are both 16px. Our design system
  requires stat values at 20/24/28 and table headers at 12px/600; keep our
  scale. The measured stat delta (+8px font) is a deliberate deviation.
- The donor has no page `<h1>`; its page header is a 16px strip. Our visible
  title is also a strip, while the SEO `<h1>` is visually hidden. Do not
  promote the hidden heading just to match a number.
- The donor's 43px global-search trigger is extra chrome we do not need on this
  page. Do not add it to win a parity table.

## Verification

The script is the gate for this document: it prints the table above and exits 0
when the report is produced, including the explicit unreachable-donor case. A UI
change that claims a density win must re-run it and paste the before/after rows
into the PR. `node scripts/ui-audit.mjs --serve` remains the correctness gate for
the page itself.
