# Transaction building, local signing and broadcast on /key

## Summary

Add an explicit, opt-in signing flow to the `/key` private-key explorer: the
page builds a Bitcoin transaction from the selected key's own UTXOs, signs it
locally inside the WASM core, shows a fully local decode/review, and broadcasts
only after a separate user confirmation through public CORS-enabled endpoints.
The recommended first release is deliberately narrow: **P2WPKH only, mainnet
plus a test network, multi-input/multi-output, change back to the same
P2WPKH address, no sweeping, no automatic signing, no automatic broadcast**.

## Problem / motivation

`/key` is currently a read-only explorer. `apps/site/docs.html:86,95` and
`README.md:256,272` state that it offers "no signing or sweeping"; the page
warning at `apps/site/key.html:25-26` tells users not to type funded keys into an
online page. The owner wants the next step: transaction building and signing
like the reference page, with broadcast through public pools and links to
decode/preview the transaction, while keeping the private key client-side.

Reference page investigated with `curl` on 2026-11-16
(`ref-site-b/transaction_to_bitcoin_address_p2pkh`; HTML treated as data):

- The visible claim is "Build, decode, and understand standard Bitcoin
  transactions entirely offline" (page heading, lines 520-523 of the fetched
  HTML), but the page is **not client-side signing**. Its jQuery submit handler
  posts the serialized form with an AJAX call to
  `calculators/bitcoin_transaction_calc_new_mix_05052025.php`
  (fetched HTML lines 818-826). The form field used for the private key is the
  `scriptSig_1` textarea with placeholder "private key (hex)" (lines 612-615);
  a hidden `private_1` field is filled from the server response (lines 848-849).
  The key therefore travels to the server.
- Supported address types are P2PKH, P2SH, P2WPKH and P2WSH (title, meta
  description, and the output-address placeholder "type: p2pkh, p2sh, p2wpkh,
  p2wsh", line 694). There is no P2TR transaction support on that page; the
  "Taproot P2TR" link in the nav is a separate address generator.
- The form supports several inputs and outputs (`cloneRow` buttons), manual
  txid/vout/amount/sequence, a fee field, RBF-by-default sequence `fdffffff`
  (line 649), and a "time" field. Auto-fill is one client-side GET to
  BlockCypher mainnet (`api.blockcypher.com/v1/btc/main/addrs/...`, lines
  799-805); there is no testnet mode.
- It does **not** create change automatically and warns that the remainder
  becomes a miner fee (line 735). It also states the serialized transaction is
  "not broadcast to the Bitcoin Network" (line 742) and only offers external
  decode links (ref-site-b, blockchain.com, lines 775-778).

The valuable part to reproduce is the step-by-step builder and the local
review. The part not to reproduce is sending the private key to a server, the
missing automatic change, and the untestable server-side signing path.

## Scope

### In scope (this change)

- A new "Build and sign" mode/tab on `/key`, behind an explicit gate; the
  existing read-only explorer remains the default.
- Network selector: `mainnet`, `testnet4`, `testnet3` (regtest in tests only).
  The selected network changes BTC address/WIF derivation too; today those are
  hardcoded mainnet (`src/base58.rs:7-9,68-82`, `crates/rotor-wasm/src/derive.rs:48,93`).
- Input type: **P2WPKH only** (native segwit v0), key-path spend, SIGHASH_ALL,
  RBF opt-in, version 2, locktime 0.
- UTXO discovery for the selected key's own P2WPKH address through
  mempool.space, with blockstream.info as a cross-check/fallback. Values are
  cross-checked and, in the strong mode, verified by parsing the previous
  transaction locally.
- Multi-input selection (largest-first with a user-visible plan), multiple
  outputs entered by the user, change to the same P2WPKH address, dust
  handling, fee estimation from a public fee endpoint plus a manual sats/vB
  override.
- Local transaction serialization, BIP143 sighash, RFC6979 deterministic
  ECDSA (low-S, DER), local signature verification before the transaction is
  shown.
- A local decode/preview built from the signed bytes: inputs, outputs,
  scripts, fee, fee rate, vsize, txid/wtxid, warnings. No third-party decoder
  is needed before broadcast.
- Broadcast only after a second explicit action, through a documented fallback
  chain of public endpoints; idempotency and error mapping; the raw transaction
  is always preserved if all endpoints fail.
- Safety gates: test network by default, typed confirmation for mainnet, no
  automatic signing, no automatic broadcast, no sweep/"send max", explicit
  display of every output, fee and change, signature invalidation on any edit,
  local txid comparison after broadcast.
- Docs/README update: remove the "no signing" claim, state the new trust
  boundary honestly.

### Out of scope (this change)

- P2SH-P2WPKH, legacy P2PKH and P2TR signing. They are the staged follow-ups
  described below, not part of the MVP.
- Ethereum/EVM, TRON, Solana and other chains (reasons below).
- Taproot script-path/tapscript, multisig, PSBT, hardware-wallet integration,
  miniscript, coinjoin, CPFP/RBF bumping, payment channels.
- Sweeping, "send all", automatic coin consolidation, address books, fiat
  conversion, mnemonic/BIP32 path handling.
- Any server-side signing, key escrow, telemetry, or server proxy for
  broadcast. The coordinator must never receive the key or the signed
  transaction.
- Sending a pre-broadcast raw transaction to a third-party decoder.

## Scope options and recommendation

| Option | Types | Extra cryptography/serialization | Rough size | Risk | Verdict |
|---|---|---|---|---|---|
| A. P2WPKH MVP | P2WPKH in, any supported output address | BIP143 + ECDSA/RFC6979 | ~2.5-3.2k LOC | medium | **recommend for this change** |
| B. Full BTC four types | P2PKH, P2SH-P2WPKH, P2WPKH, P2TR | adds legacy sighash, BIP340, BIP341 | ~3.9-4.6k LOC | high | stage as follow-ups |
| C. Decode/broadcast only | none (no signing) | none | ~0.5k LOC | low | does not meet the goal |
| D. Add ETH/TRON | plus EVM/TRON | RLP, EIP-155/1559, protobuf, TAPOS | +4-8k LOC | very high | reject |

**Recommendation: option A now.** Rationale is testability and blast radius,
not feature completeness. P2WPKH needs one sighash algorithm (BIP143), one
signature algorithm (ECDSA), and one input script shape. It can still pay to
P2PKH, P2SH, P2WPKH and P2TR outputs, because only the spent input/change type
is restricted.

Follow-up order:

1. **P2SH-P2WPKH** reuses BIP143 and ECDSA; the delta is the P2SH address
   decode, the 22-byte redeem script in `scriptSig`, and a different vsize.
   Cheapest next step.
2. **P2TR key-path** needs BIP340 Schnorr signing, BIP341 sighash, the BIP86
   tweak scalar, x-only keys and parity handling (`crates/rotor-wasm/src/derive.rs:79-93`
   already computes the tweak and output key for the address). No script path.
3. **P2PKH legacy** needs the pre-BIP143 sighash (all input scriptSigs are part
   of the digest). It is simple code but easy to get subtly wrong and has the
   largest per-input vsize, so it goes last.

What each type needs in detail:

- **P2WPKH:** BIP143 `hashPrevouts/hashSequence/hashOutputs`; scriptCode
  `0x1976a914{h160}88ac`; witness `[DER sig || 0x01, compressed pubkey]`;
  no scriptSig; ~68 vB per input; change is another P2WPKH output.
- **P2SH-P2WPKH:** same BIP143 digest; scriptSig is the push of
  `0x0014{h160}`; witness is the same two items; txid changes because scriptSig
  is part of the legacy serialization; ~91 vB per input; needs P2SH decode.
- **P2PKH:** legacy sighash over the transaction with the current input's
  scriptSig replaced by its scriptPubKey and other scriptSigs empty;
  scriptSig `[sig, pubkey]`; no witness; ~148 vB per input.
- **P2TR:** BIP341 sighash over all prevouts/amounts/scriptPubKeys/sequences
  and outputs, SIGHASH_DEFAULT; BIP340 Schnorr signature with `aux_rand`;
  key-path witness `[64-byte sig]`; no script path; 57.5 vB per input; needs
  the tweaked private key `d' = d + t` and the x-only output key parity rule.
- All types share UTXO selection, fee estimation, change, serialization,
  address decode/encode, and the review/safety/broadcast layer.

### Why Ethereum and TRON are out

They are not trivial extensions of a Bitcoin signer:

- **EVM:** RLP encoding, nonce management, EIP-155 (legacy) and EIP-1559
  (type-2) fee fields, chain-id binding, gas estimation, contract calldata,
  Keccak-based signing hashes, and JSON-RPC broadcast; a wrong nonce or chain
  id is a different class of failure.
- **TRON:** protobuf transaction format, TAPOS reference block, bandwidth and
  energy accounting, TRC-20 calldata, and a different broadcast API.

Each deserves its own change, tests and wallet-grade review. Adding them here
would multiply the risky surface without strengthening the Bitcoin path.

## Impacted domains

- `tx-signing` (new): transaction construction, signing, preview, broadcast.
- `browser-client`: `/key` page, WASM ABI, network-aware derivation, worker
  and key handling.
- `coordinator`: static asset embedding and a Content-Security-Policy for
  `/key`; no new API that touches keys.
- Docs: `README.md`, `apps/site/docs.html`, page warnings.

## Acceptance criteria

1. **BIP143 vector:** the P2WPKH signed transaction for the published BIP143
   example is reproduced byte-for-byte (same key, UTXO, outputs, SIGHASH_ALL),
   or at minimum the sighash and signature match the vector and the resulting
   txid is identical. Test fails on any deviation.
2. **Regtest end-to-end:** with a local `bitcoind -regtest`, a P2WPKH UTXO is
   funded to the derived address, the page/core builds and signs a transaction,
   `testmempoolaccept` returns `allowed: true`, `sendrawtransaction` accepts it,
   the intended destination receives exactly the specified value, and the
   change returns to the derived address. No internet is involved.
3. **Public testnet acceptance (manual, not CI):** a transaction signed for
   testnet4 is accepted by `https://mempool.space/testnet4/api/tx` (HTTP 200
   and a txid equal to the locally computed txid), and the destination address
   shows the expected amount. The test key comes from an environment variable
   and is never committed; CI must not run this.
4. **Tamper invalidation:** after signing, changing any output value, output
   address, fee, input set or network makes local signature verification fail
   and the UI return to the unsigned state; the same mutated transaction is
   rejected by `testmempoolaccept`. A signed transaction with the original
   bytes still verifies.
5. **Key never leaks:** an automated browser test intercepts `fetch`, XHR,
   `sendBeacon`, WebSocket, form submits, `localStorage`, `sessionStorage`,
   IndexedDB, cookies, the URL/history and console, and asserts that the key's
   hex, WIF and decimal forms never appear. Network requests contain only public
   addresses, UTXO identifiers, fee requests and the final raw transaction.
6. **Broadcast robustness:** with mocked endpoints, the documented fallback
   order is used; 429 and 5xx trigger backoff/next endpoint; deterministic 400
   errors stop retries; "already in mempool/chain" is treated as success after
   txid confirmation; if all endpoints fail the signed raw transaction remains
   visible and copyable and no state is lost.
7. **Local preview correctness:** the local decoder on a known raw transaction
   fixture reports the same txid, wtxid, version, locktime, input outpoints,
   output scripts/addresses, values, weight and vsize as an independent
   reference (Bitcoin Core or a test vector).
8. **Safety gates:** testnet is the default; mainnet requires an explicit typed
   confirmation; the sign action is disabled until the review screen has been
   acknowledged; there is no sweep, no "send max", no auto-sign and no
   auto-broadcast; fee and output guardrails trigger.
9. **CI discipline:** `cargo fmt`, `clippy`, unit tests, wasm build, Node ABI
   smoke and the regtest integration test pass; no CI job broadcasts to
   mainnet; network-facing unit tests use mocks.
10. **Honest docs:** `README.md` and `apps/site/docs.html` no longer claim "no
    signing"; they describe what is signed, which providers are contacted, and
    that client-side signing does not protect a key on a compromised host.

## Risks / unknowns

Top three risks:

1. **The page is not a trust boundary.** "Client-side" only means the
   coordinator does not normally receive the key. A compromised host, XSS,
   malicious browser extension, DNS/TLS interception or an altered WASM file
   can steal a key typed into the page. Adding signing increases the incentive
   to type funded keys here. Mitigations: CSP, no third-party scripts,
   `textContent`-only rendering, testnet default, mainnet typed confirmation,
   an explicit warning, an offline-copy path and an honest trust statement.
2. **Hand-rolled cryptography.** The project has its own secp256k1 point
   arithmetic (`src/secp.rs`) but no ECDSA, RFC6979, Schnorr or sighash code.
   A signing bug can produce invalid transactions or, in the worst case,
   nonce-related key exposure. Mitigation: deterministic RFC6979 nonces,
   low-S/DER rules, local signature verification, BIP143/BIP340/BIP341 vectors,
   regtest end-to-end tests, independent review, and a serious evaluation of
   the audited `k256` crate before hand-rolling.
3. **Irreversible value loss through fee/change/UTXO mistakes.** The reference
   site itself warns that it does not create change. A wrong change address,
   dust mistake, fee miscalculation or a lying UTXO indexer can burn funds.
   Mitigations: explicit review of every output/fee/change, fee guardrails,
   cross-provider UTXO verification or local prev-transaction parsing, dust
   handling, testnet-first workflow, no automatic signing.

Other risks: public endpoints can be down, rate-limited or change their CORS
policy; a broadcast can be rejected for fee/standardness reasons; users may
misread testnet/mainnet.

Unknowns / not verified (to be checked during implementation):

- Exact rate limits of mempool.space and blockstream.info: not documented in
  the observed responses. BlockCypher returned `x-ratelimit-remaining: 1`
  without a token; the real quota is not verified.
- Success response shape of each provider for a valid transaction: we
  intentionally did not broadcast a valid transaction while investigating. The
  documented contract is a txid string, but it must be re-verified with a
  regtest/testnet transaction.
- Testnet4 fee endpoint: `mempool.space/testnet4/api/v1/fees/recommended`
  returned 404 on 2026-11-16; a fixed fee rate or a clearly labeled mainnet
  estimate is needed.
- Blockchair: CORS is present, but the investigated IP was blacklisted (HTTP
  430) after a few probes; API-key requirements and quotas are not verified.
- Blockchain.com `pushtx`: no CORS headers observed (405 on OPTIONS, 500 on a
  malformed POST); treat as a decode link only.
- Availability of a public testnet faucet and the exact testnet4 ecosystem
  support of each indexer.
- WASM size impact of `k256` versus the hand-rolled implementation.
- Browser matrix for the signer worker and WebCrypto (secure context required).

## References

- `crates/rotor-wasm/src/lib.rs:26-39` (included crypto modules),
  `:331` (`derive_report`), `:545,558` (alloc/dealloc), `:619` (ABI export).
- `crates/rotor-wasm/src/derive.rs:21` (report), `:79-93` (taproot tweak),
  `:257,267` (tagged hash / scalar reduction).
- `crates/rotor-wasm/src/bech32.rs:81` (encoder only; no decoder).
- `src/secp.rs:45,72,133,149` (point arithmetic and hash160).
- `src/scalar.rs:58,74,83,93,117,142` (scalar arithmetic; no inverse).
- `src/hashes.rs:7,13,23,27` (sha256, sha256d, hash160, keccak256).
- `src/base58.rs:12,28,38,68,75` (Base58Check/WIF; mainnet constants at
  `:7-9`).
- `apps/site/key.js:2,6,90-100,231-289,992-996` (client-only key state, WASM load,
  derive call, pagehide cleanup).
- `apps/site/key.html:25-26` (current warning), `:145` (script include).
- `src/coordinator/mod.rs:31-41` (embedded pages/WASM), `:490-505`
  (`static_asset`; no CSP today), `:989-996` (asset tests).
- `apps/site/docs.html:86,95`; `README.md:256,272` (read-only/no-signing claims).
- `.github/workflows/rust.yml:43-57` (wasm build/test/smoke job).
- Reference page: `ref-site-b/transaction_to_bitcoin_address_p2pkh`
  (fetched 2026-11-16; form lines 551-615, submit lines 818-826, change warning
  line 735, no-broadcast statement line 742, decode links lines 775-778).
- Public endpoint probes (2026-11-16): mempool.space and blockstream.info
  `POST /api/tx` return `Access-Control-Allow-Origin: *` and a Bitcoin Core
  `sendrawtransaction` decode error for malformed bodies; BlockCypher
  `/v1/btc/main/txs/push` and `/v1/btc/test3/txs/push` return CORS headers and
  `x-ratelimit-remaining: 1`; Blockchair returns CORS headers and, after a few
  probes, HTTP 430 blacklist; blockchain.info `pushtx` has no CORS.
