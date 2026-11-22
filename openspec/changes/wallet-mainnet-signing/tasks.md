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
- [ ] ERC-20 approvals grant: an explicit allowance amount and a separate
  review, reusing the same approval reader and signing gates.
- [ ] Bitcoin mainnet: UTXO/fee source, mainnet WIF policy, address type and
  broadcast provider, with its own fee cap.
- [ ] TRON mainnet: requires a TRON provider API key; document the key source
  and never ship it in the static site.
