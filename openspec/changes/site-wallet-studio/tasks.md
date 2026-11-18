# Tasks: site wallet studio

Roles: [front] `apps/site/**`, [back] `src/coordinator/**`,
[wasm] `crates/rotor-wasm/**`, [ops] CI/CF, [qa] browser evidence.
Every unchecked task has a concrete artifact; checked tasks need a test or a
browser capture in the PR.

## 1. Explorer links and WIF rows [front]
- [ ] Add one explorer map in `apps/site/browse.js` and use it for chain rows;
      add the same map to `key.js` for derived rows. (blocked by: -)
- [ ] Address text itself links to the explorer; external icon and
      `rel="noopener noreferrer"`.
- [ ] Every BTC row keeps the compressed WIF link to `/key/<WIF>`; details show
      both WIFs with links.
- [ ] Mobile: address and WIF use ellipsis with full value in `title`; copy
      buttons remain 34px+.
- Evidence: browser capture of BTC, EVM, TON rows; no 404 explorer prefixes.

## 2. Key page density [front]
- [ ] Add the four counters (total value, has balance, active chains,
      checked N/N) above key facts; hide until the first successful derive.
      (blocked by: 1)
- [ ] Compact key-facts block: HEX, DECIMAL, WIF, WIF(U), KEYPAIR(SOL),
      SECRET(XRP), PUBKEY, PAGE. Each row has copy; WIF links to `/key/wif`.
- [ ] Balance checks on by default; per-row spinner → value/error; retry on
      failure; `updated` timestamp.
- [ ] Registry match line remains visible and honest (0 matches = no warning).
- [ ] Remove the detached advanced card; keep only the merged toolbar.
- Evidence: desktop 1440 and mobile 375 captures; Lighthouse a11y ≥ 95.

## 3. Merged address toolbar and presets [front]
- [ ] One toolbar component used by key, chain and seed pages: chain chips,
      address type, path preset, custom path, wallet preset, count, balances.
      (blocked by: 2)
- [ ] Address-type buttons share exactly the same class/DOM on all three pages.
- [ ] Preset changes filter/highlight rows, never change the derivation;
      show a one-line explanation.
- [ ] Add `Master key`, BIP44, BIP49, BIP84, BIP86 path chips; custom path input
      validates `m/…` and is informational (the page takes a final key).
- Evidence: same visual snapshot of the toolbar on `/key/<hex>`, chain browser,
      seed page.

## 4. Curve editor [front]
- [ ] Replace `#curve-plot` with an SVG component: curve, point P, −P, P+G.
      (blocked by: 3)
- [ ] Drag point; X/Y numeric fields two-way bind; keyboard arrows move;
      `Random`, `Reset`, `Copy` actions.
- [ ] Caption states finite-field vs real illustration; reduced motion.
- Evidence: keyboard and pointer interaction script; mobile no overflow.

## 5. Seed studio [front+wasm]
- [ ] Entropy 12/15/18/21/24 and BIP39 generation/validation. (blocked by: 3)
- [ ] Electrum old (1626-word) and Electrum BIP39 derivation; separate
      wordlist and tests against published vectors.
- [ ] Passphrase, all-paths toggle, chain selector, address count 1/3/5/10,
      `Convert & Check Balance`.
- [ ] Results grouped by chain: path, address, balance, explorer link; CSV.
- [ ] Never store/upload phrase; clear on pagehide; no key in URL.
- Evidence: BIP39 vector, one Electrum vector, mobile capture.

## 6. Milk Sad seed studio parity [front]
- [ ] Reuse the seed toolbar: entropy, mnemonic type, passphrase, path, count.
      (blocked by: 5)
- [ ] Keep seed browser pagination and owner range audit; no balance ranking.
- Evidence: seed 0 official vector and a 60-seed page capture.

## 7. Signing entry [front, links tx-sign-broadcast]
- [ ] Add `Build transaction` entry on the key page behind the explicit gate
      from `tx-sign-broadcast`. (blocked by: 6)
- [ ] Testnet first; review screen shows inputs/outputs/fee/change; no broadcast
      without a separate confirmation.
- Evidence: testnet fixture transaction signed and decoded; no server request
      containing key/WIF/seed in DevTools.

## 8. Cloudflare phase 0 [ops]
- [ ] Add `cf/worker` + `wrangler.jsonc`: static assets, public API cache,
      origin proxy via Tunnel, edge rate limits. (blocked by: -)
- [ ] Keep `/api/v1/lease|result|heartbeat` on origin; document signed proxy
      headers and timeout budget.
- [ ] Deploy to a staging domain; compare latency and errors; rollback plan.
- Evidence: staging URL, 5xx/429 dashboards, origin still reachable.

## 9. Cloudflare phase 1 [ops]
- [ ] D1 schema for accounts/sessions/watchlist/events; one-off migration from
      `monitor.json`. (blocked by: 8)
- [ ] Cron watcher + Queues for Telegram; idempotent event insert.
- [ ] Cabinet reads/writes through Worker; tests for auth and rate limits.
- Evidence: staging alert end-to-end, no duplicate events after restart.

## 10. Cloudflare phase 2 (only if load justifies) [ops]
- [ ] DO per job for leases/alarms; R2 manifest per range; Queue for results.
      (blocked by: 9)
- [ ] Batch leases and heartbeats; load test 1k clients; document DO limits.
- Evidence: load test report and cost estimate.

## 11. QA and archive [qa]
- [ ] Walk `ui-checklist` on every changed page at 375/768/1440.
- [ ] Run `node scripts/check-projects.mjs`, `cargo test`, clippy, WASM smoke.
- [ ] Record gate #1 and #2 verdicts under `reviews/`.
- [ ] Archive the change and update `openspec/specs/key-explorer/spec.md`.
