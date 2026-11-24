# Private references

The parity research compared this site with two reference sites. Their real
names and hosts are private: the repository is public and every tracked file
must use a neutral token instead.

## The private source

One JSON file holds the identities:

```json
{
  "donors": [
    { "token": "ref-site-a", "name": "<private>", "hosts": ["<private>", "<private>"] },
    { "token": "ref-site-b", "name": "<private>", "hosts": ["<private>", "<private>"] }
  ]
}
```

It lives in exactly two places:

- locally: `~/.rotor-donor-refs.json` (Windows:
  `C:\Users\<you>\.rotor-donor-refs.json`);
- in CI: the repository secret `DONOR_REFS_JSON`, wired into the
  `projects-map` job in `.github/workflows/rust.yml`.

The real values are never written into a tracked file, a commit message, a PR
body, a test fixture or a report artifact. Do not copy them into a chat
transcript either.

## Token convention

| Real identity | Token in the repository |
|---|---|
| first reference site | `ref-site-a` |
| second reference site | `ref-site-b` |

A page path is written as `ref-site-a/private-keys/tron` or
`ref-site-b/wallets`. A full URL is not stored; consumers resolve the token to
an origin at runtime. Prose says "the reference site A" or `ref-site-a` and
keeps the measured numbers, not the identity.

Runtime consumers:

- `scripts/density-parity.mjs` accepts `--donor ref-site-a/<path>` and resolves
  the origin from `DONOR_REFS_JSON` or `~/.rotor-donor-refs.json`. It accepts a
  full URL for a one-off run, but redacts every resolved host back to the
  token in stdout, JSON and errors.
- `docs/site-map/index.html` loads an optional, git-ignored
  `docs/site-map/donor-refs.local.js` before its renderer. Create it by hand
  from the private source, in this shape, and never commit it:

  ```js
  window.RotorDonorRefs = {
    donors: [{ token: "ref-site-a", hosts: ["<private host>"] }]
  };
  ```

  Without that file the internal page still renders tokens and paths; donor
  links are disabled.

## The gate

`scripts/check-donor-literals.mjs` reads the private source, walks
`git ls-files` and scans every tracked file's content and path. It fails with
`file:line: contains ref-site-a identity` (the token is printed, never the
literal). It fails closed with a clear message when neither source is
available: a fork must set `DONOR_REFS_JSON`. `DONOR_REFS_OPTIONAL=1` is the
explicit, local-only skip.

Run it locally with:

```sh
node scripts/check-donor-literals.mjs
```

A local check that the two real values are gone from tracked files (run it
yourself; do not paste the output or the values into a PR):

```sh
git grep -i -l -e '<value from the private file>'
```

## History still contains the old values

This change sanitizes the current tree only. Earlier commits still contain the
real names and hosts, and a clone can recover them. Removing them requires a
deliberate history rewrite plus a force-push and coordination with every
clone.

Plan it first, do not run it as part of a normal change:

```sh
# 1. Inspect where the values occur in history (use the private values).
git log --all --oneline -S'<value from the private file>'

# 2. Write a private replacements file OUTSIDE the repository, one rule per
#    line, and keep it out of git:
#    <real identity>==>ref-site-a
#    <real identity>==>ref-site-b

# 3. Rewrite a mirror clone, review it, then decide on the force-push.
git clone --mirror <repo> donor-rewrite.git
cd donor-rewrite.git
git filter-repo --replace-text /absolute/path/to/replacements.txt --force
```

`git filter-repo` rewrites every commit id. Treat the result as a new
repository history: announce it, re-create open PRs, and do not force-push
without the owner's explicit approval.
