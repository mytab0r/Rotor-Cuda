# Tasks: coordinator auth, challenges, deploy

## 1. Client tokens  (blocked by: —)
- [ ] `--clients FILE` (sha256 map), admin/client permissions, legacy warning;
      tests for 401/403 paths.
- [ ] Dashboard/job endpoints keep the admin token.

## 2. Lease nonce and completion samples  (blocked by: 1)
- [ ] `lease_id` + `offsets` on lease; heartbeat/result require the nonce (409).
- [ ] `done=true` with K samples verified by key derivation/hash per mode;
      failed samples leave the lease active; BSGS exemption documented.
- [ ] Tests: valid/wrong/missing samples, replay, single mark.

## 3. Rate limit  (blocked by: 1)
- [ ] Per-token token bucket (20/s, burst 40) → 429; tests.

## 4. Deploy  (blocked by: —)
- [ ] `ureq` + `native-tls` transport (http/https), Dockerfile libssl packages,
      real HTTPS client check against the public coordinator.
- [ ] `deploy/` systemd unit, env template, Caddy example, README (state size,
      backups, TLS).
- [ ] Linux `rotor-coord` release job in CI; local start/restart smoke.

## 5. Close-out
- [ ] fmt/clippy/test; README coordinator security section; archive; PR.
