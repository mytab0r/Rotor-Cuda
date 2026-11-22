# Self-checking UI: detection, baselines, and a defect ledger

Status: research, 2026-11-20. Companion to [review-and-skills.md](review-and-skills.md).
Scope: the static site, `ui-audit.mjs`, and the agent review loop.

## Where we actually stand

`ui-audit.mjs` already takes a screenshot of 19 routes × 3 widths × 2 themes,
and already captures console errors plus same-origin 4xx/5xx and transport
failures over CDP. Both are recorded as **warnings**, never failures. There is
no CI job that runs the audit, no baseline comparison, and no accessibility
pass. The missing capability is not detection machinery — it is **gating**,
**baselines**, and **turning a fixed defect into a check**.

## 1. Visual regression without SaaS

| Tool | What it adds | Fit here |
|---|---|---|
| Playwright `toHaveScreenshot` | Baselines beside tests; first run writes and fails; `--update-snapshots`; `maxDiffPixels`/`maxDiffPixelRatio`, `mask`, `animations:'disabled'`; diff artifacts. Rendering is platform-specific; Docker is recommended for CI [1][2]. | Best reporting, but adds a second browser driver. Adopt only if we outgrow the CDP harness. |
| BackstopJS | `backstop test` / `backstop approve`, HTML report, Docker, Playwright/Puppeteer scenarios [3]. | Skip. README explicitly asks for a new maintainer; a lapsed dependency is the wrong foundation. |
| reg-suit | Compares against a baseline in S3/GCS, posts PR comments, git-hash baseline keying [4]. | Skip. Needs cloud storage; we have no SaaS and no bucket. |
| Chromatic | Storybook cloud: TurboSnap re-tests affected stories, web UI for accepting baselines, PR status [5]. | Skip. Requires Storybook; we have hand-written HTML. |
| Percy | `@percy/playwright` + `percy exec`, cloud rendering at responsive widths, PR status [6]. | Skip. Same SaaS/token/upload objection. |
| pixelmatch | Zero-dependency pixel diff, anti-alias aware, OKLab/`windowSize` noise suppression [7]. | **Use now.** It consumes the PNGs `ui-audit` already writes. |

**Decision:** add `pngjs` + `pixelmatch` as the only two devDependencies and
compare inside `ui-audit.mjs`. Baselines live in `test/visual-baseline/` keyed
`route-width-theme.png`; `--update-baselines` rewrites them; a normal run fails
above 0.1% of pixels or a 16×16 window of ~28. Write `*-diff.png` and a small
`report.html`, upload both as artifacts. Generate baselines **only on ubuntu** —
Windows font rendering will make every run red.

## 2. Runtime health in CI

| Signal | How | Gate |
|---|---|---|
| Console / uncaught exceptions | Already CDP `Runtime.consoleAPICalled`, `Runtime.exceptionThrown`, `Log.entryAdded`; Playwright equivalent `page.on('console')`, `page.on('pageerror')` [8]. | **Fail** on any error in a changed route. |
| Failed requests | Already `Network.responseReceived` (status ≥ 400) and `Network.loadingFailed`. In Playwright, `page.on('requestfailed')` fires only for transport errors, **not 404/503** — use `page.on('response')` for status [8]. | **Fail** on unexpected same-origin 4xx/5xx; allowlist known external origins and the documented keyless `501` case. |
| HAR | `browser.newContext({recordHar:{path}})` records; `page.routeFromHAR()` replays [8]. | Replay when CI cannot reach RPC services; else block external hosts and assert the allowlist. |
| Accessibility | axe-core finds ~57% of WCAG issues automatically [9]; `AxeBuilder` wraps Playwright [10]. | **Fail** on `serious`/`critical`; **warn** on `moderate`. Inject `axe.min.js` over CDP if we stay dependency-light. |
| Performance budgets | Lighthouse CI levels are `off`/`warn`/`error`; `warn` does not change the exit code; `assertMatrix` and `budgetsFile` exist [11]. | **Warn** this month; promote only the budgets we intend to defend. |
| CSS/HTML validity | stylelint catches duplicate selectors and malformed grid areas [12]; `html-validate` is offline and strict [13]. | **Fail** on parse/duplicate errors; **warn** on convention rules. |

## 3. "Self-improving" loops: what is real

- **Bug pattern → analyzer.** Google's Error Prone publishes named `Bug
  Patterns`, each with a severity, promoting experimental checks after vetting
  against its codebase [14]. Google SRE postmortems end in concrete action
  items, not prose [15].
- **Microsoft's "bug lab".** No public program by that name was verifiable
  (MSR BugLab URLs return 404, 2026-11-20). The durable Microsoft artifact is
  the Engineering Fundamentals Playbook's retrospectives and Definition of
  Done. Copy the mechanism — incident → checklist item — not the name.
- **Mutation testing.** `cargo mutants -f src/...` [16]; `npx stryker run`
  (needs Jest/Vitest/Mocha) [17]; `mutmut` (WSL on Windows) [18]. High signal
  for coordinator logic, near-zero for layout. Quarterly, not per-PR.
- **Contract tests.** Pact fits service-to-service APIs [19]; we have none.
  Our real contracts are fixed routes and build-prefixed immutable asset URLs
  — already covered by `check-projects.mjs`, `ui-audit.mjs` and the coordinator
  tests.
- **LLM reviewers.** Claude Code `/code-review` and the Code Review product;
  CodeRabbit and Greptile as paid PR bots [20][21]. They catch semantic bugs
  but cannot see a rendered page unless handed screenshots. Useful as a second
  reviewer; never as the gate.
- **Agent verify loops.** Aider runs `--lint-cmd` and `--test-cmd` after every
  edit with `--auto-test` [22]; SWE-agent's tool loop is now superseded by
  `mini-SWE-agent` [23]; OpenHands ships automations around agents [24]. The
  applicable lesson: the editor must run `ui-audit` **after each UI edit**, not
  once at the end.
- **Hype to reject:** "self-healing" agents that edit the check until it
  passes, AI visual diffing instead of deterministic thresholds, and mutation
  scores as a PR gate.

## 4. Is there a skill that finds skills?

Yes. `find-skills` (`vercel-labs/skills`) is #1 on skills.sh (4.5M installs)
and searches the ecosystem by task [25].

```sh
npx skills find "visual regression"
npx skills add https://github.com/vercel-labs/skills --skill find-skills
```

- **skills.sh** — leaderboard, topics, per-agent filters: <https://skills.sh> [25].
- **Claude Code plugins** — in-session `/plugin` opens the Discover tab;
  CLI: `claude plugin marketplace add <owner/repo>`,
  `claude plugin install <plugin>@<marketplace>`, `claude plugin list`,
  `claude plugin details <plugin>` [26]. The official marketplace is added
  automatically; the community one is not.
- **Awesome lists** — <https://github.com/travisvn/awesome-claude-skills> (15.9k★),
  <https://github.com/hesreallyhim/awesome-claude-code> (58.4k★).
- **MCP registry** — <https://registry.modelcontextprotocol.io>; scriptable:
  `curl 'https://registry.modelcontextprotocol.io/v0/servers?search=playwright&limit=5'` [27].

Caveat: installs measure popularity, not quality — read `SKILL.md`, scripts,
hooks, licence and last commit.

## 5. Recommended stack, ordered by impact per effort

1. **Put the audit in CI (S).** New `.github/workflows/ui.yml` on PRs touching
   `apps/site/**`, `src/coordinator/**`, `scripts/ui-audit.mjs`: Node 24,
   `cargo build --release --bin rotor-coord`,
   `node scripts/ui-audit.mjs --serve --json`, upload screenshots. Biggest gap:
   the gate we own never runs on a PR.
2. **Make warnings fatal (S).** Add `--max-console-errors 0
   --max-network-errors 0`; move the allowlist to
   `scripts/ui-audit.allow.json` (external origins, known `501`), dedupe by
   URL+status. This turns "hundreds of red requests" into one failing line.
3. **Screenshot baselines (M).** `pngjs`+`pixelmatch`; 6 routes × 3 widths,
   dark first (18 baselines); gate at 0.1% / 16×16. Update through a manual
   `workflow_dispatch` job that commits the PNGs, so changes are reviewable.
4. **Detectors for the owner's exact defects (S each).** Add to `auditPage`:
   `raw-url-label` (link text matches `^https?://`), `duplicate-control` (two
   visible controls with the same accessible name/href in one section),
   `clipped-control` (rect outside nearest non-visible-overflow ancestor;
   recently added), `ragged-column` (recently added), `duplicate-filter`
   (recently added). Each gets a ledger entry.
5. **axe-core (M).** devDependency only; fail `serious`/`critical` on the six
   gated routes, then expand.
6. **Ledger + checker (M).** `docs/process/defects.yml` plus
   `scripts/check-defect-ledger.mjs`, invoked from `check-projects.mjs` and CI.
7. **Generated token layer (S).** `design/tokens/tokens.json` is the source;
   `node scripts/build-tokens.mjs --check` is a CI gate and fails when the
   marked region in `apps/site/site.css` or `design/generated/tokens.ts` is
   stale.

### After merging main

A merge that touches `apps/site` invalidates the committed copies and hashes.
Refresh the derived artifacts with the generators, never by hand:

- `node scripts/build-tokens.mjs` — the token region and
  `design/generated/tokens.ts`.
- `node scripts/gen-ssot.mjs` — the chain/provider JS, Rust and the
  `chains:start` CSS region.
- `node scripts/gen-ssot.mjs --vendor-lock` — regenerates the above, then
  copies every `data/vendor.lock.json` pair from `apps/site` to `web/public`
  and rewrites the SHA-256 digests.

Then re-run the gates. `check-ssot` failing with `vendor-lock-digest` means the
lock lags a merge: run the command. The same applies to `gen-ssot --check`,
`gen-detector-docs --check` and `build-tokens --check`. A stale generated
artifact is never a reason to weaken the gate.

**Later:** Lighthouse CI budgets on `/` and `/key`; `cargo mutants` quarterly;
Playwright only if the CDP harness becomes the bottleneck.

**Skip:** BackstopJS (unmaintained), reg-suit/Chromatic/Percy (SaaS or no
Storybook), Pact (no services), Stryker today (no JS test runner), and any LLM
reviewer used as the blocking gate.

## 6. Defect → rule

Every UI defect gets three things in the **same PR**:

1. a failing detector or test committed before the fix;
2. a ledger entry naming that detector;
3. the rule injected into `AGENTS.md` and
   `.claude/skills/ui-self-review/SKILL.md` (and the reviewer prompt).

`check-defect-ledger.mjs` fails when an entry's `detector` is unknown to
`ui-audit`, or when the named rule path does not contain the rule id.

```yaml
# docs/process/defects.yml
- id: UI-0007
  date: 2026-11-20
  route: /send/bnb
  symptom: "Two 'Check balances' controls; one clipped at 375px"
  root_cause: "page-local button instead of shared auto-balance row"
  detector: duplicate-control        # must exist in ui-audit.mjs
  regression_test: "ui-audit --routes send/bnb --viewports 375"
  rule: "AGENTS.md#no-duplicate-controls; .claude/skills/ui-self-review/SKILL.md#checklist"
  introduced_by: "PR #123"
  status: fixed
```

The ledger is the agents' memory; the checker makes forgetting it a red build
instead of a review comment.

## Sources

1. Playwright visual comparisons — https://playwright.dev/docs/test-snapshots
2. Playwright CI — https://playwright.dev/docs/ci
3. BackstopJS — https://github.com/garris/BackstopJS
4. reg-suit — https://github.com/reg-viz/reg-suit
5. Chromatic CLI — https://github.com/chromaui/chromatic-cli
6. Percy for Playwright — https://github.com/percy/percy-playwright
7. pixelmatch — https://github.com/mapbox/pixelmatch
8. Playwright Page API (`console`, `pageerror`, `requestfailed`, `response`, HAR) — https://playwright.dev/docs/api/class-page
9. axe-core — https://github.com/dequelabs/axe-core
10. @axe-core/playwright — https://github.com/dequelabs/axe-core-npm/tree/develop/packages/playwright
11. Lighthouse CI assertions — https://github.com/GoogleChrome/lighthouse-ci/blob/main/docs/configuration.md
12. stylelint — https://github.com/stylelint/stylelint
13. html-validate — https://github.com/html-validate/html-validate
14. Error Prone bug patterns — https://errorprone.info/bugpatterns
15. Google SRE Workbook, postmortem culture — https://sre.google/workbook/postmortem-culture/
16. cargo-mutants — https://github.com/sourcefrog/cargo-mutants
17. StrykerJS — https://github.com/stryker-mutator/stryker-js
18. mutmut — https://github.com/boxed/mutmut
19. Pact — https://docs.pact.io/
20. CodeRabbit — https://www.coderabbit.ai/
21. Greptile — https://www.greptile.com/
22. Aider lint/test loop — https://aider.chat/docs/usage/lint-test.html
23. SWE-agent / mini-SWE-agent — https://github.com/princeton-nlp/SWE-agent
24. OpenHands — https://github.com/All-Hands-AI/OpenHands
25. skills.sh and `find-skills` — https://skills.sh/vercel-labs/skills/find-skills
26. Claude Code plugins — https://docs.anthropic.com/en/docs/claude-code/plugin-marketplaces
27. MCP registry API — https://registry.modelcontextprotocol.io/v0/servers
