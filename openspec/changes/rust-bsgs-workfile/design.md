# Design: BSGS work files

## D1. What must survive

`BsgsTable` currently keeps `map` and `manifest` but not the ordered folds used
to compute `table_checksum`. Add `folds: Vec<u64>` (table order j = 1..m) to the
table so a work file can be written and its checksum re-verified exactly.

## D2. File layout (little-endian)

```
magic      "RBWF"
version    u32 = 1
curve      1 byte (1 = secp256k1)
flags      1 byte (bit0 = target compressed)
reserved   u16 = 0
k_start    32 bytes big-endian
k_end      32 bytes big-endian
baby_size  u64
giant_index u64
checksum   u64  (table_checksum of folds)
target_len u8, target bytes (33 or 65)
folds      baby_size × u64
digest     32 bytes SHA-256 of everything above
```
Written via `<file>.tmp` + rename; a short/foreign file is an error.

## D3. Load and validate

1. Read the whole file; verify length equals the computed layout size and the
   SHA-256 digest.
2. Compare curve/version, k_start/k_end hex, baby_size, target public key and the
   stored table checksum against a fold-derived checksum (`table_checksum`).
3. Rebuild `map` from folds with first-j-wins (same rule as `build_baby_table`)
   and resume `solve_with_table` at `giant_index`.
Any mismatch → `Err` naming the field; `--bsgs-work-reset` deletes/overwrites
the file and starts from scratch.

## D4. Saving

`run_cli` passes a progress callback that receives `(manifest, next_index)`.
The work file is rewritten when `next_index` advanced and at least 30 s passed
since the last save, plus once when the walk stops (found/not-found/Ctrl-C).
Saving is best-effort but errors are reported; a failed save must not report
success.

## D5. CLI

New flags in `src/cli.rs`: `--bsgs-work FILE` and `--bsgs-work-reset`
(only meaningful with `-m bsgs`; validated in `run_cli`). No default file:
offline users opt in explicitly. Coordinator mode keeps using the remote state;
the local work file is still written if requested.

## D6. Tests

- `table_roundtrip`: build a small table, save, load, maps equal, checksum equal.
- `resume_finds_key`: solve a small range from giant index 0 and from a mid
  index; both find the key; the load path does not rebuild the baby table
  (instrument with a counter or assert the elapsed map size only).
- `mismatch`: wrong target, wrong range, corrupted byte, truncated file → errors.
- `reset`: after a mismatch, `--bsgs-work-reset` overwrites and the run succeeds.
