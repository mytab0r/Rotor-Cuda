# Design: coordinator auth, challenges, deploy

## D1. Client tokens

- `--clients FILE` JSON: `{ "client-a": "<sha256 hex>", ... }`. The server hashes
  the presented bearer token and looks it up with a constant-time compare; the
  client id is the map key. Lease/heartbeat/result use this identity.
- Admin `--token`/`ROTOR_COORD_TOKEN` authorizes `/api/v1/jobs` (POST/GET) and
  `/api/v1/status` (the dashboard). A client token may also read status (nice
  for CLI clients); it may not create jobs.
- No `--clients` file: every request accepts the admin token as before
  (legacy); `rotor-coord` prints `WARNING: single-token mode; clients are not
  individually authenticated` at startup.

## D2. Lease nonce and challenge

- On lease: generate `lease_id: u64` (from the state RNG) and `offsets: [u32; K]`
  (K = 16, uniform in `0..chunk_width`, clipped to the chunk), store them with
  the lease.
- Lease response adds `lease_id` and `challenge_offsets`.
- `heartbeat` and `result` bodies add `lease_id`; mismatch → 409.
- `done=true` heartbeat adds `samples: Vec<Vec<u8>>` (K entries). The server
  derives `start + offset` as a key, computes the expected bytes by mode/coin
  (`hash160` compressed/uncompressed per job comp mode, 20-byte keccak for ETH,
  32-byte X for xpoint), and requires exact equality for every sample.
  BSGS jobs accept no samples and mark done with the nonce only.
- The chunk is marked done only after all samples verify; a failed set leaves the
  lease active (rate limit prevents brute-force retries).

## D3. Rate limit

A per-client token bucket in memory (20 req/s, burst 40, keyed by client id or
"admin"); excess → 429 with `Retry-After: 1`. Persisted state is not involved.

## D4. TLS client

`CoordinatorClient` uses `ureq` (blocking, one request per call) with the
`native-tls` feature: SChannel on Windows (no C toolchain needed locally),
OpenSSL on Linux (CI and the image). `http://` and `https://` URLs work; the
local in-process tests keep using plain HTTP. Dockerfile: build stage installs
`pkg-config libssl-dev`; runtime stage installs `libssl3`. The public
verification runs a real client against `https://rotor.pxbt.app` with a token.

## D5. Deploy package

- `deploy/rotor-coord.service`: `User=rotor`, `StateDirectory=rotor`,
  `ExecStart=/opt/rotor/rotor-coord --bind 127.0.0.1:7878 --state
  /var/lib/rotor/coordinator.json --clients /etc/rotor/clients.json`, env file
  for the admin token, `Restart=on-failure`.
- `deploy/rotor-coord.env.example`, `deploy/Caddyfile.example`
  (`reverse_proxy 127.0.0.1:7878`), `deploy/README.md`: install binary, create
  user/dirs, state size expectations (bitmap), backup by copying the atomic file.
- `.github/workflows/rust-release.yml`: add a Linux job building `rotor-coord`
  and publishing `rotor-coord-linux-x86_64` + `.sha256` on tags.

## D5. Tests

- `--clients` map: valid/unknown token, admin vs client permissions.
- Challenge: valid samples accepted; missing/wrong rejected; bit exactly once;
  nonce replay rejected; BSGS exemption.
- Rate limit: burst then 429.
- Legacy mode unchanged.
- Deploy files: parse the systemd unit (basic assertions) and ensure the binary
  starts with `--state` in a temp dir.
