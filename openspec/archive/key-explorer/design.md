# Design: private-key explorer

## D1. Architecture

```
web/key.html (input, rows, details, curve plot, presets)
  |  fetch /rotor_wasm.wasm (same artifact as the puzzle worker)
  v
crates/rotor-wasm  derive_report(priv32, curve) -> JSON report
  field/scalar/point/secp/hashes/base58 + bech32/bech32m + ed25519

optional, on "Check balances":
  mempool.space/api/address/<btc>      (chain_stats)
  1rpc.io/eth JSON-RPC eth_getBalance, eth_getTransactionCount
  (fallback order: publicnode, dRPC, 1rpc)
  apilist.tronscanapi.com/api/account?address=<tron>
```

The page never posts the private key anywhere. Derived addresses are public;
the first network request happens only after the visitor presses "Check
balances", and the UI states which providers are contacted.

## D2. Research facts

- `ref-site-a` derives addresses in `app.obf.js` (bundle contains
  secp256k1, bech32, taproot and ed25519 code) and queries balances through a
  `balance-checker.obf.js` bundle with public endpoints (1rpc/publicnode/drpc,
  Tronscan, XRPScan, BlockCypher, Haskoin, Tatum). Its server exposes a few
  narrow helpers (`/api/evm-activity`, `/api/vf`, `/api/wf`, `/api/xrp`).
- `ref-site-b/PrivateKeySegwit` computes step-by-step on its PHP backend
  (`calculators/segwit_new.php`, `action=start`) and gets the coin prefix list
  from `calculators/segwit_coins.json`; the browser only renders the JSON.
- CORS checked 2026-11-16: `mempool.space`, `1rpc.io` and
  `apilist.tronscanapi.com` answer with `Access-Control-Allow-Origin: *`, so no
  coordinator proxy is needed for v1.

Conclusion: client-side derivation (fast, private) plus opt-in client-side
balance lookups matches the first site's UX; expandable locally computed steps
replace the second site's server calculator.

## D3. WASM ABI extension (`crates/rotor-wasm`)

New exports (existing scan/set_job surface unchanged):

- `derive_report(priv_ptr: u32, curve: u32) -> u32`: `priv_ptr` is 32 big-endian
  bytes; curve 0 = secp256k1, 1 = ed25519. Returns 0 on success; the JSON report
  is available through `result_ptr()/result_len()`, errors through
  `error_ptr()/error_len()`.

JSON report (all string fields; empty when not applicable):

```
{
  "curve": "secp256k1" | "ed25519",
  "priv_hex": "<64 lowercase hex>",
  "priv_dec": "<decimal>",
  "priv_bin": "<binary>",
  "pubkey_compressed": "<66 hex>",
  "pubkey_uncompressed": "<130 hex>",
  "x": "<64 hex>", "y": "<64 hex>",
  "ed_pubkey": "<64 hex>",
  "wif_compressed": "...", "wif_uncompressed": "...",
  "addresses": [
    {"id":"btc_p2pkh","label":"Bitcoin legacy (compressed)","address":"...",
     "steps":{"pubkey":"...","hash160":"...","payload":"00...","checksum":"...","base58":"..."}},
    {"id":"btc_p2pkh_uncompressed","label":"Bitcoin legacy (uncompressed)","address":"...","steps":{...}},
    {"id":"btc_p2sh_p2wpkh","label":"Bitcoin P2SH-P2WPKH","address":"3...",
     "steps":{"redeem":"0014...","script_hash":"...","payload":"05...","checksum":"..."}},
    {"id":"btc_p2wpkh","label":"Bitcoin native segwit","address":"bc1q...",
     "steps":{"hrp":"bc","witness_version":"0","program":"...","checksum":"..."}},
    {"id":"btc_p2tr","label":"Bitcoin taproot","address":"bc1p...",
     "steps":{"internal_x":"...","tweak":"...","output_x":"...","parity":"0|1","program":"..."}},
    {"id":"evm","label":"Ethereum / EVM","address":"0x...",
     "steps":{"keccak":"...","last20":"..."}},
    {"id":"tron","label":"TRON","address":"T...",
     "steps":{"payload":"41...","checksum":"...","base58":"..."}},
    {"id":"solana","label":"Solana (ed25519)","address":"...",
     "steps":{"pubkey":"..."}}
  ]
}
```

Rules: secp keys must be in 1..n-1 (reject 0 and >=n); ed25519 seeds accept any
32 bytes. Taproot follows BIP341 with an empty script path: `t =
tagged_hash("TapTweak", x(P))`, `Q = P + tG`, program = x(Q), witness v1,
bech32m. P2SH-P2WPKH uses redeem `0x0014 || hash160(compressed pubkey)`, script
hash `hash160(redeem)`, version 0x05. TRON payload `0x41 || keccak256(uncompressed
pubkey[1..])[12..]`, base58check. EVM address is the last 20 bytes of that
keccak; display EIP-55 checksummed. Ed25519 uses `ed25519-dalek` with
`default-features = false`; Solana address is base58 of the 32-byte public key.

## D4. Page behaviour

- Input parsing: `0x`-prefixed or bare 64 hex, decimal below n, or WIF (WIF is
  secp256k1 only and implies compressed when it carries the 0x01 suffix).
  Invalid input shows an inline error, not a toast.
- State stays in memory only: the key is never written to the URL, history,
  localStorage or a log, so a reload requires re-entering it. The page shows a
  warning that a key controlling funds should not be typed into any website
  unless it is an offline/air-gapped workflow.
- Rows are filtered by the selected wallet preset; each row has copy, expand
  details, and (online mode) balance/tx cells.
- "Check balances" is an explicit action; offline mode is the default. Each
  provider call is independent, time-limited and error-local.
- Curve plot: a smooth real-valued illustration of the selected curve
  (secp256k1 y²=x³+7; the ed25519 Edwards shape), fixed size, with a slider
  moving a highlighted point along the visible curve; the real public point is
  shown separately in hex. The caption says the arithmetic is over a finite
  field and the plot is illustrative.

## D5. Serving and build

`web/key.html` and `web/key.js` are embedded with `include_str!` and served at
`/key` and `/key.js` with the same `Cache-Control: no-cache` as the other
assets. The wasm artifact is rebuilt by the existing `scripts/build-wasm.sh`,
CI and Docker steps; no new build step. A "Keys" nav link is added to all
pages. Bump the shared `?v=` asset suffix when `site.css` changes.

## D6. Tests

- Rust unit tests in the wasm crate: key 1 fixtures (P2PKH compressed and
  uncompressed, WIF, P2SH-P2WPKH, P2WPKH), BIP350 bech32m vector, BIP341
  taproot vector, EVM and TRON known addresses, ed25519/Solana fixture,
  rejection of 0/n.
- Node: `derive_report` for the fixtures and JSON shape; page test with mocked
  providers for offline/online states, invalid input and details expansion.
- Browser: live page check at 375/768/1280, `impeccable detect` clean, and a
  manual balance lookup on a known empty address.

## D7. Risks

- Public RPCs may rate-limit or change; lookups are optional, per-provider and
  never block derivation.
- A key page is dual-use: it shows what a key controls but performs no signing,
  sweeping or import. The UI states that the key never leaves the browser and
  only addresses are queried.
- ed25519 via a new dependency grows the wasm artifact; measure and keep it
  under ~2 MB.
