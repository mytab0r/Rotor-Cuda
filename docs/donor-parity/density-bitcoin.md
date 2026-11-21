# Density parity: `/private-keys/bitcoin`

Follow-up to the `/private-keys/tron` measurement and PR #218. Measured on
2026-11-22 with `scripts/density-parity.mjs` (headless Chrome, DevTools
protocol, one page load per viewport plus one user-agent retry on the donor at
375px).

- Donor: <https://ref-site-a/private-keys/bitcoin>
- Ours: `http://127.0.0.1:7915/private-keys/bitcoin` (`target/release/rotor-coord`)
- Base commit (before): `23b6b61` (merge of PR #218)
- After: this PR's branch (`density/private-keys-bitcoin`), same binary/service
  recipe as `.claude/skills/donor-reverse/SKILL.md`
- Raw reports:
  [`density-bitcoin-before.json`](density-bitcoin-before.json) and
  [`density-bitcoin.json`](density-bitcoin.json)
- Command (same for both runs; only the served revision differs):

  ```sh
  node scripts/density-parity.mjs \
    --donor https://ref-site-a/private-keys/bitcoin \
    --ours http://127.0.0.1:7915/private-keys/bitcoin \
    --json docs/donor-parity/density-bitcoin.json
  ```

## Donor accessibility and row model

The donor loaded from this machine and rendered all 60 rows. As with TRON, the
document never reached `readyState=complete` inside the script's 45s navigation
ceiling (the response streams slowly); the script measured the rendered DOM and
recorded `loadTimedOut: true` at desktop. At 375px the first navigation hit
`net::ERR_CONNECTION_RESET` and the one normal-user-agent retry reached the
render; both attempts are recorded.

**The donor's client-side derivation never completed here.** A separate
DevTools probe waited 200s after `readyState=complete` (reached at ~85s);
every row still read `Calculating...` and the row height stayed 65px. Its
post-derivation address count therefore could not be observed and is not
invented. What was measured, and what its shipped CSS declares:

| aspect | donor measurement / source |
|---|---|
| row height (placeholder state) | 65px at 1440x900 and 1280x800, 86px at 375x812 |
| row cells | 3 children: `.col-key` (h 23), `.col-address` (h 21), `.col-balance` (h 21) |
| addresses shown while unresolved | one `.col-address` container with one line (`Calculating...`); no `<details>`, `summary`, `aria-expanded`, tooltip or second row inside the row |
| key-cell copy | yes: `<button class="copy-btn" title="Copy">`, 28x28, `opacity:0` until row hover |
| row CSS | `.key-row { grid-template-columns:1.6fr 0.9fr minmax(200px,auto); padding:.6rem 1rem; font-size:.8rem }` |
| balance CSS | `.col-balance { white-space:nowrap }`; `.col-balance .balance-info+.balance-info { margin-top:.15rem }` (one packed line per address when resolved) |
| block order | header, global search (donor-only), breadcrumb, chips, page header, pager, search, stats |

The fallback cited for the unresolved part is the donor's established row
model in `docs/donor-parity/directory-pages.md` plus the measured DOM/CSS above:
three cells, one visible address line, one balance line per address, a real
key-copy action. The donor row is 65px, not the 131px our BTC rows used to be.

## Before / after (ours) and donor column

`rowH` is the script's median across all 60 rows. Before, derivation was still
arriving during the script's 1.2s settle, so the median mixes skeletons and
resolved rows; the settled first-row heights from a separate CDP probe are in
the note below the table. After, the row model is stable inside the settle.

| viewport | side | BTC row height | chrome | visible rows | document height | density ratio |
|---|---|---:|---:|---:|---:|---:|
| 1440x900 | donor | 65 | 612 | 5 | 5052 | 1.00 |
| 1440x900 | ours before | 106 (settled 131) | 750 | 2 | 7413 | 0.33 |
| 1440x900 | ours after | **61** (settled 56-61) | **746** | **3** | **4754** | **0.49** |
| 1280x800 | donor | 65 | 612 | 3 | 5052 | 1.00 |
| 1280x800 | ours before | 115 (settled 131-135) | 778 | 1 | 8451 | 0.26 |
| 1280x800 | ours after | **61** (settled 56-61) | **746** | **1** | **4754** | **0.20** |
| 375x812 | donor | 86 | 851 | 0 | 6763 | - |
| 375x812 | ours before | 191 | 1414 | 0 | 13255 | - |
| 375x812 | ours after | **146** | **1394** | 0 | **10527** | - |

The donor's second run measured chrome 596 / 4 visible rows at 1280x800 (its
page height varies with the ad/search block); the table uses the first full run
for comparability.

CDP row-model check on ours (settled, 1440x900): before, the first three rows
were 131/135/135px with two 44px address lines; after, 57/57/57px with one 44px
address line, the disclosure button at 44x44 and the row growing to 102px only
while expanded. The 375px row is 146px rather than the donor's 86px because our
key copy and address copy stay at the 44px touch floor while the donor uses a
28px hover-revealed icon.

## Block delta at 1440x900 (after)

| block | donor top/h | ours top/h | height delta (ours - donor) | note |
|---|---:|---:|---:|---|
| header | 0 / 56 | 0 / 70 | +14 | ours is a 70px sticky header |
| global search | 72 / 43 | absent | -43 | donor-only block; not added |
| breadcrumb | 131 / 63 | 96 / 44 | -19 | ours starts 26px below the header |
| chain chips | 210 / 48 | 156 / 62 | +14 | one scrollable 44px row |
| page header | 258 / 49 | 234 / 56 | +7 | |
| pager | 307 / 58 | 306 / 70 | +12 | |
| search | 365 / 74 | 392 / 70 | -4 | |
| stats | 439 / 63 | 478 / 57 | **-6** | three level cards, 57px |
| chrome | 612 | 746 | **+134** | document is 298px shorter than the donor |

The remaining chrome gap is the 70px header (+14), the sticky header gap, and
the donor's extra global-search block (-43) partially offsetting our taller
breadcrumb/pager rows. Document height is now below the donor's.

## What changed

| # | change | evidence | risk / re-check |
|---:|---|---|---|
| 1 | BTC legacy row shows one address line; the uncompressed address and its balance line stay in the DOM in a 44px `aria-expanded` disclosure. Row 131 -> 56-61px at desktop. | `apps/site/browse.js` (`addressCellModel`, `addr-extra-toggle`, `balance-extra`), `apps/site/site.css`; CDP click test: collapsed 57px, expanded 102px, `aria-expanded` false/true, both links in the DOM. | The second address needs one click; expanding grows only that row. Covered by `browse-row-address-disclosure` and `browse-row-balance-split`. |
| 2 | The key-cell copy is a real 44px `.icon-button` (the donor has the same action at 28px). The `display:none` rule is gone, closing #220. | `apps/site/site.css`; ui-audit `browse-row-key-copy`; served-row assertion in `tests/coordinator_api.rs`. | Always visible instead of hover-only; 44px touch floor rather than the donor's 28px. |
| 3 | Balance column is 200px like the donor's `minmax(200px,auto)` with nowrap; the key link can shrink/ellipsize on narrow desktops so the copy button never wraps. | `site.css` grid columns at the browse row rule; measured balance line 38px (2 lines) instead of 58px (3 lines). | Checked 1024px: rows stay 56-61, key 429px, address 286px. |
| 4 | Browse stat cards use the 20px value step and a 200px note, so `Received` stays on one line; cards 87 -> 55px, bottoms equal at 1440 and 1280. | `site.css` `.balance-summary--browse`; CDP: bottoms 534/534/534 (spread 0) at both widths; ui-audit `browse-stat-level`. | 20px is the lowest value on the design scale; the donor's 16px is not copied. |

## Stat card heights

| viewport | before (card heights / bottoms) | after (card heights / bottoms) |
|---|---|---|
| 1440x900 | 87 / 87 / 87; value boxes 28 / **55** / 28 | 55 / 55 / 55; value boxes 23 / 23 / 23; bottoms 534 / 534 / 534 (spread 0) |
| 1280x800 | 87 / 87 / 87; value boxes 28 / **55** / 28 | 55 / 55 / 55; value boxes 23 / 23 / 23; bottoms 534 / 534 / 534 (spread 0) |

The three cards were already stretched to one height by `align-items:stretch`;
the visible defect was that the `Received` value wrapped to two lines and made
all three 87px. With the wrap gone the strip is 57px, and the new detector
asserts the bottoms, not just the flex stretch.

## Second address and dead copy evidence

DOM check (1440x900, settled, first row):

- primary address: `1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH` (visible, `(c)`)
- disclosed address: `1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm` (in `.addr-extra`, `display:none` until toggled)
- toggle: `.addr-extra-toggle`, 44x44, `aria-label="Show uncompressed address"`, `data-tooltip`, `aria-controls="addr-extra-<hex>"`, target exists, `aria-expanded="false"`
- expanded: `.addr-extra` and `.balance-extra` render, `aria-expanded="true"`, label flips to `Hide uncompressed address`; collapsed again returns the row to 57px
- key copy: `.col-key .copy-btn`, `display:grid`, 44x44, `aria-label="Copy private key"`, `data-tooltip="Copy private key"`, copied state handled by `copyText`

The Node test asserts the row model keeps both entries (`primary` + `extra`),
and the ui-audit checks both links in the DOM on every audited run.

## Deviations and not copied

- The donor's derivation never completed in the headless environment; its
  post-derivation address count is unobserved. The row model above is the
  measured placeholder DOM plus its shipped CSS, cited rather than guessed.
- The donor's key copy is 28px and hidden until row hover. Ours is an always
  visible 44px control, following the project touch-target rule.
- The donor stat value is 16px; ours is 20px, the lowest step the design system
  allows.
- The donor's 43px global-search trigger is extra chrome this page does not
  need; it is not added.
- Mobile keeps the 44px address/key actions, so its row is 146px against the
  donor's 86px. Shrinking them would fail `small-touch-target`.

## Verification

- `node scripts/ui-audit.mjs --serve` -> PASS across the default routes,
  375/768/1280 in both themes; the bitcoin run reports 60 rows, heights
  56/57/61 at desktop, no address/balance-split/copy issues and a 0px stat-card
  spread.
- `node scripts/ui-audit.mjs --base http://127.0.0.1:7915 --routes private-keys/bitcoin --viewports 375,1280,1440 --themes dark,light` -> PASS, 0 violations.
- The density script produced the tables above; the raw JSON is committed next
  to this file.
- Screenshots: [`screenshots/`](screenshots/) — `bitcoin-1440-{dark,light}.png`,
  `bitcoin-1280-{dark,light}.png`, `bitcoin-768-{dark,light}.png`,
  `bitcoin-375-{dark,light}.png` and `bitcoin-1440-dark-expanded.png`.
