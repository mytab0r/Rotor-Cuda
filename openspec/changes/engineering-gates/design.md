# Engineering gates: design decisions

## Revert-fix instead of a new mutator

The existing `mutate-changed.mjs` flips one comparison/return and needs a
matching `*-test.mjs`. `revert-fix` is the complement: it works for any source
layout, uses the area's real test command and asks the only question that
matters for a PR — if the production half of this change disappears, does a
test notice?

Decisions:

- Baseline first. A red baseline cannot attribute a failure to the revert, so
  it aborts with exit 2 instead of claiming proof.
- Test paths are excluded by glob; `--test-glob` extends the list. Test changes
  stay in the tree so the mutation is judged by the test.
- `--source-glob` in CI excludes docs, workflows, data and CUDA/C/C++ (the
  dedicated `gpu-bsgs-compile` gate owns the kernels). Without it a
  documentation-only PR would always report "did not catch".
- Restoration is a `finally` path: forward-apply the saved patch, verify the
  tracked tree clean, fall back to `git reset --hard HEAD` (safe because a
  dirty tree was refused). Exit 3 if the tree is still dirty.
- The mutation workflow runs the base branch's script when it exists, so a PR
  cannot weaken the gate judging it.

## Advisory windows

Lighthouse and the Rust mutation adapter start as `continue-on-error` with a
dated end (2026-12-08). A new gate with no observation data either blocks
honest work or is weakened on day one. The date is in the workflow comment and
in `gates.md`; extending it requires a visible diff.

## gitleaks allowlist

The default rules flag the repository's public test vectors (Bitcoin puzzle #1
address/WIF/pubkey/EVM address, the BIP32 seed, the README placeholder). The
allowlist is prefix regexes scoped to those values, not a path or rule
suppression, so a new secret in the same files is still caught.

## SBOM at release time

`cargo cyclonedx` emits one file per crate; the release job collects and
renames them. The npm SBOM uses `--package-lock-only`, so no install is needed.
There is no pull-request cost.
