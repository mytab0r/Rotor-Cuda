# PRODUCT

## Platform
web

## Stack
Rust coordinator serving embedded static HTML/CSS/JS and a WASM derivation core; no frontend framework, no build step, no external CDN assets.

## Users
Crypto-curious visitors checking how a private key maps to addresses; puzzle participants running workers; wallet owners who want an early-warning watchlist. Most arrive from search on a phone, at night, and decide in seconds whether the tool is credible.

## Product Purpose
Derive public addresses from a private key entirely in the browser, browse deterministic example keys per chain, follow the public puzzle search, and keep a consent-based watchlist of addresses the visitor controls.

## Positioning
Not a wallet and not a custody service: the key never leaves the browser, the server never accepts a key, WIF or seed, and nothing is signed or swept.

## Operating Context
Public landing and directory pages are read on mobile; the key explorer and cabinet are used on desktop and phone. The visual reference the owner set is a dark crypto directory with large chain cards, colored coin marks, generous spacing and a clear search field.

## Capabilities and Constraints
- Eight chain hubs; client-side derivation for BTC, EVM, TRON, SOL, LTC, DOGE, BCH, XRP.
- Puzzle jobs, leases, public stats; wallet-signature login; watchlist and Telegram alerts.
- Every asset is served from the coordinator; no external fonts, scripts or images at runtime.
- No factual claims about balances, holdings or recovery outcomes.

## Brand Commitments
Dark, calm, technical and credible. Amber is the action color. Chain identity uses each chain's own color. No casino styling, no hype, no fake urgency.

## Evidence on Hand
Real deterministic example keys 1..64, real public job/worker APIs, real chain names and address formats. Synthetic demonstration data is allowed only when labelled.

## Product Principles
- Show the mechanism, not a claim.
- The key stays local; say so where the key is entered.
- A first-time visitor understands the tool and the next action without scrolling twice.

## Accessibility & Inclusion
Keyboard reachable, visible focus, reduced-motion respected, body text >=4.5:1, no horizontal overflow at 375px.
