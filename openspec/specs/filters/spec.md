# Filter domain

## Existing behavior
Rotor uses versioned libbloom-compatible Bloom files for target membership checks.

## Planned filter catalog
Every set has canonical `coin`, `bits`, `range_id`, `filter_kind`, `format_version`, `endianness`, `curve`, payload file hashes, and a manifest checksum. Unknown versions and mismatched curves are rejected.

### Scenario: legacy Bloom
- GIVEN a valid existing Bloom file
- WHEN selected with `filter_kind=bloom`
- THEN it remains readable with the existing format and membership semantics

### Scenario: binary fuse
- GIVEN a generated binary-fuse set and its manifest
- WHEN the same target key is checked
- THEN membership returns true; a non-member may return a false positive but never causes a false negative for a generated member

### Scenario: collision
- GIVEN an existing canonical range/filter path
- WHEN generation is requested again without a new identifier
- THEN generation fails before mutation

### Scenario: atomic publication
- GIVEN concurrent generation attempts for one canonical path
- WHEN both publish
- THEN one wins an atomic create/rename, the other fails, and no partial manifest is visible
