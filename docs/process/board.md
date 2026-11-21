# Rotor board sync

The **Rotor** GitHub Project (`mytab0r`, number 3,
<https://github.com/users/mytab0r/projects/3>) mirrors the repository work so
the owner can see status without opening `openspec/` or the pull-request list.

## What is mirrored

- **One issue per OpenSpec change** that has at least one checkbox in
  `openspec/changes/<id>/tasks.md`. The issue title is
  `[<id>] <first heading>`; labels are `epic` plus one `area:*`.
- **Progress** is computed from the `- [ ]` / `- [x]` checkboxes. The body shows
  `Progress: N/M tasks (P%)` and the remaining unchecked task lines verbatim
  (the first 100; the count of the rest is added when longer). The source of
  truth stays `openspec/changes/<id>/tasks.md`.
- **Idempotency** uses the body marker `<!-- openspec-change: <id> -->`. A
  second run updates the existing issue instead of creating another one.
- **Open pull requests** are added as project items, with `Area` inferred from
  the head branch (falling back to the changed files). Existing PR items are
  skipped.
- **Project fields**:
  - `Area` (single select): `site`, `coordinator`, `desktop`, `infra`,
    `design`, `docs`.
  - `Progress` (number): the same percentage shown in the issue body.
  - `Status`: `Todo` at 0%, `Done` at 100%, `In Progress` in between.
    The project's built-in **Auto-close issue** workflow closes a `Done`
    issue; if the tasks regress below 100%, the next sync reopens it.

Area mapping for changes (first match on the id and title words):

| Area | Keywords |
|---|---|
| `desktop` | desktop |
| `coordinator` | monitor, orders, coordinator, proxy |
| `infra` | infra, deploy, ci |
| `design` | design |
| `docs` | docs |
| `site` | wallet, seed, site, seo, donor, parity |

Anything unmatched defaults to `site` and carries an
`<!-- area-default: site -->` marker in the issue body so the fallback is
visible.

## Run

Prerequisites: a local `gh` login with `repo` and `project` scopes, and GitHub
Issues enabled on the repository (Projects alone cannot host the issues this
script maintains):

```sh
gh auth status
gh repo edit mytab0r/Rotor-Cuda --enable-issues   # once, only if disabled
```

Then, from the repository root:

```sh
node scripts/sync-board.mjs --dry-run   # print the plan, change nothing
node scripts/sync-board.mjs             # create/update issues and project items
```

The script exits non-zero and prints the `gh` error text when a call fails. It
uses Node 20 built-ins only and no npm dependency.

## CI note

A GitHub Actions workflow would need a personal access token with `project`
scope: the default `GITHUB_TOKEN` cannot edit a user-owned Project v2. No such
workflow is added; the script is meant to run locally with the owner's login,
so no new repository secret is required.
