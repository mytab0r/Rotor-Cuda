// Tests for the vault-key monitor sign-in (apps/site/wallet-sign.js).
//
// Usage: node apps/site/wallet-sign-test.mjs
//
// The EIP-191 call runs against the committed wasm artifact; the coordinator
// exchange uses a stubbed fetch, so nothing here touches the network. The
// pinned signature is the ethers 6.13.4 `signMessage` vector for key 1.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const sign = require("./wallet-sign.js");

const WASM = new URL("./rotor_wasm.wasm", import.meta.url);
const KEY1 = Uint8Array.from([
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1
]);
const ADDRESS = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const HELLO =
  "0x9020b81ff870c0fcdd0c0b1945770f2358c51ec57a0f4e6d9d82ce50d4988f483b767a68a5f051a9d6c25daf303583ea6e3e03875f735a9e2900d6e4099a03cb1b";
const SIWE_MESSAGE =
  "rotor.test wants you to sign in with your Ethereum account:\n" +
  ADDRESS +
  "\n\nRotor monitor login\n\nURI: http://rotor.test\nNonce: abc123";

const wasmBytes = await readFile(WASM);
const wasm = (await WebAssembly.instantiate(wasmBytes, {})).instance.exports;

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* Minimal wasm-shaped object for the zeroing and failure paths. */
function fakeWasm(options = {}) {
  const settings = options || {};
  const memory = new WebAssembly.Memory({ initial: 1 });
  let next = 8192;
  const calls = [];
  const error = new TextEncoder().encode(settings.error || "");
  const result = new TextEncoder().encode(settings.result || HELLO);
  const errorPtr = 16;
  const resultPtr = 4096;
  new Uint8Array(memory.buffer, errorPtr, error.length).set(error);
  new Uint8Array(memory.buffer, resultPtr, result.length).set(result);
  return {
    memory,
    calls,
    alloc(len) {
      const pointer = next;
      next += Math.max(8, (len + 7) & ~7);
      return pointer;
    },
    dealloc(pointer, len) {
      calls.push({
        kind: "dealloc",
        pointer,
        len,
        snapshot: Array.from(new Uint8Array(memory.buffer, pointer, len))
      });
    },
    evm_sign_message(keyPtr, keyLen, msgPtr, msgLen) {
      calls.push({
        kind: "sign",
        key: Array.from(new Uint8Array(memory.buffer, keyPtr, keyLen)),
        message: new TextDecoder().decode(new Uint8Array(memory.buffer, msgPtr, msgLen))
      });
      return settings.status || 0;
    },
    result_ptr: () => resultPtr,
    result_len: () => result.length,
    error_ptr: () => errorPtr,
    error_len: () => error.length,
    clear_result() {
      calls.push({ kind: "clear_result" });
    }
  };
}

function stubFetch(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const body = init && init.body !== undefined ? JSON.parse(init.body) : undefined;
    calls.push({
      url,
      method: (init && init.method) || "GET",
      headers: (init && init.headers) || {},
      body
    });
    const next = typeof answer === "function"
      ? answer(calls.length - 1, calls[calls.length - 1])
      : answer;
    if (next instanceof Error) throw next;
    const response = next || {};
    return {
      ok: response.status === undefined ? true : response.status < 400,
      status: response.status || 200,
      async text() {
        return response.text !== undefined
          ? response.text
          : JSON.stringify(response.body === undefined ? null : response.body);
      }
    };
  };
  return { fetchImpl, calls };
}

test("signMessage matches the ethers personal_sign vector", async () => {
  const signature = sign.signMessage(wasm, KEY1, "Hello World");
  assert.equal(signature, HELLO);
});

test("signMessage signs the exact challenge bytes (newlines included)", async () => {
  const fake = fakeWasm();
  const key = Uint8Array.from(KEY1);
  sign.signMessage(fake, key, SIWE_MESSAGE);
  const signed = fake.calls.find((call) => call.kind === "sign");
  assert.equal(signed.message, SIWE_MESSAGE);
  assert.deepEqual(signed.key, Array.from(KEY1));
});

test("signMessage wipes the assembled key and result before dealloc", async () => {
  const fake = fakeWasm();
  const key = Uint8Array.from(KEY1);
  sign.signMessage(fake, key, "Hello World");
  const keyDealloc = fake.calls.find(
    (call) => call.kind === "dealloc" && call.len === 32
  );
  assert.ok(keyDealloc, "the key allocation is released");
  assert.deepEqual(keyDealloc.snapshot, new Array(32).fill(0));
  assert.equal(fake.calls[fake.calls.length - 1].kind, "clear_result");
  assert.deepEqual(Array.from(key), Array.from(KEY1), "the caller keeps its own key");
});

test("signMessage rejects an empty message and a malformed key", async () => {
  const fake = fakeWasm();
  assert.throws(
    () => sign.signMessage(fake, Uint8Array.from(KEY1), ""),
    /no challenge message/
  );
  assert.equal(fake.calls.length, 0, "nothing is signed");
  assert.throws(
    () => sign.signMessage(fake, new Uint8Array(31), "Hello World"),
    /32-byte key/
  );
  assert.throws(
    () => sign.signMessage({}, Uint8Array.from(KEY1), "Hello World"),
    /evm_sign_message/
  );
});

test("signMessage surfaces a wasm rejection without returning bytes", async () => {
  const fake = fakeWasm({ status: 1, error: "private key must be in the range" });
  assert.throws(
    () => sign.signMessage(fake, Uint8Array.from(KEY1), "Hello World"),
    /rejected the message signature: private key must be in the range/
  );
  const keyDealloc = fake.calls.find(
    (call) => call.kind === "dealloc" && call.len === 32
  );
  assert.ok(keyDealloc, "the key is wiped on the failure path too");
  assert.deepEqual(keyDealloc.snapshot, new Array(32).fill(0));
});

test("signMessage rejects a core response without a personal_sign v", async () => {
  const bad = "0x" + "ab".repeat(64) + "00";
  const fake = fakeWasm({ result: bad });
  assert.throws(
    () => sign.signMessage(fake, Uint8Array.from(KEY1), "Hello World"),
    /unexpected message signature/
  );
});

test("signIn uses the monitor request shape and the challenge message", async () => {
  const { fetchImpl, calls } = stubFetch((index) =>
    index === 0
      ? { body: { chain: "evm", nonce: "abc123", message: SIWE_MESSAGE } }
      : {
          body: {
            token: "session-token",
            user: { address: ADDRESS, identities: [] }
          }
        }
  );
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  const signed = [];
  const login = await sign.signIn({
    request,
    address: ADDRESS,
    sign: async (message) => {
      signed.push(message);
      return HELLO;
    }
  });

  assert.equal(login.token, "session-token");
  assert.deepEqual(signed, [SIWE_MESSAGE], "the exact challenge is signed");

  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "/api/v1/monitor/challenge");
  assert.equal(calls[0].method, "POST");
  assert.equal(calls[0].headers["Content-Type"], "application/json");
  assert.equal(calls[0].headers.Authorization, undefined);
  assert.deepEqual(calls[0].body, { chain: "evm", address: ADDRESS });

  assert.equal(calls[1].url, "/api/v1/monitor/login");
  assert.equal(calls[1].method, "POST");
  assert.equal(calls[1].headers.Authorization, undefined);
  assert.deepEqual(calls[1].body, {
    chain: "evm",
    message: SIWE_MESSAGE,
    signature: HELLO
  });
});

test("signIn rejects an empty challenge without signing or logging in", async () => {
  const { fetchImpl, calls } = stubFetch(() => ({ body: { message: "" } }));
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  let signed = 0;
  await assert.rejects(
    sign.signIn({
      request,
      address: ADDRESS,
      sign: async () => {
        signed += 1;
        return HELLO;
      }
    }),
    /no challenge message/
  );
  assert.equal(signed, 0);
  assert.equal(calls.length, 1, "the login endpoint is never called");
});

test("signIn rejects a bad address before any request", async () => {
  const { fetchImpl, calls } = stubFetch({ body: {} });
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  await assert.rejects(
    sign.signIn({ request, address: "not-an-address", sign: async () => HELLO }),
    /no EVM address/
  );
  assert.equal(calls.length, 0);
});

test("a rejected signature returns no token", async () => {
  const { fetchImpl } = stubFetch((index) =>
    index === 0
      ? { body: { message: SIWE_MESSAGE } }
      : { status: 400, body: { error: "signature does not match the challenge" } }
  );
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  await assert.rejects(
    sign.signIn({ request, address: ADDRESS, sign: async () => HELLO }),
    (err) => err.status === 400 && /does not match/.test(err.message)
  );
});

test("a login response without a token is rejected", async () => {
  const { fetchImpl } = stubFetch((index) =>
    index === 0 ? { body: { message: SIWE_MESSAGE } } : { body: { user: {} } }
  );
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  await assert.rejects(
    sign.signIn({ request, address: ADDRESS, sign: async () => HELLO }),
    /no session token/
  );
});

test("validateSession accepts a live token with GET /me", async () => {
  const { fetchImpl, calls } = stubFetch({ body: { user: { address: ADDRESS } } });
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  assert.equal(await sign.validateSession({ request, token: "live-token" }), true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/v1/monitor/me");
  assert.equal(calls[0].method, "GET");
  assert.equal(calls[0].headers.Authorization, "Bearer live-token");
});

test("validateSession reports an expired token as signed out", async () => {
  const { fetchImpl } = stubFetch({ status: 401, body: { error: "unauthorized" } });
  const request = sign.createRequest("/api/v1/monitor", fetchImpl);
  assert.equal(await sign.validateSession({ request, token: "expired" }), false);
});

test("validateSession leaves a network failure to the caller", async () => {
  const request = sign.createRequest("/api/v1/monitor", async () => {
    throw new Error("connection refused");
  });
  await assert.rejects(
    sign.validateSession({ request, token: "live-token" }),
    (err) => err.status === 0 && /network error/.test(err.message)
  );
});

test("validateSession makes no request without a token", async () => {
  let calls = 0;
  const result = await sign.validateSession({
    request: async () => {
      calls += 1;
      return {};
    },
    token: ""
  });
  assert.equal(result, false);
  assert.equal(calls, 0);
});

test("createRequest reports network and HTTP failures", async () => {
  const offline = sign.createRequest(
    "/api/v1/monitor",
    async () => {
      throw new Error("connection refused");
    }
  );
  await assert.rejects(
    offline("/challenge", { method: "POST", body: {} }),
    (err) => err.status === 0 && /network error: connection refused/.test(err.message)
  );

  const bad = sign.createRequest(
    "/api/v1/monitor",
    async () => ({ ok: false, status: 500, async text() { return ""; } })
  );
  await assert.rejects(bad("/login", { method: "POST", body: {} }), /HTTP 500/);
});

test("signing and the coordinator exchange write nothing to the console", async () => {
  const saved = { log: console.log, warn: console.warn, error: console.error };
  let writes = 0;
  console.log = console.warn = console.error = () => {
    writes += 1;
  };
  try {
    sign.signMessage(wasm, Uint8Array.from(KEY1), "Hello World");
    const { fetchImpl } = stubFetch((index) =>
      index === 0 ? { body: { message: SIWE_MESSAGE } } : { body: { token: "t" } }
    );
    await sign.signIn({
      request: sign.createRequest("/api/v1/monitor", fetchImpl),
      address: ADDRESS,
      sign: async () => HELLO
    });
  } finally {
    console.log = saved.log;
    console.warn = saved.warn;
    console.error = saved.error;
  }
  assert.equal(writes, 0);
});

for (const { name, fn } of cases) {
  try {
    await fn();
    console.log("ok - " + name);
  } catch (err) {
    console.error("not ok - " + name);
    throw err;
  }
}
