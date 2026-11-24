# Tasks: wallet mainnet signing (first slice)

## 1. Chain descriptor and codec

- [x] Add one `NETWORKS` descriptor table in `apps/site/wallet-evm.js` with
  chain id, name, symbol, testnet flag, explorer, RPC list and `feeCapWei`
  for Sepolia, the eight EVM mainnets and the BNB testnet route used by
  `/send`.
- [x] Refuse a chain id that is not in the table (`assertKnownNetwork`).
- [x] Enforce the mainnet arm in the codec (`assertMainnetArmed`), not only in
  the DOM.
- [x] Validate recipients with EIP-55; all-lowercase is checksum-free, any
  uppercase letter must match the checksum, and the zero address is refused.
- [x] Pin the whole unsigned transaction at confirm: rebuild it from the
  reviewed fields and compare byte-for-byte with the reviewed unsigned hex
  before signing, so a mutated token contract, nonce or fee refuses.
- [x] Require `eth_estimateGas` + 20% buffer for an automatic mainnet gas
  limit; keep the manual override explicit and reviewed.
- [x] Refuse when `amount + gasLimit × maxFeePerGas` exceeds the balance.
- [x] Refuse when `gasLimit × maxFeePerGas` exceeds the per-chain cap, with
  the exact fee and cap in the message.
- [x] Keep a native mainnet transfer data-free and non-zero; a token send
  carries exactly the locally built `transfer(address,uint256)` calldata and
  value 0.
- [x] Re-read `eth_chainId` in `confirmTransaction`; sign once and broadcast
  once; show provider errors verbatim without retrying.

## 2. Cabinet wallet UI

- [x] Populate the network picker from `walletNetworks()`; Sepolia stays the
  default and mainnet is never preselected.
- [x] Populate the provider picker from the selected network's RPC list.
- [x] Add the mainnet arm checkbox as a labelled 44px `.wallet-check` control;
  reset it on lock, unlock and reload; hide it on testnet.
- [x] Pass `mainnetArmed` to prepare and confirm.
- [x] Show chain name, from, to, amount, gas limit, max fee, maximum network
  fee, total, balance and fee cap on the review screen with the chain's
  native symbol.
- [x] Invalidate the review when the form, entry, network, provider or arm
  changes.
- [x] Point the explorer link at the selected chain.

## 3. Tests

- [x] Pin an Ethereum mainnet native-transfer signing vector against an
  independent ethers 6.17.0 raw transaction and its Keccak-256 hash.
- [x] Pin ERC-20 `transfer(address,uint256)` calldata and an ERC-20 mainnet
  signing vector against independent ethers 6.17.0 output.
- [x] Add ERC-20 refusals: a contract address without code, decimals outside
  0–24, a symbol longer than 32 characters or non-printable, a balance below
  the amount, data supplied by the form, a chain switch, an unarmed mainnet
  review and a mutated recipient/amount/value/contract/nonce/fee.
- [x] Add stubbed-RPC refusals: wrong chain id, id outside the table, bad
  checksum, zero address, unarmed mainnet, fee cap, balance, calldata and
  zero amount.
- [x] Assert one broadcast, no retry and no private key in any RPC payload.
- [x] Register `node apps/site/wallet-mainnet-test.mjs` and
  `node apps/site/wallet-erc20-test.mjs` in `projects.json`.

## 4. Copy and docs

- [x] Remove the stale "mainnet signing stays disabled" copy from the wallet
  page and module; keep Bitcoin testnet wording honest.
- [x] State the fee caps in the page copy and in this change.
- [x] Update the `/cabinet/wallet` note in `docs/site-map/site-map-data.js`.

## 5. Verification

- [x] `node apps/site/wallet-evm-test.mjs`
- [x] `node apps/site/wallet-mainnet-test.mjs`
- [x] `node apps/site/wallet-erc20-test.mjs`
- [x] `node apps/site/send-test.mjs`
- [x] `node apps/site/amount-test.mjs`
- [x] `node scripts/ui-audit.mjs --serve`
- [x] `node scripts/check-projects.mjs`
- [x] `node scripts/check-defect-ledger.mjs`
- [x] `node scripts/check-ssot.mjs`
- [x] `cargo test --release --test coordinator_api`

## 6. ERC-20 approvals (read + revoke)

- [x] Add an approvals panel that reuses the send owner, network and provider
  controls and accepts a token contract with the transfer validation (EIP-55
  or all-lowercase, contract code present, 0–24 decimals, printable symbol of
  at most 32 characters).
- [x] Scan `Approval(address,address,uint256)` logs with `eth_getLogs` over a
  configurable window (default 50,000 blocks), adapt the chunk to a provider
  range limit, stop honestly at the archive horizon and state the blocks
  actually scanned in the UI.
- [x] Deduplicate by spender keeping the newest log, cap the list at 50 and
  re-read the live `allowance(owner,spender)` for every row; show 2^256-1 as
  "Unlimited" and label each spender EOA/contract via `eth_getCode`.
- [x] Revoke with locally built `approve(spender, 0)` calldata through the same
  chain-id, arm, fee-cap, `eth_estimateGas`, review, unsigned-pin and
  single-broadcast gates; refuse an allowance that is already zero and re-read
  the allowance after broadcast.
- [x] Tests: allowance formatting, chunking and dedupe pure functions, the
  revoke vector against an independent encoding, token refusals, EOA labeling,
  the allowance-zero refusal, chain/arm/fee/unsigned-tamper and mutated
  spender/amount refusals.
- [x] Cover a geth `query returned more than 10000 results` range error,
  malformed matching logs (skipped, counted and surfaced in the warnings) and
  the degenerate empty coverage range.
- [x] Add a route-specific `ui-audit` scenario with a stubbed RPC for the
  approvals table (shared `.data-table`/`.table-scroll`, 44px labelled actions,
  `Unlimited`/`Contract`/`EOA` labels, truncated warning, no overflow) and a
  defect-ledger entry for the previously unchecked surface.
- [x] Register `node apps/site/wallet-approvals-test.mjs` in `projects.json`,
  update the `/cabinet/wallet` site-map note and the page help text (window
  limit, no indexer, no granting in this slice).

## 7. Next slices

- [x] ERC-20 transfer: optional token contract field on `/cabinet/wallet`;
  `eth_getCode`, `decimals()`, `symbol()` and `balanceOf(owner)` reads; refusal
  for an EOA address, decimals outside 0–24, a symbol longer than 32
  characters or non-printable, and a balance below the amount; local
  `transfer(address,uint256)` calldata with value 0; the same chain, arm, fee
  cap, gas estimate, review and single-broadcast gates.
- [x] ERC-20 approvals grant: an explicit allowance amount or the
  `Unlimited (2^256-1)` option; `approve(spender, amount)` built locally
  (selector `0x095ea7b3`, spender and amount padded, unlimited is exactly
  `2^256-1`); a separate review that shows the token, the spender type
  (Contract/EOA), the amount or Unlimited, the gas limit and the maximum native
  fee, plus a visible unlimited warning line; zero and values above `2^256-1`
  refused, as are the zero spender and the token contract as its own spender,
  while an EOA spender is allowed and labelled. The grant reuses the token
  header/code read, chain-id-twice, mainnet arm, fee cap, `eth_estimateGas`,
  nonce, unsigned-pin and single-broadcast gates and re-reads the allowance
  after broadcast. Pinned by finite and unlimited calldata vectors and an
  unlimited signed vector against ethers 6.17.0, with the extended
  `wallet-approvals-surface` detector covering the grant form and review.
- [ ] Bitcoin mainnet: UTXO/fee source, mainnet WIF policy, address type and
  broadcast provider, with its own fee cap.
- [ ] TRON mainnet: requires a TRON provider API key; document the key source
  and never ship it in the static site.

## 8. TRON mainnet slice (ROT-511)

Goal: TRX and USDT TRC-20 transfers from an imported key on TRON mainnet, one
code path with the Nile testnet route, behind the same mainnet arm gate.

- [x] Provider data: add `trongrid` (`https://api.trongrid.io`) and
  `publicnode` (`https://tron-rpc.publicnode.com`) to `data/providers.json`
  under chain `tron`, both keyless and CORS-enabled; regenerate
  `chains.generated.js` and `crates/rotor-core/src/generated/chains.rs`
  (`node scripts/gen-ssot.mjs`). No API key is shipped; document the rate
  limit and the failover order.
- [x] WASM encoder: extend `crates/rotor-wasm/src/tron.rs` with an explicit
  contract kind (`trx` | `trc20`) and a TRC-20 `token_contract_address`;
  encode `TriggerSmartContract` (type 31) with the type URL
  `type.googleapis.com/protocol.TriggerSmartContract`, `owner_address`,
  `contract_address` (21-byte `0x41` payload) and
  `data = a9059cbb || pad32(recipient-20-byte) || pad32(amount)`.
  `amount` stays raw base units; the encoder never converts decimals.
- [x] Strict parsing: unknown, duplicate or missing fields are refused, a
  `trc20` request without a valid token contract is refused, a `trx` request
  carrying a token contract is refused.
- [x] Signing is unchanged: SHA-256 over `raw_data`, RFC 6979 nonce, 65-byte
  `r || s || v` with `v = 27 + recovery_id`; the signature verifies against
  the derived public key in the same call.
- [x] Cabinet wallet: TRON mainnet and TRON Nile in the network picker; the
  same armed-session checkbox, reset on lock/unlock/reload; the arm check runs
  in the codec, not only in the DOM. The public `/send` page stays testnet-only.
- [x] Rebuild `apps/site/rotor_wasm.wasm` in the same change and update
  `apps/site/tron-tx.js` to send `kind: "trx"`: the request schema is now
  strict, so a stale adapter would fail at runtime. The Nile `/send/tron` route
  and `apps/site/tron-tx-test.mjs` must keep passing against the rebuilt
  binary.
- [x] Build from the node (`getnowblock` for `ref_block_bytes`,
  `ref_block_hash`, `timestamp`, `expiration`), refetch immediately before
  signing, refuse an expired review.
- [x] Review screen: network, from, to, kind (TRX / TRC-20), token contract and
  symbol when known, amount in base units and display units, `fee_limit` in
  TRX, and the "irreversible" warning. No broadcast without a second
  confirmation.
- [x] Broadcast once through the pinned provider allowlist; show the provider
  error verbatim; never retry.
- [ ] Tests: pinned TRC-20 unsigned `raw_data_hex` and `txID` against an
  independent encoder, a signed vector that verifies, refusals (wrong kind,
  missing contract, malformed base58, wrong network prefix, zero amount,
  unarmed mainnet, expired ref block, tampered review), and a mutation that
  drops the selector, the recipient padding or the amount and fails.
- [ ] `node apps/site/wallet-tron-test.mjs` registered in `projects.json`;
  `docs/site-map` note updated; the "TRON mainnet requires an API key" note in
  section 7 replaced with the measured keyless result.
- [ ] Verification: cargo tests, the three wallet Node tests, `check-ssot`,
  `check-projects`, `ui-audit`, and a real mainnet transfer from a funded key
  with a screenshot kept as a CI artifact only.
