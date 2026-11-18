# Site wallet studio: parity plan

## Summary

Rotor already derives keys and addresses for 18 chains in the browser, but the
key page is still a pile of separate cards, addresses have no explorer links,
wallet presets and the curve illustration are detached from the address list,
the seed page cannot choose entropy/mnemonic conventions, and there is no
transaction flow. This change turns the site into one compact wallet studio:
an entity calculator with the same layout and controls on every page, dynamic
on-chain data, a real seed generator, and a reviewed signing path.

## Why now

- The owner compared the live key page with `ref-site-a/key/<WIF>` and
  `ref-site-b/Easy_bitcoin_transaction_online`: the donor is denser,
  address rows link to explorers, and data appears in place after a check.
- Current split: `apps/site/key.html` keeps wallet presets and the curve plot
  in a hidden advanced block, while `apps/site/key.js` renders addresses with a
  second, unrelated row layout. Users see two toolbars for the same address
  types.
- `apps/site/seed.html` derives nine fixed paths but cannot choose entropy
  length, mnemonic type (BIP39 / Electrum old / Electrum BIP39), passphrase or
  number of addresses.
- `openspec/changes/tx-sign-broadcast/` already specifies local BTC signing;
  it is not linked from the key page UI.

## Goals

1. Every derived address has an explorer link for its chain; every BTC row
   keeps its WIF link to `/key/<WIF>`.
2. Key page becomes donor-dense: total value / has balance / active chains /
   checked counters, a compact key-facts block, and address rows that fill in
   dynamically.
3. One address toolbar: chain filter, address type, derivation path, wallet
   preset, address count, online balance toggle. Presets and the curve editor
   move into it; the separate advanced card disappears.
4. Curve illustration becomes a real interactive SVG: presets (secp256k1 /
   ed25519), draggable point, editable X/Y fields, copyable values, reduced
   motion respected.
5. Seed studio generates BIP39 (12/15/18/21/24) and both Electrum schemes,
   optional passphrase, path presets, N addresses, per-address balance checks.
6. Transaction flow exposes the existing `tx-sign-broadcast` design from the
   key page, still local-signing only, never custody.
7. Cloudflare migration plan is recorded, with a hybrid first phase instead of
   a risky full rewrite.

## Non-goals

- No server-side key, WIF, seed or signing. No sweeping and no automatic
  broadcast.
- No public directory of vulnerable third-party keys. Milk Sad remains an
  owner audit / seed calculator.
- No chain scanner for arbitrary addresses outside the user's own input.
- No full Cloudflare rewrite of GPU/lease proof logic in phase 1.

## Success criteria

- A visitor opens `/key/<hex>` and sees explorer links on every address, WIF
  link, counters and balances without scrolling twice.
- `Address type` and `Wallet preset` controls look and behave identically on
  key, chain and seed pages.
- Seed page can produce a 12/24-word BIP39 phrase and both Electrum variants,
  show the derivation path and N addresses, and check balances.
- Signing flow is reachable, testnet-first, and its review screen shows every
  input/output before broadcast.
- Cloudflare phase 0 keeps the current coordinator; no rewrite of proofs.
