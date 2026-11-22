// Tests for the cabinet wallet EVM send flow (apps/site/wallet-evm.js).
//
// Usage: node apps/site/wallet-evm-test.mjs
//
// No dependencies, no DOM, no network: the public RPC is a mock, and the
// signer is an injected callback. The tests pin exact wei arithmetic, the
// chain-id guard, field validation and the prepare/confirm transition.

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const evm = require("./wallet-evm.js");

const TO = "0x3535353535353535353535353535353535353535";
const FROM = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const CHAIN = "0xaa36a7";
const UNSIGNED =
  "0x02f83183aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c0";
const SIGNED =
  "0x02f87483aa36a780843b9aca00847735940082520894353535353535353535353535353535353535353587038d7ea4c6800080c080a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147";
const TX_HASH = "0x" + "ab".repeat(32);

const BASE_ANSWERS = {
  eth_chainId: CHAIN,
  eth_getTransactionCount: "0x0",
  eth_getBalance: "0xde0b6b3a7640000", // 1 ETH
  eth_estimateGas: "0x5208", // 21000
  eth_feeHistory: { baseFeePerGas: ["0x3b9aca00", "0x77359400"] }, // next block 2 gwei
  eth_maxPriorityFeePerGas: "0x3b9aca00", // 1 gwei
  eth_gasPrice: "0x3b9aca00"
};

function rpcMock(answers) {
  const calls = [];
  const fetchJson = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params, body: init.body });
    const answer = answers[body.method];
    if (answer === undefined) {
      return {
        jsonrpc: "2.0",
        id: 1,
        error: { code: -32601, message: "method not mocked: " + body.method }
      };
    }
    if (answer instanceof Error) throw answer;
    if (answer && answer.rpcError) {
      return { jsonrpc: "2.0", id: 1, error: { code: 3, message: answer.rpcError } };
    }
    return { jsonrpc: "2.0", id: 1, result: answer };
  };
  return { fetchJson, calls };
}

function baseForm(overrides = {}) {
  return {
    to: TO,
    value: "0.01",
    data: "",
    gasLimit: "",
    maxFee: "",
    priorityFee: "",
    ...overrides
  };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* --------------------------------------------------------------- decimals */

test("ETH is parsed to wei exactly, without float rounding", () => {
  assert.equal(evm.parseEthToWei("0"), 0n);
  assert.equal(evm.parseEthToWei("1"), 10n ** 18n);
  assert.equal(evm.parseEthToWei(" 0.1 "), 10n ** 17n);
  assert.equal(evm.parseEthToWei("0.000000000000000001"), 1n);
  assert.equal(evm.parseEthToWei("1.230000000000000000"), 123n * 10n ** 16n);
  assert.equal(evm.parseEthToWei("0.30000000000000004"), 300000000000000040n);
  assert.equal(evm.parseEthToWei("12.345678901234567890"), 12345678901234567890n);
  assert.equal(globalThis.RotorAmount.formatUnits(11050000000000000n, 18), "0.01105");
  assert.equal(globalThis.RotorAmount.formatUnits(0n, 18), "0");
});

test("gwei parsing uses 9 decimals and rejects malformed numbers", () => {
  assert.equal(evm.parseGweiToWei("1"), 10n ** 9n);
  assert.equal(evm.parseGweiToWei("0.000000001"), 1n);
  assert.equal(evm.parseGweiToWei("2.5"), 2500000000n);
  for (const bad of ["", "0.0000000001", "1e9", "-1", "+1", "1,5", ".5", "1."]) {
    assert.throws(() => evm.parseGweiToWei(bad), Error, `gwei ${JSON.stringify(bad)}`);
  }
});

test("address and data validation are field-specific", () => {
  assert.equal(evm.normalizeAddress(TO.toUpperCase().replace("0X", "0x")), TO);
  assert.equal(
    evm.normalizeAddress("0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"),
    FROM
  );
  for (const bad of ["", TO.slice(2), TO + "00", "0x" + "zz".repeat(20), "3535"]) {
    assert.throws(() => evm.normalizeAddress(bad), /40 hex characters/);
  }

  assert.equal(evm.normalizeData(""), "0x");
  assert.equal(evm.normalizeData("0x"), "0x");
  assert.equal(evm.normalizeData("0xABcd"), "0xabcd");
  assert.throws(() => evm.normalizeData("0xabc"), /even number/);
  assert.throws(() => evm.normalizeData("abcd"), /0x followed/);
  assert.throws(() => evm.normalizeData("0xzz"), /hexadecimal/);

  const invalid = evm.validateForm(baseForm({ to: "nope", value: "1e3", data: "0x1" }));
  assert.deepEqual(Object.keys(invalid.errors).sort(), ["data", "to", "value"]);
  assert.match(invalid.errors.to, /40 hex characters/);
  assert.match(invalid.errors.value, /plain decimal/);
  assert.match(invalid.errors.data, /even number/);
});

test("manual fee validation rejects priority above max fee", () => {
  const invalid = evm.validateForm(baseForm({ maxFee: "1", priorityFee: "2" }));
  assert.match(invalid.errors.priorityFee, /must not exceed the max fee/);

  const ok = evm.validateForm(baseForm({ gasLimit: "30000", maxFee: "10", priorityFee: "0" }));
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.gasLimit, 30000n);
  assert.equal(ok.values.maxFee, 10n * 10n ** 9n);
  assert.equal(ok.values.priorityFee, 0n);
});

test("the chain guard accepts Sepolia and refuses any other chain", () => {
  assert.equal(evm.parseChainId(CHAIN), 11155111n);
  assert.equal(evm.assertChainId(CHAIN, evm.SEPOLIA.chainId), 11155111);
  assert.throws(() => evm.assertChainId("0x1", evm.SEPOLIA.chainId), /Chain id mismatch/);
  assert.throws(() => evm.parseChainId("11155111"), /non-hex quantity/);
  assert.throws(() => evm.assertChainId("0xaa36a8", evm.SEPOLIA.chainId), /refusing to sign/i);
});

/* ------------------------------------------------------- prepare / review */

test("prepare reads fees and builds the review without signing", async () => {
  const mock = rpcMock(BASE_ANSWERS);
  let unsignedFields = null;
  let signCalls = 0;

  const review = await evm.prepareTransaction({
    form: baseForm(),
    from: FROM,
    fetchJson: mock.fetchJson,
    unsigned(fields) {
      unsignedFields = fields;
      return UNSIGNED;
    }
  });

  assert.equal(signCalls, 0, "prepare must not sign");
  assert.deepEqual(unsignedFields, {
    chain_id: "11155111",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "21000",
    to: TO,
    value: "10000000000000000",
    data: "0x"
  });
  assert.equal(review.unsignedHex, UNSIGNED);
  assert.equal(review.chainId, 11155111);
  assert.equal(review.chainName, "Ethereum Sepolia");
  assert.equal(review.from, FROM);
  assert.equal(review.to, TO);
  assert.equal(review.valueWei, 10n ** 16n);
  assert.equal(review.gasLimit, 21000n);
  assert.equal(review.gasEstimate, 21000n);
  assert.equal(review.maxFeeWei, 5000000000n);
  assert.equal(review.priorityWei, 1000000000n);
  assert.equal(review.nonce, 0n);
  assert.equal(review.balanceWei, 10n ** 18n);
  assert.equal(review.totalMaxCostWei, 10105000000000000n);
  assert.equal(review.providerUrl, "https://ethereum-sepolia-rpc.publicnode.com");
  assert.equal(review.providerLabel, "publicnode.com");
  assert.deepEqual(review.warnings, []);

  const methods = mock.calls.map((call) => call.method);
  assert.deepEqual(methods, [
    "eth_chainId",
    "eth_getTransactionCount",
    "eth_getBalance",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_maxPriorityFeePerGas"
  ]);
  for (const call of mock.calls) {
    assert.ok(!call.body.includes("private_key"), "RPC payload leaked a key");
  }
});

test("manual gas limit and fees override the fetched defaults", async () => {
  const mock = rpcMock(BASE_ANSWERS);
  const review = await evm.prepareTransaction({
    form: baseForm({ gasLimit: "30000", maxFee: "10", priorityFee: "2" }),
    from: FROM,
    fetchJson: mock.fetchJson,
    unsigned: () => UNSIGNED
  });
  assert.equal(review.gasLimit, 30000n);
  assert.equal(review.gasLimitIsManual, true);
  assert.equal(review.maxFeeWei, 10n * 10n ** 9n);
  assert.equal(review.priorityWei, 2n * 10n ** 9n);
  assert.equal(review.totalMaxCostWei, 10n ** 16n + 30000n * 10n ** 10n);
});

test("a manual gas limit below the estimate is shown as a warning", async () => {
  const mock = rpcMock(BASE_ANSWERS);
  const review = await evm.prepareTransaction({
    form: baseForm({ gasLimit: "20000" }),
    from: FROM,
    fetchJson: mock.fetchJson,
    unsigned: () => UNSIGNED
  });
  assert.equal(review.warnings.length, 1);
  assert.match(review.warnings[0], /below the node estimate/);
});

test("a manual gas limit continues when the node estimate fails", async () => {
  const mock = rpcMock({
    ...BASE_ANSWERS,
    eth_getBalance: "0x0",
    eth_estimateGas: { rpcError: "EVM error: OutOfFunds" }
  });
  let unsignedFields = null;
  const review = await evm.prepareTransaction({
    form: baseForm({ gasLimit: "21000", maxFee: "10", priorityFee: "1" }),
    from: FROM,
    fetchJson: mock.fetchJson,
    unsigned(fields) {
      unsignedFields = fields;
      return UNSIGNED;
    }
  });
  assert.equal(review.gasLimit, 21000n);
  assert.equal(review.gasEstimate, null);
  assert.equal(review.gasLimitIsManual, true);
  assert.equal(unsignedFields.gas_limit, "21000");
  assert.match(
    review.warnings.join(" "),
    /Node estimate failed: publicnode\.com: EVM error: OutOfFunds; using the manual gas limit\./
  );
  assert.ok(mock.calls.some((call) => call.method === "eth_feeHistory"));
});

test("an automatic gas limit asks for a manual limit when estimation fails", async () => {
  const mock = rpcMock({
    ...BASE_ANSWERS,
    eth_estimateGas: { rpcError: "EVM error: OutOfFunds" }
  });
  let unsignedCalls = 0;
  await assert.rejects(
    () =>
      evm.prepareTransaction({
        form: baseForm(),
        from: FROM,
        fetchJson: mock.fetchJson,
        unsigned() {
          unsignedCalls += 1;
          return UNSIGNED;
        }
      }),
    (err) => {
      assert.match(err.message, /Cannot estimate gas; enter a gas limit manually/);
      assert.match(err.message, /publicnode\.com: EVM error: OutOfFunds/);
      return true;
    }
  );
  assert.equal(unsignedCalls, 0);
  assert.ok(!mock.calls.some((call) => call.method === "eth_feeHistory"));
});

test("a wrong chain id blocks the review before any unsigned/sign call", async () => {
  const mock = rpcMock({ ...BASE_ANSWERS, eth_chainId: "0x1" });
  let unsignedCalls = 0;
  await assert.rejects(
    () =>
      evm.prepareTransaction({
        form: baseForm(),
        from: FROM,
        fetchJson: mock.fetchJson,
        unsigned() {
          unsignedCalls += 1;
          return UNSIGNED;
        }
      }),
    /Chain id mismatch.*Refusing to sign/
  );
  assert.equal(unsignedCalls, 0);
});

test("when every provider fails the error is explicit about CORS and names them", async () => {
  const calls = [];
  const fetchJson = async (url) => {
    calls.push(url);
    throw new TypeError("Failed to fetch");
  };
  await assert.rejects(
    () =>
      evm.prepareTransaction({
        form: baseForm(),
        from: FROM,
        fetchJson,
        unsigned: () => UNSIGNED
      }),
    (err) => {
      assert.match(err.message, /No public Ethereum Sepolia RPC answered/);
      assert.match(err.message, /CORS/);
      assert.match(err.message, /does not proxy or spoof Origin/);
      assert.match(err.message, /publicnode\.com: Failed to fetch/);
      assert.match(err.message, /1RPC: Failed to fetch/);
      assert.match(err.message, /Tenderly gateway: Failed to fetch/);
      return true;
    }
  );
  assert.deepEqual(calls, evm.PROVIDERS.map((provider) => provider.url));
});

test("feeHistory and maxPriorityFeePerGas fall back to eth_gasPrice", async () => {
  const answers = { ...BASE_ANSWERS };
  delete answers.eth_feeHistory;
  delete answers.eth_maxPriorityFeePerGas;
  const mock = rpcMock(answers);
  const review = await evm.prepareTransaction({
    form: baseForm(),
    from: FROM,
    fetchJson: mock.fetchJson,
    unsigned: () => UNSIGNED
  });
  assert.equal(review.feesSource, "eth_gasPrice");
  assert.equal(review.prioritySource, "eth_gasPrice");
  // base 1 gwei from gasPrice, priority 1 gwei -> maxFee 3 gwei
  assert.equal(review.maxFeeWei, 3000000000n);
});

/* --------------------------------------------------------------- confirm */

test("confirm re-checks the chain, signs the reviewed values once and broadcasts", async () => {
  const prepareMock = rpcMock(BASE_ANSWERS);
  let unsignedFields = null;
  const review = await evm.prepareTransaction({
    form: baseForm(),
    from: FROM,
    fetchJson: prepareMock.fetchJson,
    unsigned(fields) {
      unsignedFields = fields;
      return UNSIGNED;
    }
  });
  assert.equal(unsignedFields.chain_id, "11155111");

  const sendMock = rpcMock({ eth_chainId: CHAIN, eth_sendRawTransaction: TX_HASH });
  const signCalls = [];
  const result = await evm.confirmTransaction({
    review,
    fetchJson: sendMock.fetchJson,
    sign(fields) {
      signCalls.push(fields);
      return SIGNED;
    }
  });

  assert.deepEqual(signCalls, [
    {
      chain_id: "11155111",
      nonce: "0",
      max_priority_fee: "1000000000",
      max_fee: "5000000000",
      gas_limit: "21000",
      to: TO,
      value: "10000000000000000",
      data: "0x"
    }
  ]);
  assert.equal(result.signedHex, SIGNED);
  assert.equal(result.txHash, TX_HASH);
  assert.equal(result.explorerUrl, "https://sepolia.etherscan.io/tx/" + TX_HASH);
  assert.equal(result.providerLabel, "publicnode.com");
  assert.deepEqual(sendMock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_sendRawTransaction"
  ]);
  assert.deepEqual(sendMock.calls[1].params, [SIGNED]);
  for (const call of sendMock.calls) {
    assert.ok(!call.body.includes("private_key"), "broadcast payload leaked a key");
  }
});

test("confirm refuses to sign if the provider switched chains after review", async () => {
  const prepareMock = rpcMock(BASE_ANSWERS);
  const review = await evm.prepareTransaction({
    form: baseForm(),
    from: FROM,
    fetchJson: prepareMock.fetchJson,
    unsigned: () => UNSIGNED
  });
  const sendMock = rpcMock({ eth_chainId: "0x1", eth_sendRawTransaction: TX_HASH });
  let signCalls = 0;
  await assert.rejects(
    () =>
      evm.confirmTransaction({
        review,
        fetchJson: sendMock.fetchJson,
        sign() {
          signCalls += 1;
          return SIGNED;
        }
      }),
    /Chain id mismatch/
  );
  assert.equal(signCalls, 0);
  assert.deepEqual(sendMock.calls.map((call) => call.method), ["eth_chainId"]);
});

test("confirm refuses to run without a prepared review", async () => {
  const mock = rpcMock({});
  let signCalls = 0;
  await assert.rejects(
    () =>
      evm.confirmTransaction({
        review: null,
        fetchJson: mock.fetchJson,
        sign() {
          signCalls += 1;
        }
      }),
    /Prepare and review the transaction first/
  );
  assert.equal(signCalls, 0);
  assert.equal(mock.calls.length, 0);
});

test("an RPC error during broadcast is reported with its provider", async () => {
  const prepareMock = rpcMock(BASE_ANSWERS);
  const review = await evm.prepareTransaction({
    form: baseForm(),
    from: FROM,
    fetchJson: prepareMock.fetchJson,
    unsigned: () => UNSIGNED
  });
  const sendMock = rpcMock({
    eth_chainId: CHAIN,
    eth_sendRawTransaction: { rpcError: "insufficient funds for gas * price + value" }
  });
  await assert.rejects(
    () =>
      evm.confirmTransaction({
        review,
        fetchJson: sendMock.fetchJson,
        sign: () => SIGNED
      }),
    /Broadcasting to publicnode\.com failed: insufficient funds for gas \* price \+ value/
  );
});

/* ------------------------------------------------------- wasm string call */

function fakeWasm(name, options = {}) {
  const memory = new Uint8Array(1024);
  const resultBytes = new TextEncoder().encode(options.output || "0x02aa");
  const errorBytes = new TextEncoder().encode(options.error || "bad request");
  memory.set(resultBytes, 900);
  memory.set(errorBytes, 800);
  const log = { dealloc: [], clear: 0, wrote: "" };
  const wasm = {
    memory: { buffer: memory.buffer },
    alloc() {
      return 64;
    },
    dealloc(ptr, len) {
      log.dealloc.push({ ptr, len, bytes: Array.from(memory.slice(ptr, ptr + len)) });
    },
    result_ptr() {
      return 900;
    },
    result_len() {
      return resultBytes.length;
    },
    error_ptr() {
      return 800;
    },
    error_len() {
      return errorBytes.length;
    },
    clear_result() {
      log.clear += 1;
    }
  };
  wasm[name] = (ptr, len) => {
    log.wrote = new TextDecoder().decode(memory.slice(ptr, ptr + len));
    return options.status === undefined ? 0 : options.status;
  };
  return { wasm, log };
}

function captureEncoder() {
  const original = globalThis.TextEncoder;
  const state = { bytes: null };
  globalThis.TextEncoder = class {
    encode(text) {
      state.bytes = new Uint8Array(Buffer.from(text, "utf8"));
      return state.bytes;
    }
  };
  state.restore = () => {
    globalThis.TextEncoder = original;
  };
  return state;
}

test("the wasm request buffer is zeroed in wasm and JS before dealloc", () => {
  const { wasm, log } = fakeWasm("evm_sign_tx", { output: "0x02beef" });
  const encoder = captureEncoder();
  let output;
  try {
    output = evm.callWasmString(wasm, "evm_sign_tx", '{"private_key":"secret"}');
  } finally {
    encoder.restore();
  }
  assert.equal(output, "0x02beef");
  assert.match(log.wrote, /private_key/);
  assert.equal(log.dealloc.length, 1);
  assert.ok(
    log.dealloc[0].bytes.every((byte) => byte === 0),
    "wasm input was not zeroed before dealloc"
  );
  assert.ok(encoder.bytes.every((byte) => byte === 0), "JS request bytes were not zeroed");
  assert.equal(log.clear, 1);
});

test("a rejected wasm call still zeroes the request and clears the result", () => {
  const { wasm, log } = fakeWasm("evm_sign_tx", {
    status: 1,
    error: "missing request field: chain_id"
  });
  const encoder = captureEncoder();
  try {
    assert.throws(
      () => evm.callWasmString(wasm, "evm_sign_tx", '{"private_key":"secret"}'),
      /missing request field: chain_id/
    );
  } finally {
    encoder.restore();
  }
  assert.equal(log.dealloc.length, 1);
  assert.ok(
    log.dealloc[0].bytes.every((byte) => byte === 0),
    "wasm input was not zeroed on the error path"
  );
  assert.ok(encoder.bytes.every((byte) => byte === 0), "JS request bytes were not zeroed");
  assert.equal(log.clear, 1);
});

test("a wasm trap still zeroes the request and deallocates", () => {
  const { wasm, log } = fakeWasm("evm_sign_tx");
  wasm.evm_sign_tx = () => {
    throw new Error("RuntimeError: unreachable");
  };
  const encoder = captureEncoder();
  try {
    assert.throws(
      () => evm.callWasmString(wasm, "evm_sign_tx", '{"private_key":"secret"}'),
      /unreachable/
    );
  } finally {
    encoder.restore();
  }
  assert.equal(log.dealloc.length, 1);
  assert.ok(log.dealloc[0].bytes.every((byte) => byte === 0));
  assert.ok(encoder.bytes.every((byte) => byte === 0));
  assert.equal(log.clear, 1);
});

let failed = 0;
for (const { name, fn } of cases) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}`);
    console.error(err && err.stack ? err.stack : err);
  }
}
if (failed) {
  console.error(`\n${failed} of ${cases.length} wallet EVM tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length} wallet EVM tests passed`);
