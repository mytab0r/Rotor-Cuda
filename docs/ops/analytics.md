# Traffic analytics

First-party, privacy-preserving page-view analytics for the Astro site. The
beacon lives in `web/src/scripts/analytics-beacon.js` and is loaded by
`web/src/layouts/SiteLayout.astro`; it is not part of the wallet app pages.
The collector is `POST /api/v1/analytics/collect`
(`src/coordinator/analytics.rs`), the dashboard is
`/cabinet/admin/analytics`, and the JSON behind it is
`/cabinet/admin/api/analytics`.

The goal is operational awareness: how many page views, when, which route
families, which countries, coarse device/browser split, and whether the
coordinator is approaching its concurrency cap. It deliberately cannot answer
"who" or count unique visitors; there is no identifier to count.

## What is collected (stored field by field)

Each accepted beacon increments exactly one **hourly aggregate bucket** in the
coordinator state file (`State::record_analytics`). Every field is a counter:

| Stored field | Source | Example |
|---|---|---|
| `views` | one per accepted beacon | `42` |
| `routes` | `path`, normalized to a fixed family | `{"/private-keys": 12, "/": 30}` |
| `countries` | `CF-IPCountry` header, two uppercase letters, else `unknown` | `{"US": 20, "unknown": 22}` |
| `devices` | coarse class derived server-side from `User-Agent` | `{"desktop": 30, "mobile": 12}` |
| `browsers` | coarse family derived server-side from `User-Agent` | `{"chrome": 25, "safari": 10}` |
| `referrers` | host part only of the optional `referrer_host` payload | `{"search.example": 5, "direct": 37}` |

Derived classes:

- Device: `desktop`, `mobile`, `tablet`, `bot`. Missing user agent counts as
  `bot` (real browsers always send one).
- Browser: `chrome`, `safari`, `firefox`, `edge`, `other`.
- Route families are a fixed allowlist. Dynamic routes fold into their hub
  (`/private-keys/<slug>` -> `/private-keys`, `/bitcoin-puzzle/<n>` ->
  `/bitcoin-puzzle`); anything else becomes `other`, so request input cannot
  grow the key space.
- Each per-bucket map is capped (64 keys including an `other` sentinel). The
  coordinator also keeps process-lifetime request counters (served requests,
  capacity rejections, in-flight requests) for the load panel; they reset on
  restart and are not written to the state file.

## What is not collected

- No cookies, `localStorage`, `sessionStorage`, IndexedDB or any other
  identifier. The collector never sets `Set-Cookie`.
- No raw IP address. The remote address is used only as an in-memory
  rate-limit key and is discarded with the request; it never reaches the state
  file or any response.
- No raw user agent. Only the derived device/browser classes are stored.
- No full referrer URL. The beacon sends the hostname only; paths and query
  strings stay in the browser. The server validates the host and stores it
  lowercased.
- No query string or fragment from the page path.
- No third-party script, pixel or analytics SDK. The beacon is a same-origin
  module with no imports.
- No per-visitor rows, sessions, funnels or cross-site identifiers. Buckets
  are aggregate-only and cannot be joined back to a person.

`navigator.doNotTrack === '1'` (and legacy `yes`/`msDoNotTrack`) makes the
beacon do nothing at all.

## Retention

- History is exactly **168 hourly buckets = 7 days**.
- The oldest bucket is dropped on every write and on startup, so a restart
  after downtime never resurrects expired data.
- Buckets live inside the coordinator state file. The first beacon after a
  start is persisted immediately; later writes are coalesced to at most one
  every 10 seconds, so a burst of page views cannot rewrite the state file per
  request. A graceful shutdown flushes any pending counters; a hard crash loses
  at most the last few seconds.
- Deleting the state file (or the `analytics` object inside it) clears all
  analytics without touching jobs, clients or orders.

## Reading the page

`/cabinet/admin/analytics` is behind the normal operator session (signed
cookie; a bearer token also works for the JSON). All times are UTC.

- **Today / Last 7 days** — calendar-day totals (today starts at 00:00 UTC;
  the week is today plus the previous six UTC days).
- **Views this hour / Last 24 hours** — the current partial hour and the
  rolling 24 hourly slots.
- **Hourly views** — an inline SVG sparkline of the last 24 slots. The
  caption names the peak hour and the 24-hour total.
- **Views/min (hour)** — current-hour views divided by minutes elapsed in the
  hour; responsive but noisy on a small site.
- **Views/min (24h)** — 24-hour views divided by 1,440; the stable trend.
- **Requests/min (process)** — all coordinator requests since process start
  divided by uptime minutes (includes API traffic, not only beacons).
- **In flight / Busy rejections** — handlers currently running against the
  32-handler cap, and requests refused with 503 because the cap was reached.
  A rising pair is the early warning the owner asked for.
- **Tables** — top route families, countries, device and browser split, and
  referrer hosts over the retained week. Shares are computed against the
  seven-day total.

Empty state: before the first beacon the page says so instead of rendering
empty tables. Error state: an expired session or failed request shows a
message and a retry action; nothing is invented.

The JSON endpoint returns the same numbers plus the raw `hourly`/`daily`
arrays and `coordinator` counters, for scripts.

## CORS and abuse control

Only these origins may call the collector cross-origin:

- `https://rotor.pxbt.app`
- `https://rotor-site-b8c.pages.dev`

Any other `Origin` is refused with `403` before the body is read. A missing
`Origin` (curl, same-origin navigation) is accepted. The beacon sends
`text/plain;charset=UTF-8` so `navigator.sendBeacon` needs no preflight;
`OPTIONS` is still answered for the allowed origins.

Rate limiting is a per-IP token bucket in memory: one request per second with
a burst of 60. Under a shared NAT the burst is the practical allowance. The
map is pruned when it grows, and the IP is never persisted.

## Operational caveats

- `CF-IPCountry` is trustworthy only when traffic reaches the coordinator
  through Cloudflare. Direct requests can spoof the header, so treat the
  country table as informational, never as a security signal.
- Device/browser classification is a heuristic over the user agent. An
  unlisted crawler may land in `desktop` or `other`.
- These are **page views**, not visitors. A reload counts again; without
  identifiers there is no de-duplication by design.
- The beacon only runs on Astro pages. Coordinator-served wallet/app pages do
  not load it, so their traffic appears only in the process request counter,
  not in the view tables.

## Verification

- `cargo test --lib coordinator::analytics` — normalization, classification,
  retention, aggregation, cardinality cap, CORS, malformed input and the
  no-IP/no-UA serialized-state assertion.
- `cargo test --test coordinator_api analytics_collector_is_cors_scoped_private_and_persisted`
  — HTTP behaviour plus the restart-persistence check.
- `npm --prefix web test` — the beacon's DNT guard, payload shape, transports
  and "no storage" assertion.
