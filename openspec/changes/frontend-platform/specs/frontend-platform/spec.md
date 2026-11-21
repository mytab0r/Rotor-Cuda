# frontend-platform — delta specification

## Requirement: Split serving

The system SHALL serve public HTML pages from the static Astro frontend and
`/api/v1/*` from the Rust coordinator. After phase 6 the coordinator SHALL NOT
render public HTML.

### Scenario: SEO page without the API

- GIVEN the coordinator is stopped
- WHEN a client requests `/private-keys/bitcoin`
- THEN the page is served from the edge with status 200 and the same canonical
  URL as before the migration

### Scenario: HTML is not cached

- WHEN any HTML page is requested
- THEN the response carries `Cache-Control: no-store` or a revalidating policy
  and the current build id

## Requirement: WASM boundary

Derivation and signing SHALL run in the existing `rotor_wasm.wasm` built from
`crates/rotor-wasm`. The UI framework SHALL NOT implement cryptography, and
WASM SHALL be loaded only by pages that need it.

### Scenario: Presentation page loads no WASM

- GIVEN `/tools` is open
- WHEN the page has loaded
- THEN no request to `rotor_wasm.*.wasm` was made

### Scenario: Crypto output is unchanged

- WHEN a fixed phrase or key is derived on any migrated page
- THEN the address equals the value produced by the pre-migration page

## Requirement: Key never in the request path

A private key entered by the user SHALL NOT be sent to the server in the URL
path or query. The contract is `/key#<hex>`; the fragment is never transmitted.

### Scenario: Legacy key URL

- GIVEN a request for `/key/0000...0001`
- WHEN it is handled
- THEN the response is 301 to `/key#0000...0001` and the body contains no key

## Requirement: CSP and escaping

Every HTML response SHALL carry the Content-Security-Policy from the proposal.
First-party UI code SHALL NOT use `innerHTML` or `dangerouslySetInnerHTML`.

### Scenario: CSP present

- WHEN any HTML page is requested
- THEN `Content-Security-Policy` contains `default-src 'self'`,
  `frame-ancestors 'none'` and `object-src 'none'`

## Requirement: Dependency gate

`web/package-lock.json` SHALL be committed, installs SHALL use `npm ci` with
exact versions, and CI SHALL fail on `npm audit --audit-level=high`.

### Scenario: High-severity advisory

- GIVEN a dependency with a high-severity advisory
- WHEN CI runs
- THEN the audit job fails and the PR cannot merge
