// Protocol test for apps/site/puzzle-worker.js.
//
// Usage: node apps/site/puzzle-worker-test.mjs [path/to/rotor_wasm.wasm]
//
// Loads the classic worker in a `node:vm` context with a fake `self` and a
// fetch mock that serves the real wasm artifact. No network access and no
// dependencies outside Node's standard library. Puzzle #1 is the known fixture:
// private key 1 -> 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const WORKER_PATH = fileURLToPath(
  new URL("./puzzle-worker.js", import.meta.url),
);
const WASM_PATH = process.argv[2] ?? "apps/site/rotor_wasm.wasm";

const workerSource = readFileSync(WORKER_PATH, "utf8");
const wasmBytes = readFileSync(WASM_PATH);
const wasmArrayBuffer = wasmBytes.buffer.slice(
  wasmBytes.byteOffset,
  wasmBytes.byteOffset + wasmBytes.byteLength,
);

const KEY1 = "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH";

function hex64(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function wasmResponse() {
  return {
    status: 200,
    ok: true,
    clone() {
      return wasmResponse();
    },
    async arrayBuffer() {
      return wasmArrayBuffer;
    },
    async text() {
      return "";
    },
  };
}

function waitFor(messages, types, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const poll = () => {
      const hit = messages.find((message) => types.includes(message.type));
      if (hit) {
        resolve(hit);
        return;
      }
      if (Date.now() - started > timeoutMs) {
        reject(
          new Error(
            "timed out waiting for " +
              types.join("/") +
              "; messages: " +
              JSON.stringify(messages),
          ),
        );
        return;
      }
      setTimeout(poll, 5);
    };
    poll();
  });
}

async function run(message) {
  const messages = [];
  const workerSelf = {
    onmessage: null,
    postMessage(value) {
      messages.push(value);
    },
    crypto: {
      getRandomValues(array) {
        return globalThis.crypto.getRandomValues(array);
      },
    },
  };

  const context = vm.createContext({
    self: workerSelf,
    fetch: async (path) => {
      if (!String(path).endsWith("/rotor_wasm.wasm")) {
        throw new Error("unexpected fetch " + path);
      }
      return wasmResponse();
    },
    // Force the arrayBuffer fallback: the fake response is not a Response.
    WebAssembly: {
      instantiate: (bytes, imports) => WebAssembly.instantiate(bytes, imports),
      instantiateStreaming: undefined,
    },
    TextEncoder,
    TextDecoder,
    performance,
    setTimeout,
    clearTimeout,
    console,
  });

  vm.runInContext(workerSource, context, { filename: "puzzle-worker.js" });
  workerSelf.onmessage({ data: message });
  return { messages, waitFor: (types) => waitFor(messages, types) };
}

const tests = [];
function test(name, fn) {
  tests.push({ name, fn });
}

test("sequential scan finds puzzle #1 key in a one-key range", async () => {
  const runState = await run({
    type: "start",
    target: KEY1,
    mode: "seq",
    start: hex64(1),
    end: hex64(1),
  });
  const match = await runState.waitFor(["match", "error"]);
  assert.equal(match.type, "match", JSON.stringify(match));
  assert.equal(match.key, hex64(1));
  assert.equal(match.address, KEY1);
  assert.equal(match.generated, 1);
});

test("sequential scan finds puzzle #2 key in its two-key range", async () => {
  const runState = await run({
    type: "start",
    target: "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb",
    mode: "seq",
    start: hex64(2),
    end: hex64(3),
  });
  const match = await runState.waitFor(["match", "error"]);
  assert.equal(match.type, "match", JSON.stringify(match));
  assert.equal(match.key, hex64(3));
  assert.equal(match.address, "1CUNEBjYrCn2y1SdiUMohaKUi4wpP326Lb");
});

test("sequential scan reports done on a miss", async () => {
  const runState = await run({
    type: "start",
    target: KEY1,
    mode: "seq",
    start: hex64(2),
    end: hex64(3),
  });
  const final = await runState.waitFor(["done", "error"]);
  assert.equal(final.type, "done", JSON.stringify(final));
  assert.equal(final.generated, 2);
  assert.equal(
    runState.messages.find((message) => message.type === "match"),
    undefined,
  );
});

test("random scan finds the target", async () => {
  const runState = await run({
    type: "start",
    target: KEY1,
    mode: "random",
    start: hex64(1),
    end: hex64(1),
  });
  const match = await runState.waitFor(["match", "error"]);
  assert.equal(match.type, "match", JSON.stringify(match));
  assert.equal(match.key, hex64(1));
  assert.equal(match.address, KEY1);
});

test("invalid range is rejected without scanning", async () => {
  const runState = await run({
    type: "start",
    target: KEY1,
    mode: "seq",
    start: hex64(9),
    end: hex64(4),
  });
  const failure = await runState.waitFor(["error"]);
  assert.equal(failure.type, "error");
  assert.match(failure.message, /empty puzzle range/);
});

test("invalid target is reported by set_job", async () => {
  const runState = await run({
    type: "start",
    target: "not-an-address",
    mode: "seq",
    start: hex64(2),
    end: hex64(3),
  });
  const failure = await runState.waitFor(["error"]);
  assert.equal(failure.type, "error");
  assert.match(failure.message, /set_job/);
});

let failed = 0;
for (const entry of tests) {
  try {
    await entry.fn();
    console.log("ok - " + entry.name);
  } catch (error) {
    failed += 1;
    console.error("not ok - " + entry.name);
    console.error(error && error.stack ? error.stack : error);
  }
}
if (failed) {
  console.error(failed + " test(s) failed");
  process.exitCode = 1;
} else {
  console.log(tests.length + " tests passed");
}
