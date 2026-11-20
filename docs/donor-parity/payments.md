# Paid datasets: donor flows and a processor-free design

2026-11-20. Method: `curl -sL -A "Mozilla/5.0"` against public pages only. No form was submitted, no account created, no payment made; POST-only responses (`box/box.php`, `script/offer_order.php`) were read from their callers, not called. Facts below are marked **observed** (page markup/copy) or **inferred** (what the markup implies).

## 1. What ref-site-b actually does

**`/wallets` ("Buy rich list"). Observed:** each asset row ends with
`<label class="generate"><input type="radio" name="buysell" value="btc" hidden><span>Buy rich list</span></label>`.
A click handler POSTs only `{buysell: "<asset>"}` to `box/box.php` and injects the HTML response into `div#mistake` under the table. The public list shows **no price, no contact field, no delivery text and no payment address**; 36 of 45 rows have the action. The page stylesheet defines `.download_box`, `.download_curl` (a copyable command block, max-width 750px) and `.download_expire` (green 12px line), but the public markup never uses them. **Inferred:** the unseen widget is where the price quote, payment target and download command/expiry appear; its contents are unverified. The brief says price is by request, which matches the absence of a price column value for the dump.

**`/rent` (capacity rental). Observed:** one `form#form1` with hidden `action`, `packs` (1–999), `pay` (coin amount) and `coin` (7 options: BTC, ETH, LTC, USDT TRC20/BEP20/ERC20, USDC ERC20). Defaults: 1 pack, **79 USD**, USDT BEP20, `100.000.000.000.000` keys checked in 7 days. Every change AJAX-POSTs the serialized form to `script/offer_order.php`; the JSON reply selects one of four states: `mistake` (red), `order` (grey, button hidden), `payment` (purple, button hidden), or a price refresh. **There is no e-mail, wallet-address or memo field.** Copy says results and logs are stored "privately in your account" and the job starts after earlier orders in the queue; the CTA points to `/results`. **Inferred:** the order is bound to the logged-in account/session, not to a paying wallet.

**Identification. Observed:** `/register` requires username, e-mail, password, confirmation and a policy checkbox, then a 6-digit e-mail code. `/login` accepts username-or-email, password and optional 2FA. `/profile` redirects to `/login` when logged out. Footer contact is `info@ref-site-b` (copy-to-clipboard). `/terms`, `/faq` and `/payment` return HTTP 404; the registration checkbox names four policies but has no links to them.

**Other surfaces. Observed:** `/programs` is a free direct ZIP (`/program/SecretScan2.05.zip`) with version and SHA-256; `/dashboard` is a zeroed rig dashboard whose identity is the client flag `-user YourLogin.RigName`. Neither is a paid-delivery page. `/results` is an account/session table with a 1-year retention note.

## 2. Weaknesses and risks for us

- **Price by request is a manual funnel.** No self-serve quote, no visible terms, no refund policy, no SLA; the buyer must wait for an operator and trust an e-mail thread. For us that means support load and no audit trail unless we build one.
- **Identity and payment matching are not demonstrated.** The rich-list trigger carries only an asset code. If the unseen widget does not collect a contact, the operator cannot know who paid; if it does, that mapping is manual. `/rent` has no contact field at all, so its order is account-bound and a payment from an unrelated wallet is unattributable.
- **Static addresses and bearer links.** A reused deposit address cannot distinguish two buyers; an unexpiring download link can be forwarded, indexed or leaked. Nothing public shows per-order expiry or revocation.
- **Chargebacks** apply only if cards are added; crypto removes them but adds underpayment, wrong-chain, wrong-token, exchange-withheld-fee, reorg and price-drift cases.
- **The product itself is the biggest risk for Rotor.** `src/coordinator/wallets.rs` already serves six rich lists under the MIT License at `/api/v1/wallets/<slug>/download`, and `ref-site-a/downloads` gives ten comparable files (15.30 GB) as direct links, marked `isAccessibleForFree: true` and CC0. Selling those same raw snapshots would be both undercut and legally muddled. The paid item must be a distinct artifact: packaged/historical snapshots, cleaned/normalised data, custom extraction, freshness or support — with its own licence.
- **Account coupling** (password, optional 2FA, e-mail verification) is unnecessary for a one-off download and creates PII and takeover risk.

## 3. Recommended flow

**Order creation.** `POST /api/v1/orders {list, contact?}`. The server reads the price from a fixed table, freezes the coin/USD rate, creates `order_id`, and derives a **per-order deposit address** from a watch-only HD xpub — one address per order on BTC/LTC and on each accepted account chain. Per-order address avoids memo parsing; ERC-20/TRC-20 wallet transfers have no memo, so do not design around one. Fallback where derivation is unavailable: one fixed address plus a unique atomic amount suffix. Return only `order_id`, `asset`, `amount`, `address`, `expires_at` (30 min quote) and a random **order token** for status polling. Contact is optional e-mail or Telegram, used only for delivery and support.

**On-chain verification.** A coordinator thread polls public endpoints (Esplora for BTC/LTC, TronGrid for TRON, JSON-RPC for EVM/BSC) every 30–60 s. Accept only the configured chain and, for tokens, the exact contract. Credit at **BTC 3 / LTC 6 / TRON 19 / ETH 12 / BSC 15** confirmations; below that the order stays `confirming`. Accept `amount >= quoted`; overpayment is kept, underpayment stays `awaiting_payment` with a top-up hint. One `(chain, txid, vout)` may pay one order only. A reorg below the threshold reverts to `confirming`. Payment after order expiry becomes `late_paid` for manual refund/credit, not auto-delivery.

**Delivery.** On `paid`, create an entitlement and issue
`GET /api/v1/orders/{id}/download?token=<HMAC(order_id|list_id|exp|nonce)>`.
The URL is `no-store`, `no-referrer`, `noindex`, expires in 7 days, allows 5 downloads, and is tied to both order and list. The order page shows status and the link; if contact was given, the same link goes by e-mail/Telegram. The buyer needs no account.

**Abuse controls / non-goals.** One entitlement per order; download counter; revoke on refund or fraud; rate-limit by IP and token; never log raw tokens (store hashes); return 404 for bad tokens. We deliberately do **not** take cards or use a processor, hold a custodial balance or offer withdrawals, require an account, store private keys (watch-only xpub only), auto-refund, or paywall MIT/CC0 data that is already free.

## 4. Minimal data model and endpoints

`lists(id, slug UNIQUE, chain, title, file_path, sha256, bytes, version, price_usd_cents, active)`;
`orders(id PK, list_id, chain, asset, amount_atomic TEXT, deposit_address, contact_kind, contact_value, status, created_at, expires_at, paid_at, order_token_hash)`;
`payments(id, order_id, chain, txid, vout, from_address, amount_atomic, confirmations, block_height, status, seen_at, confirmed_at; UNIQUE(chain,txid,vout))`;
`entitlements(id, order_id UNIQUE, list_id, token_hash, expires_at, max_downloads, downloads, revoked_at)`.

Endpoints: `POST /api/v1/orders`; `GET /api/v1/orders/{id}` (order token); `GET /api/v1/orders/{id}/download?token=…`; `POST /api/v1/admin/orders/{id}/revoke` (admin token). Payment verification is a background poller, not a public endpoint; an admin `POST /api/v1/admin/payments/reconcile` can force a re-check.

## 6. Owner decision (2026-11-20)

The owner wants to sell convenience: the same data pre-converted and sorted for
the desktop app (plus raw where useful), on the reasoning that a buyer pays to
skip the search, not for exclusive rights. That is legitimate:

- **CC0 / public-domain data** (the donor's dumps) may be redistributed or sold;
  no permission is needed.
- **MIT data** (our own six lists) may also be sold, but every copy must keep the
  MIT licence text and copyright notice, and the buyer must not be told the data
  is exclusive.
- The earlier "cannot sell raw snapshots" note overstated the legal point. The
  real constraints are commercial (the same data is free elsewhere) and
  bookkeeping (ship the licence/attribution inside every delivered package).

So the paid artifact is: the converted/sorted bundle for the desktop app,
optionally with the raw files, delivered with the licence and provenance page.
The order/payment/entitlement flow in §3 stands unchanged.

## 5. Open questions for the owner

1. What exactly is sold, given the MIT/CC0 lists are already free — packaged history, custom extraction, commercial licence, support?
2. Which chains/assets: BTC, LTC, USDT TRC20, USDT ERC20, USDC ERC20, native EVM?
3. Price per list and bundle; quote TTL; who bears network fees.
4. Refund/underpayment/overpayment policy, and the legal/tax jurisdiction.
5. Confirmations, link expiry/download cap, and whether contact is optional or required.
6. Key custody: xpub-only derivation, sweeping schedule, and who can revoke.
