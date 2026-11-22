# Tasks — edge privacy

## 1. Provider proxy Worker (done)

- [x] `deploy/cloudflare/provider-proxy/`: route allowlist for TronScan,
      TronGrid, TronStack, `RPC_ENDPOINTS` EVM JSON-RPC and Sun.io quote; no
      request parameter selects a URL.
- [x] Secrets added server-side from Worker bindings; never returned, echoed in
      an error or logged. Error bodies and upstream headers are discarded.
- [x] SSRF guard: HTTPS only, no URL credentials, port 443, no loopback,
      private, link-local, CGNAT or metadata host; redirects refused.
- [x] 5 s timeout, 16 KiB request cap, 2 MiB response cap, per-client and
      per-isolate global token buckets, 15 s public GET cache.
- [x] CORS only for `SITE_ORIGIN`; no wildcard. Optional `/edge` mount prefix.
- [x] No `console` call, no persistence, no client IP in a cache key; the
  per-client limiter uses a salted digest. A public request without
  `CF-Connecting-IP` is `400 missing_client_ip`; callers are never merged into
  one shared bucket.
- [x] Tests: allowlisted host passes (mocked fetch), non-allowlisted
      route/query rejected, key injected and absent from the response and
      errors, private IP rejected, oversized body rejected, 429 with
      `Retry-After`, CORS, shared secret, cache, timeout.

## 2. Coordinator (done)

- [x] `ServerOptions.edge_proxy_url` / `edge_proxy_secret`, off by default,
      read from `EDGE_PROXY_URL` / `EDGE_PROXY_SECRET`. A URL without a
      non-empty secret is a startup error.
- [x] `EdgeProxy` requires HTTPS and redacts the secret in `Debug`.
- [x] `tron_lookup` uses the Worker in edge mode; `tron_auth_headers` sends
      `X-Edge-Secret` and never the provider key.
- [x] Keep direct TronScan mode and `TRONSCAN_API_KEY` until the Worker is
      configured.
- [x] `respond_hidden` overrides tiny_http's `Server` banner on every response.
- [x] Tests: header selection, HTTPS requirement, secret not in `Debug`,
      no `Server`/`X-Powered-By` identity on public responses.

## 3. Documentation (done)

- [x] `docs/ops/privacy.md`: threat model, traffic model, tunnel, DNS,
      firewall, headers, Access, Logpush, route plan, retention, honest limits,
      owner checklist.
- [x] Worker README with the route table, secrets, deploy and limits.
- [x] `deploy/README.md` points at the proxy and the privacy doc.

## 4. Cloudflare account (owner)

- [ ] Create the tunnel, proxied CNAME and DNS-only audit; remove every origin
      `A`/`AAAA`.
- [ ] Firewall: default-deny inbound; coordinator on loopback/private network.
- [ ] Mount `rotor.pxbt.app/edge/*` to `rotor-provider-proxy`.
- [ ] `wrangler secret put` the provider keys and `EDGE_PROXY_SECRET`.
- [ ] Transform Rules: remove `Server`, `X-Powered-By`, `Via`.
- [ ] Cloudflare Access application for `rotor.pxbt.app/cabinet/admin*`.
- [ ] Disable Logpush for the site or minimize fields/retention.
- [ ] Set the coordinator `EDGE_PROXY_URL` / `EDGE_PROXY_SECRET` after a canary;
      then remove `TRONSCAN_API_KEY` from the origin environment.

## 5. Follow-ups

- [ ] `apps/site`: replace the direct `apilist.tronscanapi.com` calls in
      `browse.js`, `key.js`, `site.js` and `wallet.js` with `/edge/v1/tron/...`
      (keep `/api/v1/chain/tron/address` as the fallback). This is a site-area
      change with its own UI/JS tests.
- [ ] `src/coordinator/orders.rs`: route the TRON order poller through the
      Worker too; today it is a residual origin-to-provider connection.
- [ ] Add a detector that fails when the site source calls a provider host
      directly (after the site migration).
- [ ] Optional Tor/I2P mirror for the static site; it does not change the
      provider or origin model.
- [ ] If a hard global quota is needed, add a Cloudflare Rate Limiting binding
      or a Durable Object; the current buckets are per isolate.
- [ ] Verify the Sun.io quote path against the provider's current API before
      enabling `/v1/quote` (`SUNIO_QUOTE_PATH`).
- [ ] Harden the SSRF guard for IPv4-embedded IPv6 without `::ffff:` and for
      DNS names that resolve to a private address. Evidence: `safeUpstreamUrl`
      accepts `https://[::c0a8:101]/` (192.168.1.1) because the guard only
      matches `::ffff:`; `https://127.0.0.1.nip.io/` is a hostname the guard
      cannot classify without resolving it. Operator-only through
      `RPC_ENDPOINTS`, but a misconfigured endpoint becomes an internal probe.
      Add tests for both.
- [ ] Stream `readLimitedBody` and abort as soon as the body exceeds 16 KiB.
      Evidence: `request.text()` buffers the whole body before the
      `TextEncoder` length check, so a chunked POST without `Content-Length`
      consumes memory up to the platform limit before it is rejected. Reject
      on the declared length and on the running byte count while reading.
