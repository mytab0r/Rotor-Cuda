# Browser client domain

## Requirements

### Requirement: scan parity with the native client
The browser wasm worker MUST scan the inclusive leased window in ascending key
order and MUST match targets exactly as the native CPU path does: X coordinate
for `xpoint`/`xpoints`, RIPEMD-160(SHA-256(pubkey)) for BTC address modes (both
compression settings when `comp_mode = "both"`), and the last 20 bytes of
Keccak-256 for ETH. Key 0 MUST be counted as scanned and MUST NOT produce a
match. Source: `src/engine.rs:1200-1260`.

#### Scenario: fixture found
- GIVEN a fixed key inside the leased window and a job targeting its address
- WHEN the browser worker scans the window
- THEN it reports the found key as 64 lowercase hex characters and a
  `POST /api/v1/result` with the live `lease_id` is accepted

#### Scenario: window edges
- GIVEN a window whose start is 0 and a `chunk_width` of 8
- WHEN the worker scans all 8 keys
- THEN it counts 8 keys, does not panic, and finds the fixture key when
  targeted

### Requirement: completion samples
A `done: true` heartbeat MUST be sent only after the whole leased window is
scanned, and it MUST carry exactly one sample per `challenge_offsets` entry in
the same order. Samples MUST be produced from `chunk_start + offset` in the
same wire form as `challenge_samples` (X bytes, ETH address, or hash160;
compressed for `comp_mode = "both"`). Source: `src/coordinator/state.rs:1494-1567`.

#### Scenario: wrong sample
- GIVEN a fabricated or reordered sample list
- WHEN the worker sends `done: true`
- THEN the coordinator answers 400 and the chunk is not marked done; the worker
  reports an error instead of retrying the same payload as done

#### Scenario: partial scan
- GIVEN the worker has scanned fewer keys than the window span
- WHEN a heartbeat is due
- THEN it sends `done: false` with the cumulative scanned count

### Requirement: lease lifecycle
The worker MUST refresh the lease at least every 5 s, MUST send cumulative
`scanned` (never a per-interval delta), MUST carry a stable per-tab `client_id`
in lease/heartbeat/result bodies (required in legacy admin-token mode, ignored
when the server derives identity from a client token), and MUST treat 409 as a
lost lease: discard the cursor and request a new chunk. A 204 response means no free
chunk or a finished job, so the worker MUST re-check `GET /api/v1/jobs` and stop
if found/done; a 404 means no matching job; a 401 means an invalid token;
a 429 MUST back off per `Retry-After`. Source: `src/engine.rs:642-668`,
`src/coordinator/chunk_loop.rs:68-202`, `src/coordinator/mod.rs:622-705`.

#### Scenario: job finished during scan
- GIVEN a heartbeat or lease call fails because the job became found/done
- WHEN the worker re-checks `GET /api/v1/jobs`
- THEN it stops normally without a completion heartbeat

#### Scenario: result accepted
- GIVEN the worker submitted a found key and received 200
- WHEN the loop continues
- THEN it stops without sending a `done` heartbeat, because the server already
  closed the job and dropped the lease

### Requirement: pause and coordinator-side resume
While the tab is hidden the worker MUST stop scanning and MUST NOT send a
completion. On resume it MUST either continue the same lease after a successful
progress heartbeat or re-lease. The client MUST NOT persist scan state in
local files, IndexedDB or a checkpoint; job progress is derived from the
coordinator state. Source: `src/coordinator/state.rs:897-921`.

#### Scenario: hidden past TTL
- GIVEN the tab was hidden longer than the lease TTL
- WHEN it becomes visible
- THEN the progress heartbeat fails, the old cursor is discarded, and a fresh
  lease is requested; no completion is reported for the old chunk

### Requirement: measured rate and honest presentation
The page MUST display the rate measured in this tab (keys/s), the current chunk
progress, and an ETA derived from that rate. It MUST NOT promise a fixed total
time or a rate comparable to the GPU path. Source: `README.md:696`,
`README.md:435`.

#### Scenario: slow phone
- GIVEN a tab measuring 20k keys/s
- WHEN the page renders
- THEN it shows the measured 20k keys/s and an ETA based on it, not a native or
  GPU number

### Requirement: token handling
The worker MUST send the bearer token only in the `Authorization` header to
same-origin relative API paths. The token MUST NOT appear in a URL, log, DOM
text or error message. The page MUST refuse to start on an insecure
non-localhost context. Source: `apps/site/site.js:5-65`,
`src/bin/rotor-coord.rs:5-6`.

#### Scenario: insecure origin
- GIVEN an `http://` origin that is not localhost
- WHEN the page starts
- THEN it refuses to scan and explains that HTTPS is required
