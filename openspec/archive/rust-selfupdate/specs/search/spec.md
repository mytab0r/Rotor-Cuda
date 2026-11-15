# Delta: Windows self-update

## ADDED Requirements

### Requirement: checksum-verified self-update
The Windows binary MUST support `--check-update` and `--update`, downloading the
release asset for its build variant (`rotor.exe`, or `rotor-gpu.exe` with the
`gpu` feature) together with its `.sha256`, and MUST verify the checksum before
replacing the running executable. The C++ `Rotor-Cuda.exe` asset MUST NOT be used.

#### Scenario: checksum mismatch
- GIVEN a release asset whose downloaded bytes do not match the published sha256
- WHEN `--update` runs
- THEN the process exits non-zero, the current executable is left untouched, and
  no `.new` file remains.

#### Scenario: unsupported platform
- GIVEN a non-Windows build
- WHEN `--check-update` or `--update` is passed
- THEN the process reports that self-update is not supported and exits non-zero.
