# Rotor coordinator deployment

The coordinator is a single Rust binary (`rotor-coord`) that serves the JSON API
and the dashboard. It has no database: state is one atomically rewritten JSON
file in `/data`.

## Image

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
  the host, so only the proxy network reaches it.
- The API requires a bearer token; do not expose the port publicly.
- Use HTTPS at the proxy (Cloudflare/Zoraxy); tokens over plain public HTTP are
  not acceptable.
