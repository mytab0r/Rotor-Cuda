# Range progress tracking

## Why
Existing random launcher repeatedly guesses ranges, merges text intervals, stores operational/notification credentials beside search logic. Difficult to audit, crash-recover, reproduce. Small deterministic coverage layer should select only uncovered work and preserve progress without copying secrets.

## Scope
Design only in change: interval identity, journal/snapshot format, uncovered-range selection, deterministic randomization, crash semantics, progress reporting, security boundary. Do not wire into CLI until format recovery tests accepted.

## Non-goals
No mass scanning, de-anonymization, multi-GPU scheduling, distributed coordinator, credential integration.