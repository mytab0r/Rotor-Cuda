# Rotor shared edge balance cache (Cloudflare Worker)

A small Cloudflare Worker that sits in front of public balance providers and
lets every visitor of the Rotor site reuse balances fetched by any other
visitor. It is an accelerator, not an authority: callers should still treat the
returned balance as public chain data and verify it with their own provider
when a decision depends on it.

Only public chain data crosses this worker: chain id, public address, balance,
unit and `fetchedAt`. No key, seed, WIF, xprv or keypair JSON is accepted,
stored or logged.

## Endpoints

### `GET /v1/balance?chain=<chain>&address=<addr>`

```json
{
  "chain": "btc",
  "address": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT",
  "value": 3000,
  "unit": "sats",
  "fetchedAt": 1763680000000,
  "source": "provider",
  "stale": false
}
```

- `source` is `provider`, `client` or `none` (no provider and no cached copy).
- `stale` is `true` when a cached copy was served while a provider refetch runs
  in the background, or when the provider failed and an older copy was used.
  In the failure case the body also carries `error: "provider_error"` (or
  `rate_limited`).
- Unknown chain or malformed address: `400 {error:"bad_chain"|"bad_address"}`.
- No provider configured for the chain (and no cached copy):
  `501 {error:"no_provider"}`. The worker never fakes data.
- `value` is a JSON number while it fits a JavaScript safe integer and a
  base-10 string above that. EVM wei routinely exceeds `2^53`, so callers must
  parse with `BigInt` when the value is a string.

### `GET /v1/balances?chain=<chain>&addresses=<csv>`

Batch form of the single endpoint, one chain per request, at most 60 raw
entries after trimming:

```json
{
  "chain": "btc",
  "unit": "sats",
  "balances": [
    { "chain": "btc", "address": "1BoatSLRHtKNngkdXEeobR76b53LETtpyT", "value": 3000, "unit": "sats", "fetchedAt": 1763680000000, "source": "provider", "stale": false }
  ]
}
```

- Addresses are normalized and deduped first-seen, so mixed-case duplicates
  cost one provider call; `balances` follows the deduped request order.
- Each successful item is shaped exactly like the single endpoint's body. A
  bad address becomes `{error:"bad_address"}` for that item (the raw input is
  never echoed), and a failed lookup becomes `{address, error}` for that item;
  neither fails the whole request (`rate_limited` also carries
  `retryAfterMs: 250`).
- Empty `addresses`: `400 {error:"bad_addresses"}`. More than 60 entries:
  `400 {error:"too_many_addresses", max:60}`. Unknown chain:
  `400 {error:"bad_chain"}`.
- The provider token bucket is per isolate (burst 8, refill 4/s), so a cold
  60-address batch resolves about the first eight items and returns
  `rate_limited` for the rest. Retry the remainder after a short delay.

### `POST /v1/report` — `{chain, address, value, fetchedAt}`

`204` when the hint is accepted, `400 {error:"invalid_hint", reasons:[...]}`
otherwise. Raw client balances are hints, never truth:

- the address must be valid for the chain, `value` a non-negative integer
  (number or decimal string, up to 2^256), `fetchedAt` an integer millisecond
  timestamp no more than 2 minutes in the future and no more than 24 hours old;
- unknown top-level fields are rejected;
- bodies containing key-shaped material (PEM private key, WIF, xprv/tprv/etc.,
  64-hex key, keypair/keystore JSON, mnemonic-like word runs) are rejected as
  `sensitive_material` and are never echoed or logged;
- hints are stored with `source: "client"` and a much shorter TTL than provider
  data, and they never replace a provider entry.

### `GET /healthz`

```json
{ "ok": true, "providers": { "btc": {"configured": true}, "tron": {"configured": true}, "eth": {"configured": true} } }
```

## Cache key and freshness

Every balance lives under one synthetic cache key, independent of the incoming
host or query ordering:

```
https://cache.internal/balance/<chain>/<address>
```

EVM addresses are lowercased; BTC bech32 is lowercased; base58 and TRON
addresses keep their case. Freshness comes from the stored `fetchedAt`:

| Entry  | Fresh TTL | Stale-serve window |
| ------ | --------- | ------------------ |
| provider | 60 s | 15 min |
| client hint | 15 s | 15 min |

- fresh: served immediately, no provider call;
- stale: served immediately with `stale: true`, refetched in the background
  via `ctx.waitUntil` (`stale-while-revalidate`);
- expired or missing: synchronous provider fetch; an expired copy is still
  served with `stale: true` plus `error` if the provider fails.

`caches.default` is per-colo and eventually consistent. A miss in one colo may
cause one provider call there; that is expected and bounded by the provider
limits below.

## Providers

| Chain | Adapter | Unit |
| ----- | ------- | ---- |
| `btc` | `https://mempool.space/api/address/<addr>`, `funded_txo_sum - spent_txo_sum` | sats |
| `tron` | `https://apilist.tronscanapi.com/api/account?address=<addr>`, `balance` | sun |
| any other configured name | JSON-RPC `eth_getBalance` against `env.CHAIN_RPCS[chain]` | wei |

`CHAIN_RPCS` is a JSON object supplied by name as a Worker secret/variable:

```json
{"eth":"https://rpc.example/eth","bnb":"https://rpc.example/bnb"}
```

Requests time out after 5 s. Per provider and per isolate there is a token
bucket (burst 8, refill 4/s), bounded concurrency (4), and one retry with
exponential backoff plus 50-100% jitter on `429`/`5xx`. These limits bound one
isolate; they are not a global quota. For global protection use a provider-side
key/quota or a Cloudflare Rate Limiting binding.

Each client IP also has its own token bucket (burst 120, refill 20/s, LRU
bounded at 5000 keys). `OPTIONS` and `GET /healthz` are exempt and
`/v1/balances` charges one token per address (at most 60). This is likewise
per isolate: a per-client safeguard, not a cross-isolate guarantee.

## Security model

- The worker is public and unauthenticated; it stores nothing user-specific.
- `GET` responses only contain the normalized public address and public balance.
  On validation errors the raw input is not echoed.
- `POST` scans the raw body for secret-shaped material before parsing; nothing
  that matches is cached, echoed or logged. Request bodies are never logged in
  full (the worker logs nothing at all).
- Client hints are range-checked, timestamp-checked, tagged `source: "client"`,
  given a shorter TTL, and can never overwrite provider data.
- No secrets live in `wrangler.toml`; `CHAIN_RPCS` is read from the environment
  and set with `wrangler secret put`.

## Deploy

```sh
cd deploy/cloudflare
npm test                                  # node --test, no dependencies
npx wrangler secret put CHAIN_RPCS        # paste the JSON map, then Ctrl-D
npx wrangler deploy
```

`wrangler.toml` sets `compatibility_date` and `main = "src/worker.mjs"`.
The Worker needs no bindings, KV or D1: `caches.default` is built in.

## Tests

```sh
cd deploy/cloudflare
npm test
npm run check        # node --check on every .mjs file
```

The suite is network-free. Pure logic (`src/chains.mjs`, `src/hint.mjs`,
`src/cache.mjs`, `src/limiters.mjs`, `src/security.mjs`) is tested directly;
the fetch handler is tested with stubbed `caches.default` and `fetch`.

## Deliberately out of scope

- Authentication and a global (cross-colo) rate limiter. The per-client bucket
  is per isolate, like the provider bucket.
- Persistence: there is no KV/D1/DO storage; the cache is the platform edge
  cache and may disappear at any time.
- Historical balances, USD pricing and chart data.
- Testnet chains: BTC validation is mainnet-only because mempool.space is.
- Rewriting or proxying the provider responses beyond the fields above.
