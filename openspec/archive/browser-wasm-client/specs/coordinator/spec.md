# Coordinator domain (delta)

## Modified behavior

### Requirement: embedded browser assets
The coordinator MUST continue to ship the site inside the single coordinator
binary. It MUST embed the browser worker and the wasm artifact (`include_str!`
for JS/HTML, `include_bytes!` for wasm) and serve them, without authentication,
with `text/html; charset=utf-8`, `application/javascript; charset=utf-8` and
`application/wasm` respectively. Source: `src/coordinator/mod.rs:30-36`,
`:397-411`, `:481-491`.

#### Scenario: wasm route
- GIVEN a release coordinator built after `scripts/build-wasm.sh`
- WHEN `GET /rotor_wasm.wasm` is requested
- THEN the response is 200 with `Content-Type: application/wasm` and a body
  equal to the embedded artifact

#### Scenario: missing artifact
- GIVEN `web/rotor_wasm.wasm` is absent at compile time
- WHEN the coordinator is built
- THEN the build fails loudly (`include_bytes!`); it MUST NOT serve a redirect,
  a 404 or a stale inline stub

### Requirement: no protocol change
The browser client MUST use the existing `/api/v1/jobs`, `/lease`, `/heartbeat`
and `/result` endpoints and the existing token, lease-nonce and challenge-sample
rules. No new browser-only protocol, CORS header or unauthenticated target
endpoint is added by this change. Source: `src/coordinator/mod.rs:452-479`.

#### Scenario: client-token identity
- GIVEN a request with a client bearer token and a body `client_id`
- WHEN `/lease` or `/heartbeat` is handled
- THEN the server uses the token identity and ignores the body value

### Requirement: browser-sized jobs are documented
Documentation MUST state that the default `chunk_width` (0x10000000) is sized
for native clients, and that browser-oriented jobs SHOULD use 2^20–2^22 with
`lease_ttl` 120–300. Source: `src/coordinator/state.rs:27-30`,
`web/app.html:88-91`.

#### Scenario: operator creates a browser job
- GIVEN an operator creates a job for browser participation
- WHEN they follow the docs
- THEN the job uses a chunk width that completes in seconds to a couple of
  minutes at the measured tab rate and has a TTL comfortably longer than a
  paused tab's resume path
