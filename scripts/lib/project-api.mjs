// Projects v2 API access for the board sync and the board gate.
//
// Projects v2 has its own points budget, separate from the core GraphQL
// budget. A quota error must not turn the daily job red: the call is retried
// with exponential backoff and, if it stays exhausted, the caller exits 0 with
// a "sync deferred: Projects quota" note. Real errors still propagate.
//
// Reads fetch only the fields the board uses and the item list is cached for
// the run by the caller. `projectApiCalls` counts every attempt (including
// retries) so the run summary shows the cost.

import fs from "node:fs";

export class ProjectsRateLimitError extends Error {
  constructor(message) {
    super(message);
    this.name = "ProjectsRateLimitError";
  }
}

export function isRateLimitError(error) {
  const message = String(error?.message ?? error ?? "");
  return /rate[\s_-]?limit|RATE_LIMITED/i.test(message);
}

function sleepSync(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

let forcedRateLimitRemaining = null;
let projectCalls = 0;

export function projectApiCalls() {
  return projectCalls;
}

// Test/simulation hooks: the CLI reads BOARD_SYNC_FORCE_RATE_LIMIT lazily, so
// a process can force the first N project attempts to look rate-limited.
export function __setForcedRateLimit(count) {
  forcedRateLimitRemaining = Number(count) || 0;
}
export function __resetProjectApiCalls() {
  projectCalls = 0;
}

function forcedRateLimit() {
  if (forcedRateLimitRemaining === null) {
    forcedRateLimitRemaining = Number(process.env.BOARD_SYNC_FORCE_RATE_LIMIT ?? 0) || 0;
  }
  return forcedRateLimitRemaining;
}

// Retry up to 4 times with 60s/120s/240s/240s (11 min total by default).
// `baseMs` is overridable for tests and the forced-limiter simulation.
export function withProjectsRetry(
  fn,
  {
    label = "project call",
    log = () => {},
    baseMs = Number(process.env.BOARD_SYNC_RETRY_BASE_MS ?? 60000) || 0,
    maxRetries = 4,
  } = {},
) {
  const delays = [baseMs, baseMs * 2, baseMs * 4, baseMs * 4];
  for (let attempt = 0; ; attempt += 1) {
    projectCalls += 1;
    const forced = forcedRateLimit();
    if (forced > 0) {
      forcedRateLimitRemaining = forced - 1;
      const error = new Error(
        "API rate limit exceeded (simulated by BOARD_SYNC_FORCE_RATE_LIMIT)",
      );
      if (attempt >= maxRetries) {
        throw new ProjectsRateLimitError(
          `Projects quota exhausted on ${label}: ${error.message}`,
        );
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      log(
        `warning: Projects quota on ${label}; retrying in ${Math.round(
          delay / 1000,
        )}s (attempt ${attempt + 1}/${maxRetries})`,
      );
      sleepSync(delay);
      continue;
    }

    try {
      return fn();
    } catch (error) {
      if (!isRateLimitError(error)) throw error;
      if (attempt >= maxRetries) {
        throw new ProjectsRateLimitError(
          `Projects quota exhausted on ${label}: ${error.message}`,
        );
      }
      const delay = delays[Math.min(attempt, delays.length - 1)];
      log(
        `warning: Projects quota on ${label}; retrying in ${Math.round(
          delay / 1000,
        )}s (attempt ${attempt + 1}/${maxRetries})`,
      );
      sleepSync(delay);
    }
  }
}

export function appendRunSummary(line) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  try {
    fs.appendFileSync(file, `${line}\n`);
  } catch {
    // A missing or read-only summary file must not break the sync.
  }
}

const PROJECT_ITEMS_QUERY = `query($owner:String!,$number:Int!,$cursor:String){user(login:$owner){projectV2(number:$number){id items(first:100,after:$cursor){pageInfo{hasNextPage endCursor}totalCount nodes{id content{__typename ... on Issue{number url state} ... on PullRequest{number url state}} fieldValues(first:30){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{name field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldNumberValue{number field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldDateValue{date field{... on ProjectV2FieldCommon{name}}} ... on ProjectV2ItemFieldTextValue{text field{... on ProjectV2FieldCommon{name}}}}}}}}}}`;

function normalizeFieldValues(nodes = []) {
  const values = {};
  for (const node of nodes) {
    const name = node?.field?.name?.toLowerCase();
    if (!name) continue;
    let value = null;
    if (node.__typename === "ProjectV2ItemFieldSingleSelectValue") {
      value = node.name ?? null;
    } else if (node.__typename === "ProjectV2ItemFieldNumberValue") {
      value = node.number ?? null;
    } else if (node.__typename === "ProjectV2ItemFieldDateValue") {
      value = node.date ?? null;
    } else if (node.__typename === "ProjectV2ItemFieldTextValue") {
      value = node.text ?? null;
    }
    if (value !== null && value !== undefined) values[name] = value;
  }
  return values;
}

// One paginated read of the project items with only the fields the board
// uses. Returns `{ projectId, items, totalCount }`; callers cache `items`.
export function listProjectItems({
  ghJson,
  owner,
  number,
  log = () => {},
  baseMs,
} = {}) {
  const items = [];
  let projectId = null;
  let totalCount = null;
  let cursor = null;

  for (;;) {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${PROJECT_ITEMS_QUERY}`,
      "-f",
      `owner=${owner}`,
      "-F",
      `number=${number}`,
    ];
    if (cursor) args.push("-f", `cursor=${cursor}`);
    const result = withProjectsRetry(
      () => ghJson(args),
      { label: "project item-list", log, baseMs },
    );
    if (result?.errors?.length) {
      const message = result.errors.map((error) => error.message).join("; ");
      if (isRateLimitError(message)) {
        throw new ProjectsRateLimitError(`Projects quota exhausted on item-list: ${message}`);
      }
      throw new Error(`project item query failed: ${message}`);
    }
    const project = result?.data?.user?.projectV2;
    if (!project?.id) {
      throw new Error(`cannot read project ${number} for owner ${owner}`);
    }
    projectId = project.id;
    totalCount = project.items?.totalCount ?? null;
    for (const node of project.items?.nodes ?? []) {
      items.push({
        id: node.id,
        content: {
          type: node.content?.__typename ?? null,
          number: node.content?.number ?? null,
          url: node.content?.url ?? null,
          state: node.content?.state ?? null,
        },
        ...normalizeFieldValues(node.fieldValues?.nodes),
      });
    }
    if (!project.items?.pageInfo?.hasNextPage) break;
    cursor = project.items.pageInfo.endCursor;
  }

  return { projectId, items, totalCount };
}
