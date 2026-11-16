# Tasks: text target lists

## 1. Loader  (blocked by: —)
- [x] `src/targets_text.rs`: `load(BufRead, Coin, SearchMode)` for addresses
      (BTC base58check / ETH 0x) and xpoints (64 hex); comments/blanks/CRLF;
      `line N:` errors.
- [x] Unit tests: mixed fixture, malformed line, stdin via Cursor, xpoints.

## 2. Wiring  (blocked by: 1)
- [x] `src/cli.rs`: `--targets-text FILE` (or `-`), validation (multi mode,
      mutually exclusive with `-i`), tests.
- [x] `engine::load_target_set`: text source; CPU and GPU paths share it.
- [x] Engine test: text list finds the same keys as the binary fixture.

## 3. Docs and close-out
- [x] README usage; fmt/clippy/test
- [x] archive; PR #11 merged, CI green.
