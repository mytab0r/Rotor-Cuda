# Design

## Work identity

Every interval record is keyed by target identity, half-open `[start,end)`, algorithm, backend, and table-manifest version. Target identity is a validated public key hash, not a display-name substring.

## Storage

First implementation uses append-only JSONL events plus an atomically replaced compact snapshot. One local worker uses an exclusive lock. Events are fsynced before completion is acknowledged. A crash leaves `running` work as `unknown-after-crash`; it is not silently completed.

Upgrade path: SQLite when multiple workers, concurrent readers, or large journals justify transactional queries.

## Selection

Normalize completed intervals into a sorted disjoint union. Select a random offset from uncovered measure using a deterministic seed plus explicit run nonce. Map offset into an uncovered interval. This avoids replacement and repeated random guessing. Record seed, nonce, chosen interval, and command parameters.

## Progress

Report covered/uncovered key counts, percentage, rate, ETA, journal generation, and last durable checkpoint. Never publish sensitive target or discovered-key data outside authorized event context.

## Tests

Test overlap and adjacency merge, gaps, journal replay, torn final line, unknown-after-crash recovery, deterministic selection, no-repeat selection until exhaustion, and schema/version rejection.
