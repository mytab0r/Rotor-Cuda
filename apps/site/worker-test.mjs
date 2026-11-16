// Protocol test for apps/site/rotor-worker.js.
//
// Usage: node apps/site/worker-test.mjs [path/to/rotor_wasm.wasm]
//
// The worker is loaded in a `node:vm` context with a fake `self`, a mocked
// `fetch` and a deterministic clock. The real wasm artifact is scanned; no
// network access and no dependency outside Node's standard library.
//
// The fake clock advances by CLOCK_STEP_MS on every performance.now() call and
// by the delay of every setTimeout, so simulated time is fully deterministic.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const WORKER_PATH = fileURLToPath(
  new URL("./rotor-worker.js", import.meta.url),
);
const WASM_PATH = process.argv[2] ?? "apps/site/rotor_wasm.wasm";

const workerSource = readFileSync(WORKER_PATH, "utf8");
const wasmBytes = readFileSync(WASM_PATH);
const wasmArrayBuffer = wasmBytes.buffer.slice(
  wasmBytes.byteOffset,
  wasmBytes.byteOffset + wasmBytes.byteLength,
);

const KEY1 = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";
const KEY1_HEX = "0000000000000000000000000000000000000000000000000000000000000001";
const EPOCH_SEC = 1_700_000_000;
const EPOCH_MS = EPOCH_SEC * 1000;
const CLOCK_STEP_MS = 1000;
const TEST_TOKEN = "test-token";

function hex64(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function makeJob(start, end, chunkWidth) {
  return {
    id: "job-1",
    mode: "address",
    coin: "btc",
    comp_mode: "compressed",
    target: KEY1,
    start: hex64(start),
    end: hex64(end),
    chunk_width: chunkWidth,
    chunks_total: 1,
    chunks_done: 0,
    chunks_leased: 0,
    scanned: 0,
    done: false,
    found: false,
  };
}

/* Raw text so a u64 lease_id above 2^53 reaches the worker unrounded and can
 * be echoed back as exact JSON digits. */
function leaseText(start, end, leaseId) {
  return (
    `{"job_id":"job-1","chunk_index":0,` +
    `"start":"${hex64(start)}","end":"${hex64(end)}",` +
    `"expires_at":${EPOCH_SEC + 3600},` +
    `"lease_id":${leaseId},"challenge_offsets":[0]}`
  );
}

function wasmResponse() {
  return {
    status: 200,
    ok: true,
    headers: { get: () => null },
    clone: wasmResponse,
    async arrayBuffer() {
      return wasmArrayBuffer;
    },
    async text() {
      return "";
    },
  };
}

function jsonResponse(status, body, headers = {}) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: {
      get(name) {
        const key = String(name).toLowerCase();
        return Object.prototype.hasOwnProperty.call(headers, key)
          ? headers[key]
          : null;
      },
    },
    async text() {
      return text;
    },
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  };
}

class FakeDate {
  static now() {
    return EPOCH_MS + clockMs;
  }
}

let clockMs = 0;

/* Run one worker instance until a scenario calls `state.finish()`. */
async function runWorker(handler, hooks = {}) {
  clockMs = 0;

  const state = {
    messages: [],
    events: [],
    requests: [],
    finished: false,
    closed: false,
    resolveFinished: null,
    finish() {
      if (state.finished) return;
      state.finished = true;
      if (workerSelf.onmessage) {
        workerSelf.onmessage({ data: { type: "stop" } });
      }
      state.closed = true;
      for (const handle of timers.values()) clearImmediate(handle);
      timers.clear();
      state.resolveFinished();
    },
  };
  const finished = new Promise((resolve) => {
    state.resolveFinished = resolve;
  });

  let timerId = 0;
  const timers = new Map();
  let workerSelf = null;

  function fakeSetTimeout(fn, ms) {
    if (state.closed) return 0;
    const delay = Math.max(0, Number(ms) || 0);
    clockMs += delay;
    const id = ++timerId;
    const handle = setImmediate(() => {
      timers.delete(id);
      if (!state.closed) fn();
    });
    timers.set(id, handle);
    return id;
  }

  function fakeClearTimeout(id) {
    const handle = timers.get(id);
    if (handle !== undefined) {
      clearImmediate(handle);
      timers.delete(id);
    }
  }

  const performanceMock = {
    now() {
      const value = clockMs;
      clockMs += CLOCK_STEP_MS;
      return value;
    },
  };

  workerSelf = {
    onmessage: null,
    postMessage(message) {
      state.messages.push(message);
      state.events.push({ kind: "message", message });
      if (hooks.onMessage) hooks.onMessage(message, state);
    },
  };

  async function fetchMock(path, options) {
    const request = {
      path: String(path),
      method: options && options.method ? options.method : "GET",
      headers: options && options.headers ? options.headers : {},
      body: options ? options.body : undefined,
      atMs: clockMs,
    };
    state.requests.push(request);
    state.events.push({ kind: "request", request });
    return handler(request, state);
  }

  const context = vm.createContext({
    self: workerSelf,
    fetch: fetchMock,
    WebAssembly,
    TextEncoder,
    TextDecoder,
    performance: performanceMock,
    Date: FakeDate,
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    console,
  });

  vm.runInContext(workerSource, context, { filename: "rotor-worker.js" });
  workerSelf.onmessage({
    data: { type: "start", token: TEST_TOKEN, clientId: "web-test" },
  });

  await finished;
  // Let the worker's promise chain settle after the stop message.
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  return state;
}

function heartbeatRequests(state) {
  return state.requests.filter((request) => request.path === "/api/v1/heartbeat");
}

function parseBody(request) {
  return JSON.parse(request.body);
}

/* (a)/(e): a full 4096-key chunk with a non-matching target completes. */
async function runCompletion(leaseId) {
  const start = 0x100n;
  const span = 4096;
  const end = start + BigInt(span - 1);
  const job = makeJob(start, end, span);

  const state = await runWorker(
    (request) => {
      switch (request.path) {
        case "/rotor_wasm.wasm":
          return wasmResponse();
        case "/api/v1/jobs":
          return jsonResponse(200, { jobs: [job] });
        case "/api/v1/lease":
          return jsonResponse(200, leaseText(start, end, leaseId));
        case "/api/v1/heartbeat":
          return jsonResponse(200, { expires_at: EPOCH_SEC + 3600 });
        default:
          throw new Error("unexpected request " + request.path);
      }
    },
    {
      onMessage(message, current) {
        if (message.type === "error") current.finish();
        if (message.type === "state" && message.phase === "chunk-done") {
          current.finish();
        }
      },
    },
  );

  return { state, span };
}

/* (b): a found key is posted to /result and no done heartbeat follows. */
async function runFound() {
  const start = 1n;
  const end = 1n;
  const job = makeJob(start, end, 1);

  return runWorker(
    (request, current) => {
      switch (request.path) {
        case "/rotor_wasm.wasm":
          return wasmResponse();
        case "/api/v1/jobs":
          return jsonResponse(200, { jobs: [job] });
        case "/api/v1/lease":
          return jsonResponse(200, leaseText(start, end, "42"));
        case "/api/v1/result":
          current.finish();
          return jsonResponse(200, { accepted: true });
        default:
          throw new Error("unexpected request " + request.path);
      }
    },
    {
      onMessage(message, current) {
        if (message.type === "error") current.finish();
      },
    },
  );
}

/* (c): a 401 on the job list stops with the token guidance. */
async function runUnauthorized() {
  return runWorker(
    (request) => {
      if (request.path === "/rotor_wasm.wasm") return wasmResponse();
      if (request.path === "/api/v1/jobs") {
        return jsonResponse(401, { error: "unauthorized" });
      }
      throw new Error("unexpected request " + request.path);
    },
    {
      onMessage(message, current) {
        if (message.type === "error") current.finish();
      },
    },
  );
}

/* (d): a multi-slice chunk emits progress heartbeats ~2 s apart. */
async function runProgress() {
  const start = 2n;
  const span = 262144;
  const end = start + BigInt(span - 1);
  const job = makeJob(start, end, span);

  const state = await runWorker(
    (request) => {
      switch (request.path) {
        case "/rotor_wasm.wasm":
          return wasmResponse();
        case "/api/v1/jobs":
          return jsonResponse(200, { jobs: [job] });
        case "/api/v1/lease":
          return jsonResponse(200, leaseText(start, end, "42"));
        case "/api/v1/heartbeat":
          return jsonResponse(200, { expires_at: EPOCH_SEC + 3600 });
        default:
          throw new Error("unexpected request " + request.path);
      }
    },
    {
      onMessage(message, current) {
        if (message.type === "error") current.finish();
        if (message.type === "state" && message.phase === "chunk-done") {
          current.finish();
        }
      },
    },
  );

  return { state, span };
}

/* (f): a 429 on the job list retries after Retry-After instead of failing. */
async function runJobsThrottled() {
  const start = 2n;
  const end = 2n;
  const job = makeJob(start, end, 1);
  let jobAttempts = 0;

  return runWorker(
    (request) => {
      switch (request.path) {
        case "/rotor_wasm.wasm":
          return wasmResponse();
        case "/api/v1/jobs":
          jobAttempts += 1;
          if (jobAttempts === 1) {
            return jsonResponse(
              429,
              { error: "rate limited" },
              { "retry-after": "2" },
            );
          }
          return jsonResponse(200, { jobs: [job] });
        case "/api/v1/lease":
          return jsonResponse(200, leaseText(start, end, "42"));
        case "/api/v1/heartbeat":
          return jsonResponse(200, { expires_at: EPOCH_SEC + 3600 });
        default:
          throw new Error("unexpected request " + request.path);
      }
    },
    {
      onMessage(message, current) {
        if (message.type === "error") current.finish();
        if (message.type === "state" && message.phase === "chunk-done") {
          current.finish();
        }
      },
    },
  );
}

async function main() {
  let completion;
  let found;
  let unauthorized;
  let progress;
  let leaseId;
  let throttled;

  // (a) normal completion: exactly one done heartbeat, only at scanned==span.
  completion = await runCompletion("42");
  {
    const heartbeats = heartbeatRequests(completion.state);
    const done = heartbeats.filter((request) => parseBody(request).done === true);
    const running = heartbeats.filter(
      (request) => parseBody(request).done === false,
    );
    assert.equal(done.length, 1, "expected exactly one done:true heartbeat");
    assert.equal(parseBody(done[0]).scanned, completion.span);
    assert.equal(parseBody(done[0]).done, true);
    assert.equal(running.length, 0, "a one-slice chunk has no progress heartbeat");
  }

  // (b) a found key posts /result and never sends done:true.
  found = await runFound();
  {
    const results = found.requests.filter(
      (request) => request.path === "/api/v1/result",
    );
    assert.equal(results.length, 1, "expected one /result submission");
    const body = parseBody(results[0]);
    assert.equal(body.key, KEY1_HEX);
    assert.equal(body.job_id, "job-1");
    assert.ok(results[0].body.includes('"lease_id":42'));
    const done = heartbeatRequests(found).filter(
      (request) => parseBody(request).done === true,
    );
    assert.equal(done.length, 0, "no done heartbeat after a found key");
    assert.ok(
      found.messages.some(
        (message) => message.type === "state" && message.phase === "found",
      ),
      "expected a found state message",
    );
  }

  // (c) 401 stops with an invalid-token error and no lease/heartbeat/result.
  unauthorized = await runUnauthorized();
  {
    const errors = unauthorized.messages.filter(
      (message) => message.type === "error",
    );
    assert.equal(errors.length, 1, "expected one error message");
    assert.match(errors[0].message, /rejected this token/i);
    assert.ok(
      unauthorized.messages.some(
        (message) => message.type === "state" && message.phase === "error",
      ),
      "expected an error state",
    );
    const forbidden = unauthorized.requests.filter((request) =>
      ["/api/v1/lease", "/api/v1/heartbeat", "/api/v1/result"].includes(
        request.path,
      ),
    );
    assert.equal(forbidden.length, 0, "must not lease after a 401");
  }

  // (d) progress heartbeats are ~2 s apart and never ahead of the counter.
  progress = await runProgress();
  {
    const parsed = heartbeatRequests(progress.state).map((request) => ({
      atMs: request.atMs,
      body: parseBody(request),
    }));
    const running = parsed.filter((heartbeat) => heartbeat.body.done === false);
    const done = parsed.filter((heartbeat) => heartbeat.body.done === true);
    assert.ok(
      running.length >= 2,
      `expected at least two progress heartbeats, got ${running.length}`,
    );
    assert.equal(done.length, 1, "expected one completion heartbeat");
    for (let index = 1; index < running.length; index += 1) {
      const gap = running[index].atMs - running[index - 1].atMs;
      assert.ok(
        gap >= 1900,
        `progress heartbeats ${gap} ms apart, expected about 2000`,
      );
    }

    let lastStats = 0;
    let previousScanned = 0;
    for (const event of progress.state.events) {
      if (event.kind === "message" && event.message.type === "stats") {
        lastStats = event.message.scanned;
      }
      if (
        event.kind === "request" &&
        event.request.path === "/api/v1/heartbeat"
      ) {
        const body = JSON.parse(event.request.body);
        if (body.done) continue;
        assert.ok(
          body.scanned >= previousScanned,
          "progress scanned counter went backwards",
        );
        assert.ok(
          body.scanned <= lastStats,
          `heartbeat scanned ${body.scanned} is ahead of the last report ${lastStats}`,
        );
        assert.ok(body.scanned <= progress.span, "scanned past the span");
        previousScanned = body.scanned;
      }
    }
    assert.equal(done[0].body.scanned, progress.span);
  }

  // (e) lease_id above 2^53 is echoed as its exact raw JSON digits.
  leaseId = await runCompletion("9007199254740993");
  {
    const done = heartbeatRequests(leaseId.state).filter(
      (request) => parseBody(request).done === true,
    );
    assert.equal(done.length, 1, "expected one done heartbeat");
    assert.ok(
      done[0].body.includes('"lease_id":9007199254740993'),
      "lease_id was not echoed as exact raw digits",
    );
  }

  // (f) 429 on GET /api/v1/jobs retries after Retry-After while running.
  throttled = await runJobsThrottled();
  {
    const jobs = throttled.requests.filter(
      (request) => request.path === "/api/v1/jobs",
    );
    assert.equal(jobs.length, 2, "expected one 429 retry of the job list");
    const gap = jobs[1].atMs - jobs[0].atMs;
    assert.ok(gap >= 1900, `job-list retry after ${gap} ms, expected ~2000`);
    assert.ok(
      throttled.messages.some(
        (message) =>
          message.type === "state" &&
          message.phase === "retrying" &&
          /rate limited/i.test(message.message),
      ),
      "expected a rate-limited retry state",
    );
  }

  console.log(
    "worker-test PASS: completion, found-key, 401, progress-heartbeats, " +
      "jobs-429-retry, raw-lease-id",
  );
}

const safety = setTimeout(() => {
  console.error("worker-test FAIL: timed out");
  process.exit(1);
}, 60000);

try {
  await main();
  clearTimeout(safety);
  process.exit(0);
} catch (error) {
  clearTimeout(safety);
  console.error("worker-test FAIL:", error && error.stack ? error.stack : error);
  process.exit(1);
}
