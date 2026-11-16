# Rotor coordinator deployment

The coordinator is a single Rust binary (`rotor-coord`) that serves the JSON API
and the dashboard. It has no database: state is one atomically rewritten JSON
file in `/data`.

## Linux binary (systemd)

CI publishes `rotor-coord-linux-x86_64` (and its `.sha256`) on every release
tag. Install it with a dedicated user and the unit from this directory:

```sh
sudo useradd --system --home /var/lib/rotor --shell /usr/sbin/nologin rotor
sudo install -d -o rotor -g rotor /opt/rotor /etc/rotor /var/lib/rotor
sudo install -m 0755 rotor-coord-linux-x86_64 /opt/rotor/rotor-coord
sudo install -m 0644 deploy/rotor-coord.service /etc/systemd/system/
sudo install -m 0640 -o root -g rotor deploy/rotor-coord.env.example /etc/rotor/rotor-coord.env
# edit /etc/rotor/rotor-coord.env: ROTOR_COORD_TOKEN=<openssl rand -hex 32>
```

### Client tokens

With `--clients FILE` every client gets its own bearer token; the file maps the
client id to the SHA-256 of that token (lowercase hex). The token itself never
lives on the server, only its hash:

```sh
mkdir -p /etc/rotor
jq -n \
  --arg a "$(printf '%s' 'rig-a-secret' | sha256sum | cut -d' ' -f1)" \
  --arg b "$(printf '%s' 'rig-b-secret' | sha256sum | cut -d' ' -f1)" \
  '{ "rig-a": $a, "rig-b": $b }' | sudo tee /etc/rotor/clients.json
sudo chmod 0640 /etc/rotor/clients.json
```

Run the client with the raw secret (`--token rig-a-secret`); the server hashes
what is presented and looks it up, so the id cannot be spoofed through the
request body. Without `--clients`, the coordinator keeps the legacy single-token
mode and prints `WARNING: single-token mode; clients are not individually
authenticated` at startup.

- Admin token (`ROTOR_COORD_TOKEN`): create/list jobs and read the dashboard.
- Client token: lease, heartbeat, result, BSGS progress and status; it cannot
  create jobs, and the admin token cannot lease.

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now rotor-coord
curl -s -H "Authorization: Bearer $ADMIN" http://127.0.0.1:7878/api/v1/status
```

The unit binds `127.0.0.1:7878`; terminate TLS in front of it (Caddy example
below). Clients then use `https://...` directly — the `rotor` client speaks
HTTPS with the system TLS stack (SChannel on Windows, OpenSSL on Linux).

### Caddy (HTTPS)

`deploy/Caddyfile.example` is a two-line site block: replace the host name and
reload Caddy. Keep the coordinator on loopback or a private network; only the
proxy should be reachable from the internet.

### Docker image

`ghcr.io/mytab0r/rotor-coord:latest` is built by
`.github/workflows/coordinator-image.yml` on every push to `main`. The host runs
Watchtower with `--label-enable`, and the compose file sets
`com.centurylinklabs.watchtower.enable=true`, so a new image is pulled and the
container restarted automatically (default interval 300 s).

## First deploy

```sh
mkdir -p /opt/rotor-coord/data
cd /opt/rotor-coord
cp /path/to/deploy/docker-compose.yml .
cp /path/to/deploy/.env.example .env
# edit .env: ROTOR_COORD_TOKEN=<openssl rand -hex 32>
docker compose up -d
curl -s -H "Authorization: Bearer $TOKEN" http://127.0.0.1:7878/api/v1/status
```

The container joins the existing `stack_edge` network so a reverse proxy
(Zoraxy) can reach it as `rotor-coord:7878`.

## Reverse proxy (Zoraxy)

Add a host rule through the Zoraxy API (form fields, CSRF header required after
logging into `/api/auth/login`):

```sh
curl -b jar -X POST -H "X-CSRF-Token: $CSRF" \
  --data-urlencode "type=host" \
  --data-urlencode "rootname=rotor.pxbt.app" \
  --data-urlencode "ep=rotor-coord:7878" \
  --data-urlencode "tls=false" \
  --data-urlencode "enableUtm=false" \
  --data-urlencode "access=default" \
  http://127.0.0.1:8000/api/proxy/add
```

Cloudflare already proxies `*.pxbt.app`; Zoraxy matches the Host header on
ports 80/443. `tls=false` keeps the origin hop plain HTTP (Cloudflare terminates
client TLS); enable TLS in Zoraxy with a certificate if the origin is reached
directly.

## State and backups

- File: `/opt/rotor-coord/data/coordinator.json` (atomic tmp+rename).
- Format version 2 (packed bitmap). A state file from an older version is
  rejected with an explicit error; there is no migration yet — move the old file
  aside and start a new one.
- Size: completed chunks are a bitmap — about 2 hex characters per byte of
  bitmap; 1M chunks is roughly 250 KiB plus a small lease list.
- Backup: copy the file (it is always a complete JSON); restore by putting it
  back and restarting.
- Chunks are leased in a scattered (seeded full-cycle permutation) order, so
  progress is spread across the range while every chunk is covered exactly once.

## Security

- Bind is `0.0.0.0` inside the container; the compose port is not published to
  the host, so only the proxy network reaches it. The systemd unit binds
  `127.0.0.1` directly.
- Per-client tokens (`--clients`): the server stores only SHA-256 hashes and
  compares them in constant time; an unknown token gets 401. The admin token can
  manage jobs but cannot lease, and a client token cannot create jobs.
- Each lease carries `lease_id` and 16 challenge offsets. A `done` heartbeat
  must include the hashes of the keys at those offsets; wrong or missing samples
  return 400 and the chunk stays leased (BSGS is exempt). Leases and results
  with a stale nonce get 409.
- Rate limit: 20 requests/s per token with a burst of 40, then 429 with
  `Retry-After: 1`.
- Use HTTPS at the proxy (Cloudflare/Zoraxy/Caddy); tokens over plain public
  HTTP are not acceptable. The client binary supports `https://` natively.
- Request bodies are capped at 1 MiB and the lease nonces/samples stop casual
  forged progress; they are not a proof of full chunk coverage.
