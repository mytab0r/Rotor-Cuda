# Range progress tracking

## Why

The existing random launcher repeatedly guesses ranges, merges text intervals, and stores operational notification credentials beside search logic. This is difficult to audit, crash-recover, and reproduce. A small deterministic coverage layer should select only uncovered work and preserve progress without copying secrets.

## Scope

Design only in this change: interval identity, journal/snapshot format, uncovered-range selection, deterministic randomization, crash semantics, progress reporting, and security boundary. Do not wire it into CLI until the format and recovery tests are accepted.

## Non-goals

No mass scanning, de-anonymization, multi-GPU scheduling, distributed coordinator, or credential integration.
