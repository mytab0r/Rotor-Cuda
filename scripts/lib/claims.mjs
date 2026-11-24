// Work claims: who is editing which issue right now.
//
// A claim lives in an issue comment with a machine marker, so every session
// and every human reads the same state from GitHub. There is no local lock:
// a lock file cannot be seen from another checkout, and it lies after a crash.
//
// A claim stays live while the newest of its own comment, the claimed
// branch's last commit and the open pull request's last update is younger
// than CLAIM_STALE_MS. After that it is stale and anyone may take it over,
// naming the previous claim in a comment. A release comment closes a claim at
// once. The rule is documented in docs/process/concurrency.md.

export const CLAIM_STALE_MS = 2 * 60 * 60 * 1000;

const MARKER_RE = /<!--\s*work-claim:\s*(\{[\s\S]*?\})\s*-->/;

export function parseClaimComment(body) {
  const match = MARKER_RE.exec(String(body ?? ""));
  if (!match) return null;
  try {
    const value = JSON.parse(match[1]);
    if (!value || typeof value !== "object") return null;
    if (value.released === true) {
      return { released: true, session: value.session ?? null, at: value.at ?? null };
    }
    if (typeof value.session !== "string" || typeof value.branch !== "string") return null;
    return {
      released: false,
      session: value.session,
      branch: value.branch,
      worktree: typeof value.worktree === "string" ? value.worktree : null,
      at: value.at ?? null,
    };
  } catch {
    return null;
  }
}

function timeOf(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

// `lastCommitAt` and `prUpdatedAt` are ISO strings or null; `now` is injected
// in tests. A release always wins, whatever the timestamps say. The claim's own
// time is the comment's `createdAt` when the caller has it: a marker whose
// declared `at` is forged or comes from a skewed clock must not outlive it.
export function claimState(claim, { now = Date.now(), lastCommitAt = null, prUpdatedAt = null } = {}) {
  if (!claim) return "none";
  if (claim.released) return "released";
  const times = [timeOf(claim.recordedAt ?? claim.at), timeOf(lastCommitAt), timeOf(prUpdatedAt)].filter(
    (value) => value !== null,
  );
  if (times.length === 0) return "stale";
  const newest = Math.max(...times);
  return now - newest >= CLAIM_STALE_MS ? "stale" : "live";
}

// The latest claim marker in a comment list wins; a later release closes it.
// Ordering uses the comment's `createdAt` when the caller passes it, so the
// issue timeline, not the marker's self-declared time, decides.
export function latestClaim(comments = []) {
  let latest = null;
  let latestAt = -Infinity;
  for (const comment of comments) {
    const claim = parseClaimComment(comment?.body ?? comment);
    if (!claim) continue;
    const recordedAt = comment?.createdAt ?? null;
    const at = timeOf(recordedAt) ?? timeOf(claim.at);
    if (at === null) continue;
    if (at >= latestAt) {
      latest = { ...claim, recordedAt };
      latestAt = at;
    }
  }
  return latest;
}

// Every claim whose comment landed within `windowMs` of `at`, newest last.
// Two sessions that start together both see each other here and settle the tie
// by session id, so equal starts converge on one owner.
export function claimsNear(comments = [], at, windowMs = 5000) {
  const target = timeOf(at);
  if (target === null) return [];
  const found = [];
  for (const comment of comments) {
    const claim = parseClaimComment(comment?.body ?? comment);
    if (!claim || claim.released) continue;
    const stamp = timeOf(comment?.createdAt ?? claim.at);
    if (stamp === null || Math.abs(stamp - target) > windowMs) continue;
    found.push({ ...claim, recordedAt: comment?.createdAt ?? null });
  }
  return found.sort((a, b) => (timeOf(a.recordedAt ?? a.at) ?? 0) - (timeOf(b.recordedAt ?? b.at) ?? 0));
}

export function sameBranch(claim, branch) {
  return Boolean(claim && branch && claim.branch === branch);
}

// Deterministic tie-break for claims that landed together: the lower session
// id keeps the issue. A session backs off when a rival with a lower id is in
// the window. Both sides compute the same winner regardless of read order.
export function mustBackOff(claims = [], session) {
  if (!session) return false;
  return claims.some((item) => item.session && item.session !== session && item.session < session);
}
