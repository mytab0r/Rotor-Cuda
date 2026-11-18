# Design: site wallet studio

## D1. One entity layout

All calculator pages (`/key`, `/key/hex`, `/key/wif`, `/key/decimal`, `/seed`,
`/milk-sad`, `/key/<hex>`) use the same vertical rhythm:

1. `entity-hero`: icon, title, one-line purpose, three fact chips.
2. `input-card`: one filled field, optional mode selector, primary action,
   secondary actions left-aligned, error line.
3. `entity-links`: cross-links to the other entity calculators.
4. `result-summary`: four compact counters (total value, has balance, active
   chains, checked N/N) shown only after a successful derive/check.
5. `key-facts`: compact label/value/copy rows (HEX, DECIMAL, WIF, WIF(U),
   KEYPAIR(SOL), SECRET(XRP), PUBKEY, PAGE).
6. `address-card`: one toolbar and a list of address rows.

Rules:

- Primary = amber filled, secondary = outline, destructive = outline red.
- One card family: 14–18px radius, 1px border, no nested cards.
- Functional text ≥11px; body ≥12px; measure 65–75ch.
- Phone: labels above values; toolbar wraps; no horizontal overflow at 375px.

## D2. Explorer links

Every row gets an `Open in explorer` link built from a single map in the Rust
chain metadata and mirrored in JS for derived rows:

| chain | URL prefix |
|---|---|
| bitcoin | `https://mempool.space/address/` |
| ethereum / bnb / arbitrum / optimism / base / polygon / avalanche / zksync | chain-specific explorer |
| tron | `https://tronscan.org/#/address/` |
| solana | `https://solscan.io/account/` |
| litecoin / dogecoin / bitcoin-cash / zcash | blockchair address pages |
| xrp | `https://xrpscan.com/account/` |
| sui | `https://suiscan.xyz/mainnet/account/` |
| ton | `https://tonviewer.com/` |

The address itself is the link; a trailing icon marks external navigation.
Bitcoin rows also show the compressed WIF under the addresses, linked to
`/key/<WIF>`.

## D3. Key page density and dynamic data

- After derivation, show four counters above the facts. `Total value` is the
  sum of checked balances in a common unit only when the chain is the same;
  otherwise it shows “mixed chains” and the per-row values.
- `Checked N/N` increments as balance requests finish; failures stay visible
  with a retry action, never silently zero.
- Balance checks are on by default for public addresses, with a visible toggle
  and the provider/privacy sentence next to it.
- Rows show address, balance, transaction count and a small `updated` time.
- The registry warning stays automatic for URL keys and shows match count; no
  hidden network calls.

## D4. Merged address toolbar

One toolbar, in this order:

```
[chain chips] [address type] [path preset ▾] [custom path input]
[wallet preset ▾] [count 1/3/5/10] [online balances] [Check balances]
```

- Address type buttons are the same component on key, chain and seed pages.
- `Master key` and path presets (BIP44/49/84/86) only change the highlighted
  row/filter; the derivation report does not change.
- Wallet presets filter which rows are visible (Ledger, MetaMask, SafePal,
  TronLink, Phantom).
- `count` applies to generated lists (seed, Milk Sad, address book), not to a
  single key report.

## D5. Curve editor

Replace the current plot with an SVG curve:

- Toggle secp256k1 / ed25519; render `y² = x³ + 7` (secp) or the ed25519
  Edwards form with an explanatory caption that the real arithmetic is over a
  finite field.
- Drag a point; numeric `X` and `Y` inputs update it and vice versa.
- Show `P`, `−P`, and `P + G` presets; copy values.
- Buttons: `Random point`, `Reset`, `Copy coordinates`.
- Keyboard: arrow keys move the point by one step; focus ring; reduced motion
  disables the transition.

## D6. Seed studio

`/seed` gets:

- Entropy length selector: 12/15/18/21/24 words (128–256 bits).
- Mnemonic type: BIP39; Electrum old (1626-word legacy); Electrum BIP39.
- Optional BIP39 passphrase.
- “All paths” toggle: BIP44/49/84/86 for BTC, plus EVM/TRON/LTC/DOGE/BCH/XRP
  when the chain selector is not BTC.
- Address count 1/3/5/10 and a single `Convert & Check Balance` primary action.
- Results grouped by chain with address, path, balance, explorer link.
- Generate button produces fresh entropy locally; never stores or uploads.

Electrum old requires its own wordlist and seed derivation; it is a separate
implementation unit, not a flag on BIP39.

## D7. Signing and broadcast

Use the existing `openspec/changes/tx-sign-broadcast/` design. This change only
adds the entry point and the consistent review UI; it must not move keys to a
server. Testnet first, explicit review, no automatic broadcast, no sweeping.

## D8. Cloudflare phases

**Phase 0 (hybrid, recommended).** Static assets + read-only public API at the
edge; `/api/v1/lease|result|heartbeat` and proof endpoints proxy to the current
origin through Cloudflare Tunnel. Cache summary/jobs/workers 5–15s. Nothing in
the Rust coordinator is rewritten.

**Phase 1.** Move accounts, sessions, watchlist, events and Telegram delivery to
D1 + Queues + Cron Triggers. Cabinet reads/writes leave the VPS.

**Phase 2.** Job leases in a Durable Object per job, alarms for expiry, results
through Queues, manifests and BSGS checkpoints in R2. Batch leases (e.g. 64
chunks) and heartbeats (10–15s); never one DO write per chunk. Keep proof
verification and GPU/search off Workers.

Chunk delivery: Worker/DO returns chunk indices plus a signed R2 manifest URL;
desktop clients fetch the manifest directly from R2, then post results in
batches. Keep objects below DO value limits; partition large manifests by range.
