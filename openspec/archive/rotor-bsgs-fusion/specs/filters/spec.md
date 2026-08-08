# Filter catalog

## Added requirements

### Requirement: versioned filter identity
Every generated filter/table set MUST record coin, bit width, range, filter kind, format version, and checksum.

### Requirement: no silent overwrite
Generating a set for an existing range/filter path MUST fail unless caller explicitly chooses a new identifier.

### Requirement: legacy Bloom
Existing Bloom remains available as default until alternative filter compatibility is verified by CPU tests.
