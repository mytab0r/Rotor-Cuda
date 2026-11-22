# Tasks

## 1. Wasm core (wasm-core)

- [x] `evm::personal_message_hash`: EIP-191 preimage
      `"\x19Ethereum Signed Message:\n" + decimal byte length + message`,
      hashed with keccak256.
- [x] `evm::sign_message(key, message) -> [u8; 65]`: RFC 6979 ECDSA over that
      hash, low-S, `r || s || v` with `v = 27 + parity`.
- [x] ABI export `evm_sign_message(key_ptr, key_len, msg_ptr, msg_len)`: `key_len`
      must be 32; result is `0x` + 65-byte hex; the caller's key bytes and the
      stack copy are wiped before return; errors use the same buffer/status
      convention as `evm_sign_tx`.
- [x] Fixture tests against ethers 6.13.4 `Wallet.signMessage`: key 1 with
      `"Hello World"`, the empty message and a SIWE-shaped message, and key 2;
      wrong-key recovery and invalid-key cases.
- [x] Rebuild with `sh scripts/build-wasm.sh` and commit
      `apps/site/rotor_wasm.wasm`.

## 2. Site (site-ui)

- [x] `apps/site/wallet-sign.js`: `signMessage(wasm, key, message)` over
      `evm_sign_message`; the key is written into wasm memory, never copied to
      hex, and the wasm copy plus result are wiped in `finally`.
- [x] `createRequest(base, fetch)` and `signIn({request, address, sign})`:
      challenge request body `{chain:"evm", address}`, login body
      `{chain:"evm", message, signature}`, no bearer on either, token returned
      to the caller only.
- [x] Sign-in card on `/cabinet/wallet`: EVM-capable key selector, derived
      EVM address, one explicit `Sign in with this wallet` action, opt-in
      `Sign me in after creating this wallet` checkbox, signed-in account chip,
      `/cabinet` settings link and `Sign out`.
- [x] Sign in automatically after a key import only when the opt-in box is
      ticked; otherwise show the explicit action and a short explanation that
      the key never leaves the tab.
- [x] ed25519-only entries and keys without an `evm` derivation row show that
      EVM sign-in is unavailable instead of offering the action.
- [x] Store the token under the monitor page's key (`rotor-monitor-token`),
      never render or log it. Lock clears the in-memory session and the panel;
      Sign out calls `/api/v1/monitor/logout`, then removes the token.
- [x] On unlock, validate a stored token once with
      `GET /api/v1/monitor/me`: HTTP 401 clears it and shows the signed-out
      card with no error banner; a network failure keeps the optimistic state.
- [x] Help text: the identity is the derived EVM address; Bitcoin, TRON and
      Solana addresses remain wallet-derived and are not verified.
- [x] Serve `wallet-sign.js` from the coordinator embed and reference it from
      `wallet.html` (no `?v=` token).

## 3. Tests

- [x] `apps/site/wallet-sign-test.mjs` against the committed wasm artifact:
      the ethers vector, exact challenge bytes, key/result zeroing before
      dealloc, empty-message and malformed-key rejection, stubbed-fetch
      challenge/login request shapes, coordinator rejection returning no token,
      empty challenge, invalid address, network/HTTP failures and no console
      output.
- [x] `validateSession` unit tests: a live token calls `GET /me` with a bearer,
      HTTP 401 returns signed out, a network failure is left to the caller and
      an empty token makes no request.
- [x] Coordinator embed test covers the new page/script.
- [x] Site suite: `node apps/site/wallet-sign-test.mjs` plus the wallet tests.
- [x] `wallet-signin-surface` audit against the served coordinator: explicit
      action (44px, unchecked opt-in), a real challenge/login, the account chip
      and settings link, lock hiding the session, unlock restoring it and Sign
      out removing the stored token. Registered in `data/detectors.json`; the
      generated detector tables are current.

## 4. Docs and gates (ops)

- [x] This change: identity model, what is and is not verified, next slice.
- [x] `design.md` (boundaries, signing, flow, session lifecycle, threat model)
      and the delta spec `specs/wallet/spec.md` for archiving.
- [x] `docs/site-map/site-map-data.js` note for `/cabinet/wallet`.
- [x] `check-projects`, `check-ssot`, `check-defect-ledger`,
      `gen-detector-docs --check`, `cargo test --release`, `ui-audit --serve`.

## 5. Next slice (not in this change)

- [ ] TRON `signMessageV2` identity proof from a vault key.
- [ ] Bitcoin message-signing proof; Bitcoin addresses stay unverified until
      it ships.
- [ ] Solana ed25519 identity proof from a seed-derived key.
- [ ] Coordinator identity list for a session, so linked vault entries can be
      shown as verified.
