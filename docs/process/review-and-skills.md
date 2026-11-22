# Review process and installed skills

Status: adopted 2026-11-20. Owner: `ops` area. This document is the source of
truth for *who reviews what* and *what evidence counts*.

## 1. Why our current review missed obvious UI defects

Blunt version:

- **The author reviewed the author.** The same agent that produced the layout
  ran `ui-audit`, read its own diff and declared it green. It judges intent
  ("the two columns use the same grid class") instead of the rendered result.
- **The audit measures thresholds, not composition.** `ui-audit.mjs` catches
  horizontal overflow, sub-44px targets, sub-12px text, unlabeled icon controls,
  known duplicate component families and half-empty cards. It does not catch:
  a ragged two-column split where both columns are individually legal, a label
  clipped by an ancestor's `overflow: hidden`, a raw `https://…` string used as
  link text, or two controls that are semantically the same but built from
  different markup.
- **"60/60" was route coverage, not visual coverage.** A green run means the
  default routes at the default viewports produced no *known* violation. It
  says nothing about a route outside `DEFAULT_ROUTES`, a state that needs a
  click, or a control that only clips under worst-case data.
- **Screenshots were not part of the gate.** The audit writes them, but nobody
  was required to look at them or to attach a before/after pair.
- **No independent sign-off.** `tester` and `critic` existed but the loop could
  finish on the author's own claim. A gate that the author can waive is not a
  gate.
- **Docs/specs drifted silently.** A rendered label could change without the
  OpenSpec delta or the exported stakeholder doc changing, and nothing failed.

The process below removes the two root causes: self-review and evidence-free
"looks fine".

## 2. Local inventory (what we already have)

User skills (`~/.claude/skills`, 34 directories). Relevant to review:

| Skill | Role |
|---|---|
| `impeccable` (repo `.claude/skills/impeccable`, v4.9.1) | design direction, critique, audit, polish, rendered checks |
| `ui-ux-pro-max` | UX rules database queried before designing |
| `ui-checklist` | generic UI completion checklist |
| `design`, `design-system`, `ui-styling`, `emil-design-eng`, `break-ui`, `mobile-native`, `web-perf` | supporting design/QA knowledge |
| `spec-export` | exports OpenSpec specs into stakeholder docs (docs sync) |
| `spec-flow` | OpenSpec workflow |
| `raven-review` | local pre-push diff review |

Repo skills: `impeccable`, `ui-self-review`. Repo agents:
`impeccable-asset-producer`, `impeccable-documenter`,
`impeccable-finish-reviewer`, `impeccable-manual-edit-applier`.

Global agents: `developer`, `tester`, `critic`, `analyst`, `librarian`,
`orchestrator`, `pm`. The intended separation already exists on paper:
`developer` writes, `tester` gates, `critic` attacks, `librarian` archives.

Plugins installed (`~/.claude/plugins/installed_plugins.json`):
`superpowers` 6.4.1 (MIT), `mattpocock-skills` 1.2.3,
`ralph-specum` 4.12.2, `ponytail` 4.7.0, plus Atlassian/Cloudflare/Slack
connectors and `claude-code-setup`.

Important gap: `superpowers` is **installed but not enabled** — it is absent
from `enabledPlugins` in `~/.claude/settings.json`. Its
`subagent-driven-development`, `requesting-code-review`,
`verification-before-completion` and `test-driven-development` skills are
therefore not loaded.

The official marketplace (`claude-plugins-official`) also offers, unused:
`feature-dev`, `code-review`, `pr-review-toolkit`, `frontend-design`,
`playwright`, `chrome-devtools-mcp`.

## 3. Candidates

Stars and last-commit dates were read from the GitHub API on 2026-11-20.

### 3.1 "unslop" — the skill the owner meant

| Repository | What it is | Stars | Last commit | Licence | Install |
|---|---|---:|---|---|---|
| **heydamir/unslop** | Claude/Codex/Antigravity skill: finds AI-UI tells, sets a product-derived direction, fixes spacing → color → icons → copy → type → layout → details → visuals → motion; audits before editing; optional Playwright snapshot and story video | **19,164** | 2026-11-15 | **CC-BY-4.0** | `claude plugin install unslop --marketplace heydamir/unslop`, or copy `skills/unslop/` |
| felipebasurto/unslop-ui | MIT skill that subtracts AI tells from UI copy, charts and dashboards; opt-in surface rules; Python 3.9 script; eval suite | 641 | 2026-11-20 | MIT | `npx skills add felipebasurto/unslop-ui -g` |
| erkamyaman/unslopovich | MIT skill + detector for AI-looking UI/UX across web, iOS, Android; report and treatment references | 267 | 2026-11-20 | MIT | plugin or copy `skills/unslopovich/` |
| marcosnovo/unslop-design | MIT skill with 72 numbered fixes, 0–100 scorer, hook and GitHub Action | 16 | 2026-11-18 | MIT | plugin or copy |

**Decision: install `heydamir/unslop` only.** It is the exact match for the
owner's phrase, by far the most adopted, explicitly a Claude Code skill/plugin,
and safe: the repository contains Markdown references, five WebP references and
three local Node scripts (`snapshot.mjs` uses Playwright, `story.mjs` also uses
ffmpeg). No hooks, no MCP server, no telemetry, no network calls except a URL
the user explicitly passes to the snapshot script.

Installed copy:

- `C:\Users\magic\.claude\skills\unslop\SKILL.md`
- `C:\Users\magic\.claude\skills\unslop\references\*`
- `C:\Users\magic\.claude\skills\unslop\scripts\*.mjs`
- `C:\Users\magic\.claude\skills\unslop\LICENSE` (CC BY 4.0)
- `C:\Users\magic\.claude\skills\unslop\PROVENANCE.md`

Upstream commit `620163eedb3529d9cd23a3994ed8d287d06f760d`. Attribution to
Damir Sokolovsky (@heydamir) is kept in `SKILL.md` and `PROVENANCE.md`, as
CC BY 4.0 requires. The `examples/` directory was deliberately not copied.

`unslop-ui` is a good *complement*, not a duplicate: it is subtractive copy
cleanup and never triggers on its own. Do not install it now; install it only
if post-`unslop` reviews keep finding decorative copy (eyebrows, numbered
features, "Live" dots) that `unslop` leaves because it preserves copy.

### 3.2 Designer-team candidates

| Candidate | Type | Stars | Last commit | Licence | Verdict |
|---|---|---:|---|---|---|
| `impeccable` + `ui-ux-pro-max` + `ui-checklist` (existing) | local skills | — | — | — | **Use.** Already covers direction, UX rules, responsive/a11y checklist |
| `heydamir/unslop` | skill | 19,164 | 2026-11-15 | CC-BY-4.0 | **Installed.** Adds the missing "AI-tell audit" and redline passes |
| `anthropics/frontend-design` (official marketplace) | skill | — | — | Apache-2.0 | Already exposed as `anthropic-skills:frontend-design`; use for new visual direction |
| `billzajac/design-team-claude-code-skill` | skill | 1 | 2026-06-11 | MIT | **No.** Too little adoption and no evidence tooling |
| `ux-vika/design-team-skills` | plugin | 2 | 2026-09-16 | none | **No.** No licence, Figma-specific |

There is no reputable "design team in a box" worth adding. The team is a
composition we already own: `impeccable` for direction, `ui-ux-pro-max` for
rules, `unslop` for AI-tell removal, `ui-checklist` + `ui-audit` for the gate.

### 3.3 Developer-team candidates

| Candidate | Type | Stars | Last commit | Licence | Verdict |
|---|---|---:|---|---|---|
| `obra/superpowers` (installed 6.4.1) | official plugin | — | 2026-09-23 (marketplace) | MIT | **Enable it.** `subagent-driven-development`, `requesting-code-review`, `verification-before-completion`, TDD — exactly the author/reviewer split we lack |
| `anthropics/feature-dev` | official plugin | — | marketplace 2026-10-07 | Apache-2.0 | **Optional.** Good explorer/architect/reviewer agents, but its workflow duplicates OpenSpec; use only for work outside a change |
| `anthropics/pr-review-toolkit` | official plugin | — | marketplace 2026-10-07 | Apache-2.0 | **Optional.** Independent PR reviewers for tests, silent failures, comments, types |
| `NYCU-Chung/my-claude-devteam` | third-party | 267 | 2026-04-18 | MIT | **No.** 12 agents + 15 hooks; broad permission surface, stale |
| `lamngockhuong/aiteamkit` | third-party | 13 | 2026-11-20 | MIT | **No.** Interesting author/approver split, too new and too broad |

The repo already has `developer`, `tester`, `critic` and OpenSpec. The missing
piece is not another kit; it is **enabling** the installed `superpowers` and
making the independent review mandatory.

### 3.4 Tester/QA-team candidates

| Candidate | Type | Stars | Last commit | Licence | Verdict |
|---|---|---:|---|---|---|
| `superpowers` `verification-before-completion` | installed plugin skill | — | — | MIT | **Enable.** Requires a real command run before "done" |
| `anthropics/pr-review-toolkit` (`pr-test-analyzer`, `silent-failure-hunter`) | official plugin | — | — | Apache-2.0 | **Optional.** Useful when `critic` alone is not enough |
| `ralph-specum:qa-engineer` (installed) | plugin agent | — | 2026-11-19 | — | **Use** for spec-task verification |
| repo `tester` agent + `scripts/ui-audit.mjs` | local | — | — | — | **Use.** The only gate that sees the rendered page |
| `erkamyaman/unslopovich` detector | skill | 267 | 2026-11-20 | MIT | **No for now.** Mobile-first detector; revisit only if mobile review is in scope |

### 3.5 Documentation/spec sync candidates

| Candidate | Type | Stars | Last commit | Licence | Verdict |
|---|---|---:|---|---|---|
| `spec-export` (installed) | local skill | — | — | — | **Use.** Regenerates stakeholder docs from `openspec/specs` + change |
| OpenSpec archive + `scripts/check-projects.mjs` | repo process | — | — | — | **Use.** Archive moves delta specs into source of truth; coverage check catches unowned paths |
| `aspenkit/aspens` | third-party | 101 | 2026-09-12 | MIT | **No.** Generates CLAUDE.md/skill files from imports, not docs sync |
| `mpklu/living-doc` | third-party | 1 | 2026-11-09 | NOASSERTION | **No.** Too new, unclear licence |

No third-party skill meets the bar. Sync is a **gate step**: run `spec-export`
when a spec changes, and make the OpenSpec archive task fail if the exported
doc is older than the spec.

## 4. Recommendation

**Install now (done):**

1. `unslop` → `~/.claude/skills/unslop/` (CC BY 4.0, provenance recorded).

**Do not install now:**

- `unslop-ui`, `unslopovich`, `unslop-design` — overlapping or too narrow; add
  later only if the review checklist shows the specific gap.
- Any third-party "team" kit — no candidate has both adoption and a licence,
  and all of them bring hooks/agents/permissions we would have to audit.
- `feature-dev` / `pr-review-toolkit` — official and safe, but redundant with
  OpenSpec + existing agents until the process below is actually enforced.

**Owner action (one line, no code):** enable the already-installed
`superpowers` plugin in `/plugin` (or add
`"superpowers@claude-plugins-official": true` to `enabledPlugins` in
`~/.claude/settings.json`). Without that, its review skills stay dormant. This
is a settings change, so it is deliberately not made here.

## 5. The review process we enforce

### 5.1 Roles — a different agent, always

| Step | Agent | May edit? | Output |
|---|---|---|---|
| Implement | `developer` or the Impeccable build agents | yes | diff + `tasks.md` update |
| Independent UI review | a **different** agent than the author (`critic` with the UI brief, or a spawned `ui-reviewer`) | **no** | findings with `file:line` + evidence |
| Independent code review | `critic` (fresh context, author's reasoning not passed in) | no | approve / rework |
| Gate | `tester` | no | PASS/FAIL with command output |
| Doc sync | `librarian` + `spec-export` | docs/specs only | regenerated docs, archived delta |

Hard rule: **the author never approves its own change.** If the same agent
implemented and "reviewed", the review did not happen. The reviewer receives
the diff, the spec/acceptance criteria and the evidence bundle — not the
author's justification.

### 5.2 Evidence bundle (required, linked from the PR/change)

1. **Machine report**: `node scripts/ui-audit.mjs --serve --json .claude/ui-audit/<change>.json`
   for every affected route, including routes outside `DEFAULT_ROUTES`.
2. **Screenshots**: every audited route × `375`, `768`, `1280` × `dark`, `light`.
   The audit writes them under its printed `screenshotsDir`, and the `ui.yml`
   run uploads them as the `ui-audit-report-<run id>` artifact. Link that
   artifact from the PR; never commit the images (no `docs/**/screenshots/`,
   no images under `docs/**/evidence/`). Add a before/after pair from the same
   PR when the change is visual.
3. **Computed geometry**, not prose. For each affected control, card and row:
   `getBoundingClientRect()` (x, y, width, height, right, bottom),
   `scrollWidth` vs `clientWidth`, `scrollHeight` vs `clientHeight`, and the
   nearest ancestor with `overflow` not `visible`. A control is clipped if its
   `right > clientWidth + 1`, `bottom > viewport height` without a scroll
   container, or its rect is not contained by its parent's content box.
4. **Worst-case data pass**: long names, long unbreakable emails, one-letter
   names, missing fields, zero items, huge counts, non-Latin text, emoji.
   `break-ui` can generate the cases; the reviewer must see the rendered result.
5. **List of every violation and its fix**, including "intentionally accepted"
   items with a reason. Silence is not acceptance.

### 5.3 Checklist derived from the owner's complaints

- [ ] **No duplicated controls.** One action = one control. No two buttons,
      checkboxes or panels doing the same job; no second address-type
      component family. Check the whole route family, not one page.
- [ ] **No clipped controls.** Every button, link, label and card fits its
      parent and the viewport at 375/768/1280, in both themes. No ancestor
      `overflow: hidden` is hiding the clipping.
- [ ] **No ragged two-column layouts.** Columns in one row differ by ≤ 15% in
      width, rows share one height, padding is uniform, and each block is at
      least 55% covered by visible content. A grid that is merely "not
      overflowing" is not enough.
- [ ] **No raw URLs as labels.** Link text is human ("Block explorer", "API
      docs"), not `https://…`; `title`/`aria-label` does not excuse visible raw
      URLs. The URL may appear only when the URL itself is the subject.
- [ ] **One component grammar** across `/key`, `/private-keys/<chain>`,
      `/mnemonic-seeds/<chain>`, `/brainwallet/<chain>`, `/bitcoin-puzzle`.
- [ ] **Touch targets ≥ 44×44**, visible text ≥ 12px, visible focus ring,
      keyboard path works, `prefers-reduced-motion` respected.
- [ ] **States**: loading, empty, error, and worst-case data rendered — not
      just the happy path.
- [ ] **Light and dark** checked at all three widths; no theme mismatch.
- [ ] **Copy is specific**: no "Welcome back", no exclamation marks, no
      unverifiable claims, no decorative badges/status dots.
- [ ] **Before/after** screenshots agree with the claims in the PR.

### 5.4 Where it hooks into existing gates

- **`scripts/ui-audit.mjs`** stays the deterministic gate. Exit 0 is necessary,
  never sufficient. The reviewer must open the `ui-audit-report-<run id>`
  CI artifact (JSON + screenshots) and the geometry table.
- **OpenSpec** (`openspec/changes/<id>/`): add the evidence artifact link to the
  relevant `tasks.md` acceptance line. `tester` Gate #2 cannot PASS without it.
  `critic` Review-gate is a separate, read-only step after `tester`.
- **`critic`** reviews the implementation against `proposal.md`, `design.md`
  and the delta specs. It must be a different context from `developer`.
- **`librarian`** archives the change only after: `ui-audit` green, `tester`
  PASS, `critic` approve, `spec-export` rerun. `node scripts/check-projects.mjs`
  must pass after archive.
- **PR**: the description carries the reviewer's name, the evidence artifact
  link and the checklist. A PR whose author and reviewer are the same agent is
  rejected.

### 5.5 Definition of done

A UI change is done when **all** of these are true:

1. `ui-audit` exits 0 on the affected routes (including non-default routes).
2. The evidence bundle is linked from the PR and the reviewer signed off;
   reviewer ≠ author.
3. The geometry table shows no clipped control and no ragged column at
   375/768/1280, light and dark.
4. `tester` reports PASS with real command output; `critic` approves.
5. OpenSpec delta and exported docs are in sync (`spec-export` rerun).
6. `node scripts/check-projects.mjs` passes.

## 6. Commands

```sh
# design rules before designing
python "$HOME/.claude/skills/ui-ux-pro-max/scripts/search.py" "<page or problem>" --domain ux

# deterministic UI gate on the affected routes
node scripts/ui-audit.mjs --serve --routes key,seed,send --json .claude/ui-audit/<change>.json

# unslop audit/fix (Claude Code picks the skill up; explicit call also works)
# /unslop <route or file>
# optional live snapshot: needs Playwright + Chromium in the project
node "$HOME/.claude/skills/unslop/scripts/snapshot.mjs" <url> unslop/original.html

# area tests + coverage
node scripts/check-projects.mjs

# docs sync (inside an OpenSpec change)
# use the spec-export skill; output defaults to docs/stakeholders/<domain>.md
```
