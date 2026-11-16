# Design: transaction building, local signing and broadcast

## D1. Architecture

```
web/key.html (read-only explorer, unchanged default)
  + "Build and sign" tab (explicit gate, network selector, outputs, review)
        |
        |  postMessage (key + binary plan)
        v
web/key-signer.js  (dedicated worker; holds the key while the tab lives)
        |
        |  wasm ABI (no imports, no clock, sequential)
        v
crates/rotor-wasm: sign_p2wpkh(plan, key) -> JSON | decode_tx(raw) -> JSON
  scalar/field/point/secp/hashes/base58/bech32
  + new: HMAC-SHA256/RFC6979, ECDSA sign/verify, DER, BIP143, tx codec,
    address decode (bech32/bech32m, Base58Check versions)
        |
        |  public HTTP only (no key, no signed tx before confirmation)
        v
mempool.space / blockstream.info (UTXO + fee), then broadcast fallback:
mempool.space -> blockstream.info -> (optional) blockcypher
```

The coordinator serves `/key`, `/key.js`, `/key-signer.js` and
`/rotor_wasm.wasm` from embedded bytes (`src/coordinator/mod.rs:31-41,490-505`).
It gains no signing endpoint. The only server change is a CSP header for
`/key` (D14) and embedding the new worker file.

## D2. Reference-site facts and our differences

Fetched `ref-site-b/transaction_to_bitcoin_address_p2pkh` on 2026-11-16 and
treated the HTML as data. Facts that drive this design:

| Reference behavior | Our decision |
|---|---|
| Claims "entirely offline" but POSTs the serialized form, including the private key textarea, to `calculators/bitcoin_transaction_calc_new_mix_05052025.php` (lines 612-615, 818-826) | Sign locally in WASM; the key never enters a request. This is the whole point of the change. |
| Supports P2PKH, P2SH, P2WPKH, P2WSH; no P2TR transaction form (lines 1-5, 694) | Start with P2WPKH only; stage the other types (proposal). |
| Auto-fill is a single BlockCypher mainnet GET; no testnet (lines 799-805) | Query both mempool.space and blockstream.info; support mainnet/testnet4/testnet3 and regtest in tests. |
| No automatic change; warns the remainder becomes a fee (line 735) | Always propose a change output to the same address, with dust handling, and show it before signing. |
| Does not broadcast; links to external decoders (lines 742, 775-778) | Broadcast only after a second explicit action; decode locally before broadcast. |
| Sequence `fdffffff` (RBF) by default (line 649) | Offer RBF opt-in, default on; show the sequence byte in the review. |

What not to copy: server-side key handling, the misleading "offline" claim,
manual change avoidance, and the lack of a test-network path.

## D3. Network model and derivation changes

The current derivation is mainnet-only:

- `src/base58.rs:7-9` hardcodes WIF 0x80, P2PKH 0x00, compressed flag 0x01.
- `src/base58.rs:68-82` builds P2PKH and WIF with those constants.
- `crates/rotor-wasm/src/derive.rs:29-95` hardcodes "bc" for P2WPKH/P2TR and
  0x05 for P2SH.

Signing on a test network requires correct testnet addresses/WIF, so the change
introduces a network parameter:

| Network | P2PKH version | P2SH version | bech32 HRP | WIF version |
|---|---|---|---|---|
| mainnet | 0x00 | 0x05 | `bc` | 0x80 |
| testnet3/testnet4 | 0x6f | 0xc4 | `tb` | 0xef |
| regtest | 0x6f | 0xc4 | `bcrt` | 0xef |

- New export `derive_report_net(priv_ptr, curve, network) -> status`; keep
  `derive_report` as a mainnet wrapper so the existing page/smoke test and
  other callers do not break.
- `base58` helpers take a version byte (or a `Network` enum) instead of using
  the constants; WIF decode accepts both mainnet and testnet versions.
- The page shows the network-derived address rows and WIF for the selected
  network. Balance lookup hosts are chosen per network
  (`mempool.space` vs `mempool.space/testnet4`, etc.).
- The signer validates that the UTXO address it queried equals the address
  derived for the selected network. A testnet key is never signed against a
  mainnet endpoint, and vice versa.

## D4. WASM ABI

Keep the hand-written pointer/length ABI (no wasm-bindgen). New exports:

```
sign_p2wpkh(plan_ptr, plan_len, key_ptr) -> u32
decode_tx(raw_ptr, raw_len) -> u32
```

`plan` is a compact little-endian binary document (no JSON parser in the wasm
core):

```
u8   version = 1
u8   network (0 mainnet, 1 testnet3, 2 testnet4, 3 regtest)
u8   sighash (1 = SIGHASH_ALL)
u8   flags   (bit 0 = RBF sequence 0xfffffffd)
u32  locktime
u16  input_count
  per input:
    32 bytes prev txid (display order, not reversed)
    u32 vout
    u64 value in sats
    u8  script_type (0 = P2WPKH; reserved for future types)
u16  output_count
  per output:
    u64 value in sats
    u8  script_len
    script bytes (scriptPubKey)
u16  change_index (0xffff = no change; index into outputs)
```

The core reconstructs the input scriptPubKey from the key (P2WPKH:
`0x0014 || hash160(pubkey)`), checks the plan invariants, serializes the
unsigned transaction, computes the BIP143 sighash, signs, verifies, and writes
the witness. It returns JSON through the existing `result_ptr()/result_len()`
buffers (the JS side already parses JSON):

```
{"raw":"<hex>","txid":"<hex>","wtxid":"<hex>","vsize":<n>,"weight":<n>,
 "fee":<sats>,"sighash":"<hex>","inputs":[...],"outputs":[...]}
```

Errors use the existing `error_ptr()/error_len()` and a nonzero status. Error
strings are fixed English labels, never key material.

`decode_tx` parses arbitrary raw transaction bytes and returns a JSON preview
(version, marker/flag, inputs with witness, outputs with decoded address or
script hex, locktime, txid, wtxid, weight, vsize). It is used for the review
screen, for post-sign self-check, and by tests; it does not trust third-party
data.

The key buffer is allocated by JS, written once, passed to `sign_p2wpkh`, then
overwritten with zeros and deallocated. The signer worker is terminated on
"Clear" and on `pagehide`; see D10.

## D5. Cryptography

### D5.1 P2WPKH sighash (BIP143)

For each input, with `SIGHASH_ALL`:

- `hashPrevouts = sha256d(all outpoints)`.
- `hashSequence = sha256d(all nSequence)`.
- `hashOutputs = sha256d(all outputs (value || scriptPubKey))`.
- Preimage: version, hashPrevouts, hashSequence, current outpoint,
  scriptCode (`0x1976a914 || hash160(pubkey) || 0x88ac`), amount (u64),
  sequence, hashOutputs, locktime, sighash type (u32 LE).
- `z = sha256d(preimage)` interpreted as a 256-bit big-endian integer.

The scriptCode is the P2PKH script of the key's hash160, not the witness
program. This is the most common BIP143 mistake; the implementation must use
the P2PKH form.

### D5.2 ECDSA

- Deterministic nonce per RFC6979 with HMAC-SHA256. The existing `sha2` crate
  supplies SHA-256; HMAC is implemented over it (about 30 lines) or added as a
  small dependency. No random nonce is needed, so a broken CSPRNG cannot cause
  nonce reuse.
- `r = (kG).x mod n`; `s = k^-1 (z + r d) mod n`; reject `r = 0` or `s = 0`.
- Low-S normalization (`if s > n/2 { s = n - s }`).
- DER encoding, then append `0x01` for SIGHASH_ALL.
- Verify the produced signature against the public key and the same sighash
  before returning. A signing failure is a hard error, never a silent fallback.
- `Scalar` currently has add/sub/mul but no inverse (`src/scalar.rs:83-142`);
  add modular inversion mod n (Fermat or extended Euclid) and tests at the
  boundaries.
- Point multiplication already exists (`src/secp.rs:45`), including the
  generator and addition.

### D5.3 Future P2TR (not in this change)

For the staged follow-up: BIP341 sighash includes all prevout amounts and
scriptPubKeys; BIP340 Schnorr uses tagged hashes `BIP0340/aux`,
`BIP0340/nonce`, `BIP0340/challenge`; `aux_rand` must come from
`crypto.getRandomValues` (32 bytes). The tweaked key is `d' = d + t mod n`
where `t = int(hash_TapTweak(x(P) || merkle_root)) mod n`; a zero tweak scalar
or the identity output key is invalid. No script path/control block in the
first taproot release.

### D5.4 Library decision

The existing secp arithmetic was written for scanning, not for signing. Before
hand-rolling ECDSA, evaluate the audited RustCrypto `k256` crate (with the
`schnorr` feature for the later P2TR step) and measure the wasm artifact. If
the size/CFI cost is acceptable, use it for signing and keep the existing
scanning path. If not, the hand-rolled path is acceptable only with the full
vector suite, independent review, local verification and a documented
limitation. The current wasm artifact is about 232 KiB
(`web/rotor_wasm.wasm`), so there is some headroom, but `k256` can add
hundreds of KiB.

## D6. Address and script handling

Every user-entered output address is decoded locally into a scriptPubKey; no
address is passed through to the transaction builder as text.

| Address type | Decode | scriptPubKey |
|---|---|---|
| P2PKH | Base58Check, version 0x00 (mainnet) / 0x6f (test) | `76a914 || h160 || 88ac` |
| P2SH | Base58Check, version 0x05 / 0xc4 | `a914 || h160 || 87` |
| P2WPKH | bech32, HRP `bc`/`tb`/`bcrt`, witness v0, 20-byte program | `0014 || program` |
| P2WSH | bech32, v0, 32-byte program | `0020 || program` |
| P2TR | bech32m, v1, 32-byte program | `5120 || program` |

Rules:

- Reject mixed-case bech32 and non-ASCII/homoglyph characters; normalize
  lower-case after validation.
- Reject witness versions above 1 and wrong program lengths.
- Reject a mainnet address on a test network and vice versa; show the detected
  network explicitly.
- Reject the zero address, the burn address `1111111111111111111114oLvT2`,
  and any output equal to the input/change address unless the user re-confirms
  (self-send is valid but surprising).
- `base58::decode_check` already exists (`src/base58.rs:12`); the bech32 module
  is encode-only (`crates/rotor-wasm/src/bech32.rs:81`), so a decoder with
  BIP173/BIP350 checksum verification is new code.
- Spend inputs/change are restricted to P2WPKH in this change; output decoding
  supports all five types above.

## D7. UTXO sourcing and trust

Primary endpoint (`GET`, CORS observed `*`):

```
https://mempool.space/api/address/<address>/utxo
https://mempool.space/testnet4/api/address/<address>/utxo
https://mempool.space/testnet/api/address/<address>/utxo
```

Observed response shape (2026-11-16):

```json
[{"txid":"...","vout":0,"status":{"confirmed":false},"value":20307}]
```

The endpoint returns no scriptPubKey. That is acceptable **because the spent
input belongs to the selected key**: the prevout script is reconstructed locally
as `0x0014 || hash160(pubkey)`, and the queried address must equal the derived
P2WPKH address. We must never accept a provider-supplied script for an input.

Cross-check (secondary, CORS observed `*`):

```
https://blockstream.info/api/address/<address>/utxo
https://blockstream.info/testnet4/api/address/<address>/utxo
```

Trust rules:

1. Query both providers. Match UTXOs by `(txid, vout)`; if the value sets
   differ, show a blocking warning and require the user to choose "use primary"
   or abort. Do not silently pick one. If the secondary is unavailable, continue
   with the primary and label the values as single-provider/unverified.
2. Strong mode (recommended default on mainnet): for each selected outpoint,
   fetch `/api/tx/<txid>/hex` from the same provider, parse it locally, and
   verify that the output at `vout` has the expected value and scriptPubKey.
   This removes trust in the indexer's value field and catches a provider that
   returns a wrong amount.
3. Ignore unconfirmed UTXOs by default; allow them only with an explicit
   checkbox and a warning (they can disappear via RBF).
4. Reject duplicate outpoints, zero/overflowing values, and a total above
   21,000,000 BTC (2.1e15 sats).
5. mempool.space refuses addresses with more than 500 UTXOs (observed HTTP 400
   "Too many unspent transaction outputs"); surface that as a clear error and
   do not fall through to an untrusted provider silently.

## D8. Selection, fee, change, serialization

### D8.1 Coin selection

MVP: largest-first selection.

```
target = sum(outputs) + fee_estimate(inputs, outputs, change)
sort confirmed UTXOs by value descending
add until selected >= target
```

Then solve the change/fee equation iteratively because the number of inputs and
the presence of change change the vsize:

1. Estimate vsize with no change; if selected covers outputs + fee, compute
   change.
2. If change >= dust, add the change output and recompute vsize/fee.
3. If change < dust, drop it and add the remainder to the fee.
4. If selected is still insufficient, add the next UTXO and repeat.
5. Cap at a sane input count (for example 100); otherwise ask the user to
   choose a smaller set or consolidate deliberately.

No coin control UI in the MVP; the selected outpoints and values are shown in
the review so the user can see exactly what is spent. RBF (sequence
`0xfffffffd`) is offered and defaults on.

### D8.2 Fee

- `GET https://mempool.space/api/v1/fees/recommended` returns
  `fastestFee`, `halfHourFee`, `hourFee`, `economyFee`, `minimumFee`
  (observed, CORS `*`). Offer three presets and a manual sats/vB override.
- Testnet4 fee endpoint returned 404 on 2026-11-16; use a fixed rate (for
  example 1-2 sat/vB) or a clearly labeled mainnet estimate. Never silently
  reuse a mainnet rate on a testnet transaction.
- Estimate vsize with the maximum DER signature size (conservatively 73 bytes
  including the sighash byte; low-S is usually 72) so the paid fee is not below
  the requested rate after signing.
- After signing, recompute the actual vsize. If the actual fee rate is below
  the target, do not broadcast: re-sign with a corrected change amount (or ask
  the user to accept a higher fee).
- Guardrails: warn above 100 sat/vB or above 5% of the input total; require an
  explicit confirmation above those thresholds; refuse a zero fee.

### D8.3 Change and dust

- Change goes to the same P2WPKH address/script as the input key. Reusing the
  same address is a privacy compromise inherent to a single-key explorer; a
  fresh change address/derivation path is out of scope for this change.
- P2WPKH dust threshold at the default relay dust rate is 294 sats; treat
  values below it as dust, add them to the fee, and show that the fee increased.
  The implementation must derive the threshold from the relay dust rate rather
  than copying 294 blindly.
- Change is the last output in the serialized transaction (user order is
  preserved for the entered outputs) so the review reads naturally. Do not
  apply BIP69 sorting in the MVP; it would break exact BIP143 vector matching
  and is an independent privacy decision.

### D8.4 Serialization

- Version 2, locktime 0, RBF sequence as above.
- Segwit serialization: version, marker `0x00`, flag `0x01`, inputs, outputs,
  witness, locktime.
- txid = sha256d of the legacy serialization (no marker/flag/witness);
  wtxid = sha256d of the full serialization.
- weight = base_size * 3 + total_size; vsize = ceil(weight / 4).
- Values are u64 sats, little-endian on the wire; total output value must not
  exceed the input value, and the difference is the fee.
- The review shows the exact raw hex and txid before signing and after
  signing. A changed plan always produces a new txid.

## D9. Signing flow and state machine

```
idle -> key_loaded -> utxos_loaded -> draft -> reviewed -> signed
                 ^                                  |
                 +------ any edit invalidates ------+
signed -> broadcasting -> broadcast / failed
```

- `reviewed` means the user has seen and acknowledged the exact output list,
  fee, fee rate, change and network. The sign button is disabled before that.
- `signed` stores only the raw transaction, txid, vsize and the review
  fingerprint. It does not store the key or the signed message outside the
  worker.
- Any change to the key, network, input set, output set, values, fee or RBF
  flag moves the state back to `draft`, clears the raw transaction and requires
  a new signature. The UI must not leave a stale signed transaction visible
  next to edited fields.
- "Broadcast" is a separate action available only in `signed`. It is never
  triggered by signing, by a timer, or by page load.
- Mainnet requires typing a confirmation phrase (for example `SIGN MAINNET`)
  and re-displaying the destination address. Testnet asks for a normal
  confirmation only.
- The review displays: network, input outpoints and values, each output
  address and value, change, fee in sats/core, fee rate, vsize, RBF, locktime,
  txid/wtxid, and the raw hex.

## D10. Key handling and memory hygiene

Key custody:

- The page never writes the key to the URL, history, `localStorage`,
  `sessionStorage`, IndexedDB, cookies, console or any request. This restates
  `web/key.js:2` and extends it to the signing flow.
- Recommended: a dedicated worker (`web/key-signer.js`) receives the 32-byte
  key once via `postMessage`, derives the public address report, and keeps the
  key only in worker memory. The page clears the password input and its own
  copy immediately after the handoff. The worker exposes only "derive" and
  "sign" messages; it never fetches anything.
- "Clear key" and `pagehide` terminate the worker (freeing its heap and the
  wasm instance). A new worker is created for a new key. The page also clears
  the input and all derived rows.
- Before calling `sign_p2wpkh`, the worker writes the key into a wasm buffer,
  zeroes the buffer after the call, and deallocates it. It then drops the wasm
  instance used for signing so the linear memory is not reused for the next
  key. The derivation instance can be separate.
- Honest limitation: JavaScript engines, the wasm allocator, the OS page cache
  and swap can retain copies; erasure cannot be guaranteed in a browser. The
  UI must say this, not promise "the key is erased". For real funds, use an
  air-gapped or hardware signer.
- No analytics, error reporting, service worker, third-party script, CDN or
  font on `/key`. The only network requests are the documented UTXO/fee/
  broadcast calls, and none of them includes the key.
- The password input uses `autocomplete="off"`, `spellcheck="false"`; the page
  refuses to run in an insecure context (WebCrypto requirement, already the
  pattern in `web/key.js:183-185`).

Why a worker rather than the existing in-page state: `web/key.js:90-100,351,413,992-996`
keeps `state.keyBytes` in the page heap and only nulls it. A worker gives a
clear lifetime boundary and a terminate operation; it is not a cryptographic
guarantee, but it is materially better than a long-lived page global.

## D11. Broadcast

### D11.1 Provider matrix (probed 2026-11-16)

| Provider | Endpoint | Body | CORS observed | Role |
|---|---|---|---|---|
| mempool.space | `POST https://mempool.space/api/tx` | raw hex, `text/plain` | `Access-Control-Allow-Origin: *` | primary |
| mempool.space testnet4 | `POST https://mempool.space/testnet4/api/tx` | raw hex | `*` | primary (test) |
| mempool.space testnet3 | `POST https://mempool.space/testnet/api/tx` | raw hex | `*` | primary (test) |
| blockstream.info | `POST https://blockstream.info/api/tx` | raw hex | `*` | secondary |
| blockstream testnet4/testnet3 | `.../testnet4/api/tx`, `.../testnet/api/tx` | raw hex | `*` | secondary (test) |
| BlockCypher | `POST https://api.blockcypher.com/v1/btc/main/txs/push` | JSON `{"tx":"<hex>"}` | `*` (preflight allows POST/Content-Type) | optional last resort |
| BlockCypher test3 | `POST .../v1/btc/test3/txs/push` | JSON | `*`, `x-ratelimit-remaining: 1` | optional (test) |
| Blockchair | `POST https://api.blockchair.com/bitcoin/push/transaction` | JSON `{"data":"<hex>"}` | `*` | not default; 430 blacklist observed |
| blockchain.info | `POST https://blockchain.info/pushtx` | form | no CORS headers (405 OPTIONS, 500 malformed POST) | decode link only |

CORS is necessary but not sufficient; re-probe at implementation time and do
not assume a provider will keep its policy.

### D11.2 Fallback and idempotency

- Broadcast only the exact signed bytes; the local txid is computed before any
  request.
- Order: mempool.space -> blockstream.info -> BlockCypher (only if the user
  enables "try more providers"). Never broadcast to two providers in parallel.
- Response handling:
  - 200 + txid: compare with the local txid. A mismatch is a hard error (do not
    show success); verify with `GET /api/tx/<local txid>` on the same provider.
  - 200 but non-txid body: verify via GET; do not parse arbitrary HTML as a
    txid.
  - 400/409 with "already in mempool", "already in block chain", "txn-already-
    known": treat as success only after GET confirms the local txid; otherwise
    show the raw error.
  - 400 "TX decode failed", "min relay fee not met", "bad-txns-inputs-
    missingorspent", "scriptpubkey", "non-mandatory-script-verify-flag":
    deterministic rejection; stop, do not retry another provider blindly, show
    the message and keep the signed transaction.
  - 429 / 5xx / network error / CORS failure: back off (for example 1s, 2s)
    and try the next provider.
- All providers fail: keep `signed` state, show every error, offer copy/save of
  the raw hex and links to the providers' own broadcast pages. Do not clear the
  transaction, do not auto-retry in the background, and do not sign again.
- Rate limits: mempool.space and blockstream.info did not advertise a limit in
  the observed responses; BlockCypher returned `x-ratelimit-remaining: 1`
  without a token. Treat all three as rate-limited and serialize requests.

### D11.3 Network binding

The endpoint set is chosen from the selected network; a testnet transaction is
never sent to a mainnet endpoint. The UI shows the network next to the
broadcast button and in the result. A provider returning a txid for the wrong
network is a hard error.

## D12. Local decode and preview

The preview is built from the raw transaction bytes by `decode_tx`, not by a
third-party service. It shows:

- version, marker/flag, locktime, RBF sequence;
- each input: prev txid:vout, sequence, scriptSig (empty for P2WPKH), witness
  item count and lengths (the signature is shown as hex, not interpreted);
- each output: value, scriptPubKey, decoded address and type;
- fee = sum(input values, known from the plan/UTXO fetch) - sum(output values);
- fee rate = fee / vsize, weight, vsize, txid, wtxid;
- warnings: output to an unknown script, output above a threshold, fee above a
  guardrail, missing change, change below dust, testnet/mainnet mismatch,
  unconfirmed inputs, address equal to the input address.

Why local first: before broadcast the transaction is not public. Sending it to
`secretscan`/`blockchain.com` would reveal the spend intent and txid to a third
party and would be another trust dependency. External decode links are offered
only after broadcast (or on explicit request, with a warning that the
transaction becomes public), for example:

```
https://mempool.space/tx/<txid>
https://blockstream.info/tx/<txid>
https://www.blockchain.com/explorer/transactions/btc/<txid>
https://ref-site-b/Transaction_decoded_Bitcoin?tx=<txid>
https://live.blockcypher.com/btc/tx/<txid>/
```

The exact external URL patterns are not part of the acceptance criteria; the
local decoder is.

## D13. Safety and UX gates

- The signing mode is a separate, clearly labeled tab/section; the default
  `/key` view remains read-only. The tab starts on testnet.
- "Use a test key first": testnet mode offers a random test key generator and
  instructions to fund it from a faucet; it never auto-funds or contacts a
  faucet, and the key is clearly labeled as worthless.
- Prominent warning: "Signing on an online page is for test keys and learning.
  If this key holds real funds, stop and use a hardware or air-gapped signer."
  This is stronger than the current `web/key.html:25` warning because signing
  now exists.
- No sweep, no "send max", no automatic selection of all UTXOs into one output,
  no automatic signing, no automatic broadcast, no retry loops.
- Every output is shown before signing; the destination address is shown in
  monospace and decoded to a script type. A second copy of the destination can
  be required for mainnet (user re-enters or confirms it), which raises the cost
  of a clipboard/substitution mistake without pretending to stop malware.
- Fee and output guardrails (D8.2/D12) require explicit confirmation.
- Signature invalidation on edit (D9) prevents signing one plan and
  broadcasting another.
- After broadcast, compare the local txid with the provider response and with a
  `GET /api/tx/<txid>` confirmation; never display "sent" on a bare HTTP 200.
- The page cannot detect a compromised browser or a malicious extension; it
  must not claim to.

## D14. Trust boundary, CSP and offline use

Client-side signing protects against the coordinator's normal operation
receiving or logging the key. It does not protect against:

- a compromised coordinator host serving altered `/key.js` or
  `/rotor_wasm.wasm`;
- XSS or a malicious dependency (none are loaded today);
- a malicious browser extension, proxy, DNS or TLS interception;
- a user typing a funded key into a compromised machine.

Mitigations in this change:

- Add a CSP for `/key` (the static handler at
  `src/coordinator/mod.rs:490-505` currently sets only `Content-Type` and
  `Cache-Control`):

  ```
  default-src 'none';
  script-src 'self' 'wasm-unsafe-eval';
  style-src 'self';
  img-src 'self' data:;
  connect-src 'self' https://mempool.space https://blockstream.info
    https://api.blockcypher.com https://api.blockchair.com
    https://apilist.tronscanapi.com https://ethereum-rpc.publicnode.com
    https://eth.drpc.org https://1rpc.io;
  base-uri 'none'; form-action 'none'; frame-ancestors 'none'; worker-src 'self'
  ```

  The connect list mirrors the existing balance providers in `web/key.js:9-11,723,794`
  plus the broadcast hosts. A stricter list per sign mode is possible later.
- `Referrer-Policy: no-referrer` and `X-Content-Type-Options: nosniff` on
  `/key`; no third-party scripts, fonts, analytics or service worker.
- Render user data with `textContent`, never `innerHTML`; the current page
  uses innerHTML only for the static curve SVG (numeric, no user text); the
  signing UI must use textContent for addresses, hashes and error messages.
- Offer an "offline copy" path as a follow-up: a downloadable bundle with a
  published hash and instructions to run it locally. A web-hosted page cannot
  prove its own integrity; say so in the docs.

## D15. Testing and CI strategy

### D15.1 Vectors (cargo test, no network)

- BIP143 P2WPKH example: the published signed transaction is reproduced
  byte-for-byte with the same key, outpoint, amount, output and SIGHASH_ALL;
  assert raw hex, txid, sighash and signature.
- BIP143 P2SH-P2WPKH example: same check, deferred to the follow-up change.
- BIP340 CSV signing vectors: fixed secret key, aux_rand, message -> exact
  64-byte signature (future P2TR).
- BIP341 wallet test vectors: `keyPathSpending` sighash preimages/sighashes
  (future P2TR).
- Legacy sighash vector from Bitcoin Core or the canonical wiki example
  (future P2PKH).
- Address decode vectors: BIP173/BIP350 valid and invalid bech32/bech32m,
  mixed case, wrong HRP, wrong witness version/length, Base58Check versions.
- Transaction codec fixtures: txid/wtxid/vsize/weight and round-trip of a
  known raw transaction.
- Property-style checks: malformed plans, truncated raw transactions, values
  above MAX_MONEY, duplicate outpoints and zero outputs must return errors,
  not panic.

### D15.2 WASM and Node

- `cargo test -p rotor-wasm` plus the existing Node smoke
  (`crates/rotor-wasm/smoke.mjs`) and worker test
  (`web/worker-test.mjs`), extended with `sign_p2wpkh`/`decode_tx` cases.
- The existing CI job builds wasm and runs these (`.github/workflows/rust.yml:43-57`);
  add the new tests there.

### D15.3 Regtest end-to-end (CI, no live broadcast)

A gated job downloads a pinned Bitcoin Core release, starts
`bitcoind -regtest`, creates a wallet, mines 101 blocks, sends to the derived
P2WPKH address, fetches the UTXO, builds and signs in Node against the wasm
artifact, then calls `testmempoolaccept` and `sendrawtransaction`. It mines one
block and asserts the destination balance and the change balance. This is the
strongest proof that the signature, sighash, serialization and scripts are
correct. It must run without internet after the Core download.

### D15.4 Testnet acceptance (manual, not CI)

A maintainer-run script reads `TESTNET_WIF` (and optionally a faucet-funded
address) from the environment, builds a small transaction to a fresh testnet
address, signs it, broadcasts to `mempool.space/testnet4/api/tx`, then polls
`/api/tx/<txid>` and prints the destination. The key is never committed and CI
never runs this. The acceptance is recorded in the PR description.

### D15.5 Browser and leak tests

- Playwright (or an equivalent headless harness) opens `/key`, injects a known
  test key, exercises derive -> UTXO -> review -> sign, and intercepts all
  network requests, storage APIs, URL changes and console output. Assert the
  key's hex/WIF/decimal never appears; assert the only POST body is the raw
  transaction and it contains no key material.
- Mock the broadcast endpoints for the UI tests: success, 400 decode, 400
  already-known, 429, 500, CORS failure, all-fail.
- Tamper test: mutate a signed transaction output and assert local verification
  fails and the node rejects it; mutate the form after signing and assert the
  UI returns to unsigned.
- UI checks at 375/768/1280, keyboard operation, no overflow, `impeccable
  detect` clean (the repo already uses this gate for web changes).

### D15.6 Non-goals in CI

- No mainnet broadcast, ever.
- No committed funded keys.
- No live external network calls in unit tests; endpoints are mocked or
  replaced by regtest.

## D16. Size estimate

| Part | MVP (P2WPKH) | Full BTC four types |
|---|---|---|
| Rust crypto/codec | ~1,200-1,500 lines | ~1,800-2,200 |
| Rust tests/fixtures | ~500 | ~900 |
| JS network/selection/review | ~700-900 | ~900-1,100 |
| HTML/CSS/worker | ~200-300 | ~250-350 |
| Total | ~2,600-3,200 LOC | ~3,900-4,550 LOC |
| Effort (experienced dev, with review) | 6-9 dev-days | 12-18 dev-days |

Confidence: medium. The crypto/codec estimate assumes the hand-rolled path;
using `k256` may reduce implementation risk but add integration/size work. The
MVP estimate does not include the offline-copy bundle or a hardware-wallet
path.

## D17. Alternatives considered

- **Server-side signing (reference site):** rejected. It puts the key on the
  coordinator, contradicts the existing privacy model, and is not needed.
- **Send the transaction to an external decoder before broadcast:** rejected
  for privacy and trust; the local decoder is testable and sufficient.
- **PSBT only (no broadcast):** safer for hardware wallets but does not meet
  the owner's goal and still needs the same transaction/sighash code. Could be
  a later export format.
- **Use an audited secp library (`k256`) vs hand-rolled:** see D5.4. The
  decision must be measured, not assumed; either way the vectors and regtest
  tests are mandatory.
- **Add all four BTC types at once:** rejected for the first release; it
  multiplies the sighash/witness surface and the acceptance burden.
- **Add EVM/TRON in the same change:** rejected (proposal, "Why Ethereum and
  TRON are out").

## D18. Threat and mitigation table

| Threat | Impact | Mitigation |
|---|---|---|
| Compromised host serves altered JS/WASM | Key theft | CSP, no third-party code, honest trust warning, offline-copy follow-up |
| XSS/HTML injection | Key theft, address substitution | `textContent`, no `innerHTML` for user data, CSP `default-src 'none'` |
| Malicious extension/keylogger | Key theft | Out of the page's control; warn and recommend air-gapped signing |
| Nonce reuse or biased ECDSA nonce | Key exposure | RFC6979 deterministic nonce, low-S, verify, vectors |
| Wrong sighash/scriptCode | Invalid or wrong transaction | BIP143 vector, regtest `testmempoolaccept`, local verify |
| Indexer lies about UTXO value | Overpay/failed tx | Cross-provider match, local prev-tx parse, fee guardrails |
| Provider returns a different txid | False success | Compare local txid, GET confirmation |
| Address substitution/clipboard hijack | Funds to attacker | Local decode, script display, monospace, mainnet re-confirmation |
| Missing/incorrect change | Funds burned as fee | Automatic change, dust handling, explicit review, fee guardrails |
| Testnet/mainnet mix-up | Loss or confusion | Network selector, endpoint binding, address version checks, testnet default |
| All broadcast providers fail | Stuck transaction | Fallback order, preserve raw hex, manual broadcast links |
| Browser memory retains the key | Residual key | Worker termination, buffer zeroization, honest limitation |
