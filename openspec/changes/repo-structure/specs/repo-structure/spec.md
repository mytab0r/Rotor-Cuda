# Repo structure domain (delta)

## Added requirements

### Requirement: machine-readable area map
The repository MUST contain a `projects.json` that maps every tracked path to
exactly one area, and each area MUST declare an owner role, build and test
commands, documentation, consumed areas, and contracts.

#### Scenario: coverage is total
- GIVEN a clean checkout
- WHEN `node scripts/check-projects.mjs` runs
- THEN it exits 0 only if every `git ls-files` path matches exactly one area
- AND a path claimed by two areas or by none is reported as an error

#### Scenario: ownership answer
- GIVEN a path from a pull-request diff
- WHEN an agent reads `projects.json` or `PROJECTS.md`
- THEN it can name the owning area and owner role without inspecting code

### Requirement: affected-area answer under a minute
The repository MUST provide `scripts/affected-areas.mjs` that converts a git
diff into touched areas, owners, and the cross-area checklist, without a network
call or a cargo build.

#### Scenario: site-only diff
- GIVEN a diff that changes only `web/**` (later `apps/site/**`)
- WHEN `node scripts/affected-areas.mjs --diff <range>` runs
- THEN it reports the site area and requires an asset-version bump
- AND it completes in under 60 seconds from a fresh clone

#### Scenario: wasm diff
- GIVEN a diff that changes `crates/rotor-wasm/**`
- WHEN the script runs
- THEN it reports the wasm-core area and requires the artifact rebuild plus both
  JavaScript tests

### Requirement: cross-area guards
CI MUST enforce the contracts that agents can forget: asset-version bump on site
changes, wasm freshness, path coverage, and consistency between `projects.json`
and the workflow path filters.

#### Scenario: missing asset bump
- GIVEN a pull request changing an HTML or JavaScript file under the site area
- WHEN no asset-version change is present in the same diff
- THEN the required check fails and names the missing bump

#### Scenario: stale wasm artifact
- GIVEN a change under `crates/rotor-wasm/**`
- WHEN the committed `web/rotor_wasm.wasm` does not pass the worker protocol
  test against the current sources
- THEN the wasm job fails; byte-for-byte comparison is not required

### Requirement: area-scoped changes declare areas
Every openspec change and pull request MUST declare its touched areas, and a
change that touches more than one area MUST list the cross-area follow-ups.

#### Scenario: multi-area change
- GIVEN a change touching both the site and the coordinator
- WHEN the proposal is written
- THEN it lists both areas and the coordinator build plus content/API
  synchronization in its tasks

### Requirement: no atomicity regression
The repository MUST keep cross-area changes landable in one commit; git
submodules MUST NOT be introduced for the site, the coordinator, the desktop
tools or the wasm core.

#### Scenario: single commit boundary
- GIVEN a change that edits the site and embeds the result in the coordinator
- WHEN it is merged
- THEN both edits are in one commit and one CI run builds the coordinator with
  the changed assets
