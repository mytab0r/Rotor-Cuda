# UI checklist (gate for web changes)

The site has no build step: plain HTML/CSS/JS in `web/`, served by the
coordinator. Before calling a UI change done, walk this list and keep the
evidence (a screenshot or the DOM check below).

## States
- [ ] Every async surface has loading, empty, error and success states with
      actionable text; a failed fetch never leaves a blank card.
- [ ] Busy controls are disabled and say what is happening; destructive or
      long actions have a visible Stop.
- [ ] Zero data is a deliberate message, not a bare table header.

## Layout
- [ ] No horizontal overflow at 375 px:
      `document.documentElement.scrollWidth === clientWidth`.
- [ ] Long mono values (addresses, keys, tokens) wrap inside cards.
- [ ] Tap targets are at least ~40 px; the nav is usable at 375 px.
- [ ] Breakpoints: 375 (phone), 768 (tablet), 1280 (desktop); check all three.

## Hierarchy and text
- [ ] One `h1` per page, section `h2`s, muted helper text for constraints.
- [ ] One primary action per card; secondary actions are visually quieter.
- [ ] Numbers have units (keys/s, %, seconds) and are not over-promised.

## Motion and accessibility
- [ ] Transitions are short (<=150 ms) and respect
      `prefers-reduced-motion`.
- [ ] Inputs have labels, focus is visible, and the flow works from the
      keyboard (start/stop, forms).
- [ ] Text contrast holds in the default dark theme; no text baked into images.

## Verification
- [ ] Open the page in the Browser pane at mobile and desktop sizes, check the
      console for errors, and re-read the empty state.
- [ ] For the browser worker: `node web/worker-test.mjs` and a real lease on a
      local coordinator (done only after the full chunk).
- [ ] Changed `site.css` or `site.js`? Bump the `?v=` query in every page
      (`site.css?v=...`, `site.js?v=...`): Cloudflare caches those URLs for
      four hours regardless of the origin `Cache-Control`.
