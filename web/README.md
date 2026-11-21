# web/ — Astro frontend (phase 0-1 pilot)

Static Astro build for the public site. This pilot migrates exactly one route,
`/mnemonic-converter`; the Rust coordinator keeps serving everything else until
the later phases in `openspec/changes/frontend-platform/proposal.md`.

## Commands

```sh
npm ci
npm run check     # astro check + tsc --noEmit
npm run build     # static output in dist/
npm run preview -- --port 4321
npm test          # tsc -p tsconfig.test.json + node --test (no browser)
npm run verify:cdp -- --base http://127.0.0.1:4321   # browser parity + screenshots
```

Node 22.23.4+ (Astro 7.4.13). Dependencies are pinned exactly and
`package-lock.json` is committed; use `npm ci`.

The owner's brief said Node 20+. Astro 5.18.2 was the Node-20 line, but it
carries open high/critical advisories (`npm audit`: Astro XSS/SSRF and a sharp
AVIF RCE, fixed only in 7.2.8+). The pilot pins Astro 7.4.13 and raises the
engine floor instead of shipping a known-vulnerable build tool; this is the
only deviation from the brief and is called out in the PR.

## Layout

| Path | Purpose |
|---|---|
| `src/pages/mnemonic-converter.astro` | The page: same markup and copy as `apps/site/mnemonic-converter.html`. |
| `src/scripts/mnemonic-converter.ts` | DOM glue ported from `apps/site/seed-page.js` (rendering, balances, CSV, generation). |
| `src/lib/seed-core.ts` | DOM-free derivation/validation core, unit- and parity-tested under Node. |
| `public/` | Byte copies of the current site assets, served at their current URLs. |
| `public/vendor/` | Byte copies of the crypto engine loaded by the page. |
| `tests/` | Node tests: fixed vectors from `apps/site/seed-test.mjs` and `apps/site/mnemonic-seeds-test.mjs`. |
| `scripts/cdp-parity.mjs` | Headless-browser check: convert two fixed phrases at 375/768/1280 light/dark, compare addresses, save screenshots. |

## Provenance of copied assets

All files below are byte-identical copies from `apps/site/` taken at the
migration commit. They are not edited in `web/`: the Rust coordinator still
serves the originals, so a change must be made in `apps/site/` first and copied
again (or the asset must move to a single shared source in a later phase).

| web/public file | Source | SHA-256 |
|---|---|---|
| `vendor/seed.js` | `apps/site/seed.js` | `01ef1d3a72ef293815b8922977277f5df1275c3a01f26d9da08895ae64d5b83c` |
| `vendor/seed-crypto.js` | `apps/site/seed-crypto.js` | `a1f569591af5b43fd16f4f86faccc7490d2f407cfbda648ba5f283831ee60d20` |
| `site.css` | `apps/site/site.css` | `892be9a101f0b4dc68b2dc197a6ac39469214b3a8387a0c95acdb92a799bd030` |
| `seed-studio.css` | `apps/site/seed-studio.css` | `f1417cb411fc90dbaba7f69a3cb2c01432e7f4c91eed190d27a1a20ab38f221f` |
| `site.js` | `apps/site/site.js` | `d18660f6ba76251bc7c6acd3275b98efb806d06037dfd6516dda48ca6058a38a` |
| `theme.js` | `apps/site/theme.js` | `b7e582965c67d3102af9da1fba28536ec4ef9e9359a3d35704856c65263d92d5` |
| `icons.svg` | `apps/site/icons.svg` | `68184590c2a787aa8d3107cbdfe7aeada2e4b770850b61806444da2bdb092f4f` |
| `fonts/manrope-latin.woff2` | `apps/site/fonts/manrope-latin.woff2` | `8c2def024c1bf31aacf3624ae3c4d701269b4ec3dc765c04830839f0d36b2d9e` |
| `rotor_wasm.wasm` | `apps/site/rotor_wasm.wasm` | `29ded2b585f4de53bff5298aff82d8c6560c20d6217532b47e5356ddf46dc779` |
| `favicon.ico`, `favicon.png` | `apps/site/favicon.*` | (unchanged) |

`rotor_wasm.wasm` is a generated artifact: after `sh scripts/build-wasm.sh`
rebuilds `apps/site/rotor_wasm.wasm`, copy it here again (the pilot keeps two
copies until phase 6 removes the embedded site). Do not hand-edit it.

## Behaviour notes

- The page loads `/vendor/seed.js`, `/vendor/seed-crypto.js` and
  `/rotor_wasm.wasm` exactly where the current page does. Derivation, WIF and
  address encoding still come from the same code.
- Balances use the same public endpoints (`blockchain.info` for BTC, a public
  Ethereum JSON-RPC endpoint for EVM); only derived public addresses leave the
  page. The phrase, passphrase and keys stay in the tab and are not stored.
- The page HTML uses `createElement`/`textContent`; there is no `innerHTML`
  with data. Source maps are disabled and not published.
- UI copy, CSS and fonts are unchanged from the current page. This pilot does
  not restyle anything.
