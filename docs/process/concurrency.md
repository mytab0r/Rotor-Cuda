# Concurrent sessions: work claims

Several sessions edit this repository at once: the owner's interactive session,
the scheduled autopilot and the agents it spawns. Two sessions must never
believe they own the same task, and after a crash another session must be able
to tell a live claim from an abandoned one without guessing.

A claim is an issue comment, not a local file. A lock file in one checkout is
invisible from another worktree and lies after a power loss; the issue is the
only place every session and every human already looks.

## Claim protocol

```powershell
node scripts/claim.mjs start <issue> --session <id> --branch <branch> [--worktree <path>]
node scripts/claim.mjs check <issue>
node scripts/claim.mjs release <issue> [--session <id>]
node scripts/claim.mjs status [--json]
```

- `start` writes a `<!-- work-claim:{...} -->` comment. It refuses with exit
  code 2 while another claim on the issue is live, and names the session and
  branch that holds it.
- `check` is the cheap gate: exit 0 when the issue is free or the claim is
  stale, exit 2 when a live claim blocks.
- `release` writes a release marker; the claim is dead at once.
- `status` lists every open issue whose latest claim is not released.

## What makes a claim live

A claim is **live** while the newest of these three is younger than 2 hours:

1. the claim comment itself;
2. the last commit on the claimed branch;
3. the last update of an open pull request from that branch.

It is **stale** after 2 hours of silence on all three, and **released** when a
release marker follows it. A stale claim may be taken over: `start` writes a
new claim and names the stale one in the comment. A claim on a closed issue or
a merged pull request is dead.

The three signals are independent on purpose. A long test run leaves no
commits, so a recent pull-request update keeps the claim alive; a finished
branch with no pull request keeps it alive through its commits; and a crash
that leaves neither is exactly the case where the 2-hour rule frees the work.

## Rules

- An interactive session claims the issue before the first edit and releases
  it when the work is merged or abandoned. A claim you forget is a claim
  someone else has to expire.
- The autopilot runs `node scripts/claim.mjs status` in its cheap gate and
  skips every live claim. It may take a stale claim only with a comment that
  names the previous session.
- The autopilot never edits the shared checkout; all edits happen in a
  worktree under `.claude/worktrees/`, and merges go through `gh`.
- A claim protects a **task**, not a file. Two sessions on different issues can
  still touch the same file; that is what the one-writer-per-worktree rule and
  the per-area split in `PROJECTS.md` are for.
- The 2-hour window is a definition, not a timer: nothing runs in the
  background to expire claims. `claim.mjs` evaluates the window when asked.

## Why two hours

The scheduled autopilot runs every two hours. A window shorter than the
schedule would let a working autopilot's claim look stale between its own runs;
a window much longer would leave a crashed session blocking work for hours.
Two hours is the smallest window that keeps one scheduler period and one
crash-recovery period apart.
