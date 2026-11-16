# Design: text target lists

## D1. Loader

`src/targets_text.rs`:

```rust
pub fn load<R: BufRead>(reader: R, coin: Coin, mode: SearchMode) -> Result<TargetSet, String>
```

- `addresses`: record length 20; BTC lines go through `base58::decode_check`
  (21-byte payload, version 0 → hash160); ETH lines strip `0x` and decode 40
  hex chars.
- `xpoints`: record length 32; 64 hex chars.
- Trim whitespace (incl. `\r`), skip empty lines and lines whose first
  non-space char is `#`. Errors: `line N: <reason>`.
- Build the set with `TargetSet::from_records`, which sorts internally.

## D2. CLI and engine

- `src/cli.rs`: `--targets-text FILE` (value), `--targets-text -` means stdin;
  `Config.targets_text: Option<String>`.
- Validation: requires `-m addresses` or `-m xpoints`; rejects with `-i`
  (`--targets-text and -i are mutually exclusive`) and with single modes.
- `engine::load_target_set` becomes: if `config.targets_text` is set, open the
  file (or stdin lock) and call the loader; else the existing `TargetSet::load`.
  This one function is used by both the CPU and GPU paths.

## D3. Tests

- Loader: temp text file with a mixed list (comments, blanks, CRLF, mixed case)
  → expected records; malformed line → error containing the line number;
  stdin via `Cursor`; xpoint mode.
- CLI: parse `--targets-text`, mutual exclusion with `-i`, mode requirement.
- Engine: a text list of two BTC addresses finds keys from a small range (same
  keys as the `.bin` fixture).

## D4. Docs

README: `--targets-text` usage, the accepted line formats and stdin example.
