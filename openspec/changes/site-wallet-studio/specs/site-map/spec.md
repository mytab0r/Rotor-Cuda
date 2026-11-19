# site-map delta

## ADDED Requirements

### Requirement: canonical donor map
`/site-map` MUST serve one interactive map of Rotor routes against
ref-site-a and ref-site-b, with search, area and status filters,
and `ours` / `donors` / `matrix` views. Every Rotor route MUST show its donor
equivalent or `ours-only`; every donor route without a Rotor counterpart MUST
stay visible as `missing`. Route and feature data MUST live in one file,
`apps/site/site-map-data.js`, so a capability closes only when that data says
so. The page MUST NOT claim parity for a feature whose donor controls or data
are still absent.

#### Scenario: donor-only gap
- GIVEN a donor route with no Rotor equivalent
- WHEN the donor view or the matrix is opened
- THEN the route is visible with `missing` and its priority, and the summary
  counts it under missing

#### Scenario: status consistency
- GIVEN `apps/site/site-map-data.js`
- WHEN `node apps/site/site-map-test.mjs` runs
- THEN every donor reference resolves, every missing donor has no Rotor route,
  and every feature marked `rotor: missing` has status `missing`

### Requirement: responsive dense map
The map MUST render at 375, 768 and 1280 px without document horizontal
overflow, keep text at 12 px or larger, use 44 px icon actions with
`aria-label`s, and support the shared light and dark themes and keyboard focus.
Route rows are a dense list, not a card grid; the feature matrix is one table
with a horizontally scrollable wrapper and a visible narrow-screen hint.

#### Scenario: narrow screen
- GIVEN a 375 px viewport
- WHEN the page is opened
- THEN `document.documentElement.scrollWidth === clientWidth`, the filter
  controls stack, and the feature table scrolls inside its wrapper
