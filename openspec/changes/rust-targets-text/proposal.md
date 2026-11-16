# Text target lists (and stdin)

## Goal

Let multi-target modes read plain-text address/xpoint lists (one per line) or
stdin instead of requiring a pre-sorted binary `.bin` built with BinSort.

## Why

Users keep address lists as text; today they must run Python converters and
BinSort before `-i`. Kangaroo/BitCrack accept text/stdin target lists.

## Scope

- `--targets-text FILE` (`FILE` = `-` reads stdin) for `-m addresses|xpoints`.
- Lines: BTC P2PKH address, ETH `0x…` address (coin decides), or 64-hex X for
  xpoints. Blank lines and `#` comments are skipped; surrounding whitespace and
  CRLF are tolerated; a bad line fails with its line number.
- Mutually exclusive with `-i`; requires a multi-target mode.
- Feeds the same `TargetSet` as the binary path, so CPU and GPU engines,
  filters and the coordinator work unchanged.

## Out of scope

- Pubkey lists (BSGS is a single-target mode), other coins, file watching.
- Changing the binary `.bin` format.

## Acceptance

- A text list and the equivalent `.bin` produce the same matches in an engine
  run.
- Mixed case/whitespace/CRLF/comments parse; a malformed line fails loudly
  naming the line.
- `--targets-text -` reads stdin in a test via an injected reader.
- `cargo test`/clippy/fmt green.
