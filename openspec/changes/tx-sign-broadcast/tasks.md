# Tasks: transaction building, local signing and broadcast

Legend: `[ ]` pending, `[x]` done. Each section names its blocker and the
primary role. Front (wasm/crypto), page (JS/UI), and server/docs can proceed in
parallel after the ABI decision (T0); do not merge the page against a
half-finished ABI.

## 0. Decisions and preconditions (blocked by: —; analyst + critic)

- [ ] Decide hand-rolled vs `k256`/`secp256k1` for signing (design D5.4):
      prototype both, measure wasm size and build time, record the decision in
      `design.md`.
- [ ] Freeze the binary plan layout and the `sign_p2wpkh`/`decode_tx` ABI
      (design D4); add a version byte so it can evolve.
- [ ] Freeze the supported scope: P2WPKH only, SIGHASH_ALL, RBF opt-in,
      mainnet/testnet4/testnet3/regtest; confirm no sweep and no auto-broadcast.
- [ ] Confirm the trust-boundary wording with the owner: "the coordinator does
      not receive the key" is not "the page is safe on a compromised host".
- [ ] Confirm public endpoint policy and attribution requirements; record the
      probe date and results.

## 1. WASM cryptographic core (blocked by: T0; developer)

- [ ] Add scalar inversion mod n (`src/scalar.rs`) with boundary tests
      (1, n-1, 0, n).
- [ ] Implement HMAC-SHA256 over `src/hashes.rs::sha256` (or add a small
      dependency) and RFC6979 nonce generation; test against RFC6979 vectors.
- [ ] Implement ECDSA sign: `r/s`, low-S, DER, SIGHASH_ALL byte; verify the
      signature locally before returning.
- [ ] Implement BIP143 sighash for P2WPKH, including scriptCode
      `0x1976a914{h160}88ac` and all five hash components.
- [ ] Implement the `sign_p2wpkh` ABI: parse the binary plan, rebuild the input
      script from the key, serialize, sign, verify, return JSON (design D4).
- [ ] Implement `decode_tx` (version, marker/flag, inputs/witness, outputs,
      locktime, txid, wtxid, weight, vsize, decoded output addresses).
- [ ] Error paths: truncated plan, unknown script type, wrong network, value
      overflow, zero/too-high outputs, duplicate outpoints, failed verify;
      fixed English messages, no key material.
- [ ] Zero the key buffer after signing; drop the signer wasm instance.

## 2. Address and script codec (blocked by: T0; developer)

- [ ] Bech32/bech32m decoder with checksum, mixed-case rejection, HRP and
      witness version/program-length rules (the current module is encoder-only,
      `crates/rotor-wasm/src/bech32.rs:81`).
- [ ] Base58Check output decode with version checks for P2PKH/P2SH on
      mainnet/testnet; reject wrong-network addresses.
- [ ] Address -> scriptPubKey for P2PKH, P2SH, P2WPKH, P2WSH, P2TR.
- [ ] Script -> address for the local preview (known scripts only; others as
      hex).
- [ ] Fixtures: BIP173/BIP350 valid/invalid vectors, version bytes, round
      trips, burn address and mixed-case rejection.

## 3. Network-aware derivation (blocked by: T0; developer)

- [ ] Replace the hardcoded mainnet constants in `src/base58.rs:7-9` with a
      network parameter; keep the old helpers as mainnet wrappers.
- [ ] Add `derive_report_net(priv_ptr, curve, network)` and keep
      `derive_report` as a mainnet wrapper (design D3).
- [ ] Derive P2PKH/P2SH/WIF for testnet (0x6f/0xc4/0xef) and regtest (`bcrt`);
      P2WPKH/P2TR HRPs `tb`/`bcrt`.
- [ ] Update `crates/rotor-wasm/smoke.mjs` and the page to select the network;
      assert the mainnet output is unchanged.
- [ ] Testnet WIF parse and mainnet WIF parse; reject a WIF from the wrong
      network in the signing flow.

## 4. Data layer: UTXOs, fees, selection (blocked by: T3; developer)

- [ ] Fetch UTXOs from mempool.space for the selected network; parse the
      observed shape `{txid,vout,status,value}`.
- [ ] Cross-check with blockstream.info; match by `(txid,vout)` and flag value
      differences as blocking (design D7).
- [ ] Strong mode: fetch `/api/tx/<txid>/hex`, parse locally, verify the output
      value and scriptPubKey for each selected outpoint.
- [ ] Fee presets from `/api/v1/fees/recommended`; manual sats/vB override;
      fixed/clearly-labeled testnet fee behavior when the endpoint is absent.
- [ ] Largest-first selection with iterative fee/change/vsize solving; dust
      handling (294 sats at the default relay rate, derived); input cap and
      clear errors for >500 UTXOs.
- [ ] Build the binary plan for the wasm signer; keep the plan and the review
      model in one source of truth (no duplicated fee math in JS).
- [ ] Refuse unconfirmed UTXOs unless the user opts in; show the unconfirmed
      warning.

## 5. Page and safety UX (blocked by: T1, T4; developer + designer)

- [ ] Add a "Build and sign" tab/section to `web/key.html`/`web/key.js`; keep
      the default explorer read-only.
- [ ] Network selector (testnet default for signing, mainnet explicit) and the
      corresponding address/WIF rows.
- [ ] Output editor: address + sats, add/remove rows, per-output validation and
      network detection; no "send max"/sweep control.
- [ ] Review screen: inputs, outputs, change, fee, fee rate, vsize, RBF,
      locktime, txid/wtxid, raw hex, warnings; sign disabled until acknowledged.
- [ ] Mainnet typed confirmation; testnet normal confirmation; network badge on
      every review and broadcast panel.
- [ ] Invalidate the signature on any edit (key, network, inputs, outputs, fee,
      RBF); clear raw tx/txid; no stale "signed" state.
- [ ] Fee/output guardrails (design D8.2/D13) with explicit confirmation.
- [ ] Local preview via `decode_tx`; external links only after broadcast or with
      a pre-broadcast warning.
- [ ] Warnings: funded-key stop message, testnet-first, trust-boundary
      statement, no "safe on any host" claim.
- [ ] Responsive 375/768/1280, keyboard, focus, reduced motion; run
      `impeccable detect`.

## 6. Key handling and worker (blocked by: T1, T5; developer)

- [ ] Add `web/key-signer.js` worker: receives the key once, derives the
      report, signs on request, never fetches, zeroes buffers, terminates on
      clear/pagehide (design D10).
- [ ] Remove the long-lived page copy of the key where possible; clear the
      password input and `state.keyBytes` after handoff.
- [ ] Zero the wasm key buffer after signing and drop the signer instance.
- [ ] "Clear key" terminates the worker and clears all derived rows and signed
      state.
- [ ] No storage, URL, console, analytics or third-party script; assert with
      the leak test (T9).
- [ ] Document the residual-memory limitation honestly in the page and README.

## 7. Broadcast (blocked by: T1, T4; developer)

- [ ] Implement mempool.space primary (raw hex, text/plain), blockstream.info
      secondary, BlockCypher optional last resort, per network (design D11).
- [ ] Compare the returned txid with the local txid; confirm with
      `GET /api/tx/<txid>`; never show success on a bare 200.
- [ ] Map errors: decode/script/fee (stop), already-known (confirm then
      success), 429/5xx/network (backoff and next provider), CORS/timeout.
- [ ] Serialize attempts; no parallel broadcast.
- [ ] All-fail state: keep raw hex, copy/save, show per-provider errors and
      manual broadcast links; no auto-retry.
- [ ] Re-probe CORS/endpoints at implementation time; record the date and
      results in the change notes.

## 8. Server, docs and embedding (blocked by: T5; developer)

- [ ] Embed `/key-signer.js` in `src/coordinator/mod.rs:31-41,490-505` and add
      the content-type test (`:989-996`).
- [ ] Add the CSP, `Referrer-Policy: no-referrer` and
      `X-Content-Type-Options: nosniff` for `/key` (design D14); verify the
      balance and broadcast origins are allowed.
- [ ] Update `web/docs.html:86,95` and `README.md:256,272`: remove "read-only/
      no signing"; describe the signing tab, providers, testnet-first, and the
      trust boundary.
- [ ] Add a short "not a wallet" section that explains hardware/air-gapped
      signing for real funds and the "compromised host can steal the key"
      limitation.
- [ ] No new coordinator API that accepts keys or signed transactions; assert
      no such route exists.

## 9. Tests and CI (blocked by: T1-T8; tester + critic)

- [ ] BIP143 P2WPKH signed-transaction vector, exact raw hex/txid/signature.
- [ ] Address decode vectors (BIP173/BIP350/Base58Check) and malformed-input
      tests (no panics).
- [ ] `decode_tx` fixture: txid/wtxid/weight/vsize/outputs match an independent
      reference.
- [ ] Tamper tests: mutate an output after signing -> local verify fails and
      `testmempoolaccept` rejects; UI returns to unsigned.
- [ ] Regtest end-to-end job: fund, build, sign, `testmempoolaccept`,
      `sendrawtransaction`, mine, assert destination and change balances
      (design D15.3). Pin Bitcoin Core; no mainnet.
- [ ] Node wasm smoke extension and worker test.
- [ ] Broadcast mocked tests: fallback order, 429/5xx, deterministic 400,
      already-known, all-fail, txid mismatch.
- [ ] Key-leak browser test: intercept network/storage/URL/console; key hex/WIF/
      decimal absent; only the raw tx is POSTed.
- [ ] Manual testnet4 acceptance with `TESTNET_WIF` (not CI); record the txid
      and the destination amount in the PR.
- [ ] `cargo fmt`, `clippy`, `cargo test`, wasm build, Node tests, `impeccable
      detect`.
- [ ] Critic review of the crypto/codec diff before merge; explicit sign-off on
      the trust-boundary wording.

## 10. Rollout and acceptance (blocked by: T9; orchestrator + owner)

- [ ] Run the acceptance criteria in `proposal.md` one by one and record
      evidence (vectors, regtest output, testnet txid, leak-test output).
- [ ] Manual browser pass on mainnet with a small/known key only if the owner
      explicitly accepts the risk; otherwise testnet + regtest only.
- [ ] Merge via PR (large change), deploy through the normal image/Watchtower
      path, verify `/key` serves the new worker and CSP.
- [ ] Announce the new capability with the safety caveats; do not market it as
      a wallet.
- [ ] Follow-up changes: P2SH-P2WPKH, P2TR key-path, P2PKH legacy, offline
      bundle, PSBT export.

## Out of scope
- Sweeping, "send max", automatic consolidation, address books, fiat.
- ETH/TRON/Solana signing, taproot script path, multisig, PSBT, hardware
  wallets, RBF bumping/CPFP, coinjoin.
- Server-side signing, key escrow, telemetry, a coordinator broadcast proxy.
- Sending a pre-broadcast transaction to a third-party decoder.
