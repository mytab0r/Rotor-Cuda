// Pure claim rules: the marker format and the live/stale decision. No network.

import test from "node:test";
import assert from "node:assert/strict";
import {
  CLAIM_STALE_MS,
  claimState,
  claimsNear,
  latestClaim,
  parseClaimComment,
} from "./lib/claims.mjs";

const marker = (value) => ({ body: `<!-- work-claim:${JSON.stringify(value)} -->` });
const claim = {
  released: false,
  session: "c27fc524",
  branch: "feat/tron-mainnet",
  worktree: ".claude/worktrees/tron-mainnet",
  at: "2026-11-24T18:00:00.000Z",
};
const at = Date.parse(claim.at);

test("a claim marker round-trips and a release marker is recognised", () => {
  assert.deepEqual(parseClaimComment(marker(claim).body), claim);
  assert.deepEqual(
    parseClaimComment(marker({ released: true, session: "c27fc524", at: "2026-11-24T19:00:00.000Z" }).body),
    { released: true, session: "c27fc524", at: "2026-11-24T19:00:00.000Z" },
  );
  assert.equal(parseClaimComment("no marker here"), null);
  assert.equal(parseClaimComment("<!-- work-claim:{not json} -->"), null);
  assert.equal(parseClaimComment(marker({ session: "x" }).body), null);
});

test("a claim is live for two hours of silence and stale after it", () => {
  assert.equal(claimState(claim, { now: at + 60_000 }), "live");
  assert.equal(claimState(claim, { now: at + CLAIM_STALE_MS - 1 }), "live");
  assert.equal(claimState(claim, { now: at + CLAIM_STALE_MS }), "stale");
  assert.equal(claimState(null, { now: at }), "none");
});

test("a recent commit or pull request keeps the claim live", () => {
  const old = Date.parse("2026-11-24T18:00:00.000Z");
  const now = old + CLAIM_STALE_MS + 60_000;
  assert.equal(claimState(claim, { now }), "stale");
  assert.equal(
    claimState(claim, { now, lastCommitAt: new Date(now - 60_000).toISOString() }),
    "live",
    "a commit inside the window renews the claim",
  );
  assert.equal(
    claimState(claim, { now, prUpdatedAt: new Date(now - 60_000).toISOString() }),
    "live",
    "an open pull request update renews the claim",
  );
  assert.equal(
    claimState(claim, { now, lastCommitAt: new Date(now - CLAIM_STALE_MS).toISOString() }),
    "stale",
    "an old commit does not renew it",
  );
});

test("a release closes the claim immediately", () => {
  const released = { released: true, session: "c27fc524", at: "2026-11-24T18:30:00.000Z" };
  assert.equal(claimState(released, { now: at + 60_000 }), "released");
});

test("the latest marker wins and a later release closes an older claim", () => {
  const comments = [
    marker(claim),
    marker({ ...claim, session: "other", at: "2026-11-24T18:10:00.000Z" }),
  ];
  assert.equal(latestClaim(comments).session, "other");
  assert.equal(
    latestClaim([
      ...comments,
      marker({ released: true, session: "other", at: "2026-11-24T18:20:00.000Z" }),
    ]).released,
    true,
  );
  assert.equal(latestClaim([{ body: "plain" }]), null);
});

test("the issue timeline, not a self-declared time, orders claims", () => {
  const future = marker({ ...claim, session: "forged", at: "2030-01-01T00:00:00.000Z" });
  future.createdAt = "2026-11-24T18:00:00.000Z";
  const newer = marker({ ...claim, session: "real", at: "2026-11-24T18:05:00.000Z" });
  newer.createdAt = "2026-11-24T18:05:00.000Z";
  assert.equal(latestClaim([future, newer]).session, "real");
  assert.equal(
    claimState(latestClaim([future]), { now: Date.parse("2026-11-24T20:30:00.000Z") }),
    "stale",
    "a marker dated in the future does not outlive its comment",
  );
});

test("claims that land within the window are returned for the tie-break", () => {
  const a = marker({ ...claim, session: "aaa", at: "2026-11-24T18:00:01.000Z" });
  a.createdAt = "2026-11-24T18:00:01.000Z";
  const b = marker({ ...claim, session: "bbb", at: "2026-11-24T18:00:02.000Z" });
  b.createdAt = "2026-11-24T18:00:02.000Z";
  const far = marker({ ...claim, session: "ccc", at: "2026-11-24T19:00:00.000Z" });
  far.createdAt = "2026-11-24T19:00:00.000Z";
  const near = claimsNear([a, b, far], "2026-11-24T18:00:01.000Z");
  assert.deepEqual(near.map((item) => item.session), ["aaa", "bbb"]);
});
