// ERC-20 transfer tests for the cabinet wallet EVM flow
// (apps/site/wallet-evm.js).
//
// Usage: node apps/site/wallet-erc20-test.mjs
//
// No network and no DOM: every RPC response is a stub. The calldata and the
// signed raw transaction are pinned against ethers 6.17.0, computed
// independently on 2026-11-22:
//
//   const iface = new ethers.Interface(["function transfer(address to, uint256 amount)"]);
//   iface.encodeFunctionData("transfer", [RECIPIENT, 1000000n]);
//   new ethers.Wallet(KEY1).signTransaction({
//     type: 2, chainId: 1, nonce: 0,
//     maxPriorityFeePerGas: 1 gwei, maxFeePerGas: 5 gwei,
//     gasLimit: 60000, to: TOKEN, value: 0, data: CALLDATA
//   });
//
// Every refusal path is pinned with its exact message.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const evm = require("./wallet-evm.js");

const KEY1 = "0x" + "0".repeat(63) + "1";
const FROM = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TOKEN = "0x1111111111111111111111111111111111111111";
const RECIPIENT = "0x3535353535353535353535353535353535353535";
const SEPOLIA_CHAIN = "0xaa36a7";
const TX_HASH = "0x" + "ab".repeat(32);

// ethers 6.17.0: transfer(0x3535..., 1000000)
const CALLDATA =
  "0xa9059cbb" +
  "000000000000000000000000" + RECIPIENT.slice(2) +
  "00000000000000000000000000000000000000000000000000000000000f4240";

// ethers 6.17.0 raw transaction for the request below, and its Keccak-256.
const VECTOR_RAW =
  "0x02f8b00180843b9aca0085012a05f20082ea6094111111111111111111111111111111111111111180b844a9059cbb000000000000000000000000353535353535353535353535353535353535353500000000000000000000000000000000000000000000000000000000000f4240c080a0553178e19f60a00803ac70baaead620383f3e967d08a7e37983c981cf05650e3a04865083dbb24fceaa2d236168fae2a44a8edce53523d0073101dc30589db357a";
const VECTOR_HASH =
  "0xe2fb5f58b813173908bd788af1885d6f25b11925af2e9a6316b7eeaec55e6582";

const DECIMALS_SELECTOR = "0x313ce567";
const SYMBOL_SELECTOR = "0x95d89b41";
const BALANCE_OF_SELECTOR = "0x70a08231";

const WASM_PATH = new URL("./rotor_wasm.wasm", import.meta.url);
let wasmPromise = null;
function loadWasm() {
  if (!wasmPromise) {
    wasmPromise = WebAssembly.instantiate(readFileSync(WASM_PATH), {})
      .then((module) => module.instance.exports);
  }
  return wasmPromise;
}

function bytesFromHex(hex) {
  const body = hex.replace(/^0x/, "");
  return Uint8Array.from(body.match(/../g).map((byte) => parseInt(byte, 16)));
}

function word(value) {
  return BigInt(value).toString(16).padStart(64, "0");
}

function abiString(text) {
  const bytes = Buffer.from(text, "utf8");
  let data = bytes.toString("hex");
  while (data.length % 64) data += "0";
  return "0x" + word(32) + word(bytes.length) + data;
}

function abiBytes32(text) {
  return "0x" + Buffer.from(text, "utf8").toString("hex").padEnd(64, "0");
}

/* Stub RPC: eth_getCode and the three eth_call selectors answer from the
 * options; everything else is the fixed mainnet baseline. */
function rpcMock(options = {}) {
  const calls = [];
  const code = options.code === undefined ? "0x6080604052348015600f57600080fd5b50" : options.code;
  const decimals = options.decimals === undefined ? 6 : options.decimals;
  const symbolResult = options.symbolResult === undefined
    ? abiString(options.symbol === undefined ? "USDT" : options.symbol)
    : options.symbolResult;
  const tokenBalance = options.tokenBalance === undefined ? 10n ** 12n : options.tokenBalance;
  const answers = {
    eth_chainId: options.chainId === undefined ? "0x1" : options.chainId,
    eth_getTransactionCount: "0x0",
    eth_getBalance: options.nativeBalance === undefined ? "0xde0b6b3a7640000" : options.nativeBalance,
    eth_estimateGas: options.gasEstimate === undefined ? "0xc350" : options.gasEstimate,
    eth_feeHistory: { baseFeePerGas: ["0x3b9aca00", "0x77359400"] },
    eth_maxPriorityFeePerGas: "0x3b9aca00",
    eth_sendRawTransaction: options.txHash === undefined ? TX_HASH : options.txHash
  };

  function result(value) {
    return { jsonrpc: "2.0", id: 1, result: value };
  }
  function rpcError(message) {
    return { jsonrpc: "2.0", id: 1, error: { code: 3, message } };
  }

  async function fetchJson(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params, body: init.body });
    if (body.method === "eth_getCode") return result(code);
    if (body.method === "eth_call") {
      const data = body.params[0].data;
      if (data === DECIMALS_SELECTOR) return result("0x" + word(decimals));
      if (data === SYMBOL_SELECTOR) return result(symbolResult);
      if (data.startsWith(BALANCE_OF_SELECTOR) && data.length === BALANCE_OF_SELECTOR.length + 64) {
        return result("0x" + word(tokenBalance));
      }
      return rpcError("method not mocked: eth_call " + data.slice(0, 10));
    }
    const answer = answers[body.method];
    if (answer === undefined) return rpcError("method not mocked: " + body.method);
    if (answer instanceof Error) throw answer;
    if (answer && answer.rpcError) return rpcError(answer.rpcError);
    return result(answer);
  }

  return { fetchJson, calls };
}

function tokenForm(overrides = {}) {
  return {
    to: RECIPIENT,
    token: TOKEN,
    value: "1",
    data: "",
    gasLimit: "",
    maxFee: "",
    priorityFee: "",
    ...overrides
  };
}

function tokenOptions(overrides = {}) {
  return {
    form: tokenForm(),
    from: FROM,
    expectedChainId: 1,
    mainnetArmed: true,
    unsigned: () => "0x02f8",
    ...overrides
  };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* --------------------------------------------------------------- calldata */

test("transfer calldata matches an independent encoding and the ethers vector", () => {
  const independent = "0xa9059cbb" +
    RECIPIENT.slice(2).padStart(64, "0") +
    (1000000n).toString(16).padStart(64, "0");
  assert.equal(independent, CALLDATA);
  assert.equal(evm.transferCalldata(RECIPIENT, 1000000n), CALLDATA);
  assert.equal(evm.transferCalldata(RECIPIENT.toUpperCase().replace("0X", "0x"), 1n),
    "0xa9059cbb" + RECIPIENT.slice(2).padStart(64, "0") + word(1));
});

test("transfer calldata refuses a zero recipient, a zero amount and a uint256 overflow", () => {
  assert.throws(() => evm.transferCalldata("0x" + "0".repeat(40), 1n), /zero address/);
  assert.throws(() => evm.transferCalldata("nope", 1n), /40 hex characters/);
  assert.throws(() => evm.transferCalldata(RECIPIENT, 0n), /must be greater than zero/);
  assert.throws(() => evm.transferCalldata(RECIPIENT, 1n << 256n), /too large for a uint256/);
});

/* ---------------------------------------------------------- form validation */

test("a token form validates the contract and keeps data empty", () => {
  const invalidToken = evm.validateForm(tokenForm({ token: "0x1234" }));
  assert.match(invalidToken.errors.token, /40 hex characters/);

  const checksum = evm.validateForm(tokenForm({
    token: "0x" + "AB".repeat(20)
  }));
  assert.match(checksum.errors.token, /fails the EIP-55 checksum/);

  const lower = evm.validateForm(tokenForm({ token: "0x" + "ab".repeat(20) }));
  assert.deepEqual(lower.errors, {});
  assert.equal(lower.values.token, "0x" + "ab".repeat(20));

  const withData = evm.validateForm(tokenForm({ data: "0xabcd" }));
  assert.match(withData.errors.data, /Data is not allowed with a token transfer/);

  const zero = evm.validateForm(tokenForm({ value: "0" }));
  assert.match(zero.errors.value, /must be greater than zero/);

  const bad = evm.validateForm(tokenForm({ value: "1e3" }));
  assert.match(bad.errors.value, /plain decimal token amount/);

  const ok = evm.validateForm(tokenForm());
  assert.deepEqual(ok.errors, {});
  assert.equal(ok.values.token, TOKEN);
  assert.equal(ok.values.value, 0n);
  assert.equal(ok.values.amountText, "1");
});

test("an empty token field keeps the native amount path", () => {
  const values = evm.validateForm({
    to: RECIPIENT, token: "", value: "0.5", data: "", gasLimit: "", maxFee: "", priorityFee: ""
  });
  assert.deepEqual(values.errors, {});
  assert.equal(values.values.token, null);
  assert.equal(values.values.value, 5n * 10n ** 17n);
});

/* --------------------------------------------------------------- prepare */

test("prepare reads the token, builds calldata locally and reviews value 0", async () => {
  const mock = rpcMock();
  let fields = null;
  const review = await evm.prepareTransaction(tokenOptions({
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    }
  }));

  assert.deepEqual(fields, {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: CALLDATA
  });

  assert.equal(review.isToken, true);
  assert.equal(review.to, RECIPIENT);
  assert.equal(review.tokenContract, TOKEN);
  assert.equal(review.tokenSymbol, "USDT");
  assert.equal(review.tokenDecimals, 6);
  assert.equal(review.tokenAmountWei, 1000000n);
  assert.equal(review.tokenBalanceWei, 10n ** 12n);
  assert.equal(review.valueWei, 0n);
  assert.equal(review.dataHex, CALLDATA);
  assert.equal(review.gasEstimate, 50000n);
  assert.equal(review.gasLimit, 60000n);
  assert.equal(review.maxFeeWei, 5000000000n);
  assert.equal(review.totalMaxCostWei, 60000n * 5000000000n);

  assert.deepEqual(mock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_getCode",
    "eth_call",
    "eth_call",
    "eth_call",
    "eth_getTransactionCount",
    "eth_getBalance",
    "eth_estimateGas",
    "eth_feeHistory",
    "eth_maxPriorityFeePerGas"
  ]);
  const calls = mock.calls.filter((call) => call.method === "eth_call");
  assert.deepEqual(calls[0].params, [{ to: TOKEN, data: DECIMALS_SELECTOR }, "latest"]);
  assert.deepEqual(calls[1].params, [{ to: TOKEN, data: SYMBOL_SELECTOR }, "latest"]);
  assert.deepEqual(calls[2].params,
    [{ to: TOKEN, data: BALANCE_OF_SELECTOR + word(FROM) }, "latest"]);
  assert.deepEqual(mock.calls.find((call) => call.method === "eth_getCode").params,
    [TOKEN, "latest"]);
  for (const call of mock.calls) {
    assert.ok(!call.body.includes("private_key"), "an RPC payload leaked a key");
    assert.ok(!call.body.includes(KEY1.slice(2)), "an RPC payload leaked the key bytes");
  }
});

test("an address without contract code is refused before any token read", async () => {
  const mock = rpcMock({ code: "0x" });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: mock.fetchJson })),
    /The token address 0x1111111111111111111111111111111111111111 has no contract code on Ethereum mainnet; it is an externally owned account or does not exist\. Refusing to sign\./
  );
  assert.deepEqual(mock.calls.map((call) => call.method), ["eth_chainId", "eth_getCode"]);
});

test("token decimals outside 0-24 are refused", async () => {
  const mock = rpcMock({ decimals: 25 });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: mock.fetchJson })),
    /The token reports 25 decimals; this wallet signs ERC-20 amounts with 0 to 24 decimals only\. Refusing to sign\./
  );
});

test("the token symbol must be printable, at most 32 characters and not empty", async () => {
  const long = rpcMock({ symbolResult: abiString("A".repeat(33)) });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: long.fetchJson })),
    /The token symbol is longer than 32 characters; refusing to sign an unfamiliar token\./
  );
  const control = rpcMock({ symbolResult: abiString("US\x01DT") });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: control.fetchJson })),
    /The token symbol contains non-printable characters; refusing to sign an unfamiliar token\./
  );
  const empty = rpcMock({ symbolResult: abiString("") });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: empty.fetchJson })),
    /The token reports an empty symbol; refusing to sign an unfamiliar token\./
  );
});

test("a fixed bytes32 symbol is decoded and trimmed", async () => {
  const mock = rpcMock({ symbolResult: abiBytes32("MKR"), decimals: 18, tokenBalance: 10n ** 19n });
  const review = await evm.prepareTransaction(tokenOptions({
    form: tokenForm({ value: "1.25" }),
    fetchJson: mock.fetchJson
  }));
  assert.equal(review.tokenSymbol, "MKR");
  assert.equal(review.tokenDecimals, 18);
  assert.equal(review.tokenAmountWei, 125n * 10n ** 16n);
});

test("a token balance below the amount is refused with both numbers", async () => {
  const mock = rpcMock({ tokenBalance: 500000n });
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: mock.fetchJson })),
    /The amount 1 USDT exceeds the token balance of 0\.5 USDT; refusing to sign\./
  );
});

test("an amount with more decimals than the token allows is a field error", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({
      form: tokenForm({ value: "1.1234567" }),
      fetchJson: mock.fetchJson
    })),
    (err) => {
      assert.deepEqual(err.fieldErrors, { value: "The USDT amount has more than 6 decimals." });
      return true;
    }
  );
});

/* ------------------------------------------------------- mainnet barriers */

test("an unarmed mainnet token send is refused before any RPC", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({
      mainnetArmed: false,
      fetchJson: mock.fetchJson
    })),
    /Mainnet signing is not armed/
  );
  assert.equal(mock.calls.length, 0);
});

test("the native fee cap applies to a token send exactly as to a native send", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({
      form: tokenForm({ gasLimit: "21000", maxFee: "3000", priorityFee: "1" }),
      fetchJson: mock.fetchJson
    })),
    /The maximum network fee 0\.063 ETH exceeds the Ethereum mainnet cap of 0\.05 ETH; refusing to sign\./
  );
});

test("a token send checks the native balance against the fee only", async () => {
  const mock = rpcMock({ nativeBalance: "0x5af3107a4000" }); // 0.0001 ETH
  await assert.rejects(
    () => evm.prepareTransaction(tokenOptions({ fetchJson: mock.fetchJson })),
    /The maximum network fee 0\.0003 ETH exceeds the native balance of 0\.0001 ETH; refusing to sign\./
  );
});

/* --------------------------------------------------------------- confirm */

test("confirm re-reads the chain, signs the token fields once and broadcasts once", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareTransaction(tokenOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: () => "0x02f8"
  }));

  const sendMock = rpcMock({ chainId: "0x1" });
  const signCalls = [];
  const result = await evm.confirmTransaction({
    review,
    fetchJson: sendMock.fetchJson,
    mainnetArmed: true,
    sign(fields) {
      signCalls.push(fields);
      return VECTOR_RAW;
    }
  });

  assert.deepEqual(signCalls, [{
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: CALLDATA
  }]);
  assert.equal(result.signedHex, VECTOR_RAW);
  assert.equal(result.txHash, TX_HASH);
  assert.deepEqual(sendMock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_sendRawTransaction"
  ]);
  assert.equal(
    sendMock.calls.filter((call) => call.method === "eth_sendRawTransaction").length,
    1,
    "the raw transaction must be sent exactly once"
  );
  for (const call of sendMock.calls) {
    assert.ok(!call.body.includes("private_key"), "a broadcast payload leaked a key");
  }
});

test("confirm refuses a chain switch after review and does not sign", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareTransaction(tokenOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: () => "0x02f8"
  }));
  const sendMock = rpcMock({ chainId: SEPOLIA_CHAIN });
  let signCalls = 0;
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign() {
        signCalls += 1;
        return VECTOR_RAW;
      }
    }),
    /Chain id mismatch/
  );
  assert.equal(signCalls, 0);
  assert.deepEqual(sendMock.calls.map((call) => call.method), ["eth_chainId"]);
});

test("a mutated token review cannot change the recipient, amount or native value", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareTransaction(tokenOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: () => "0x02f8"
  }));
  const sendMock = rpcMock({ chainId: "0x1" });
  let signCalls = 0;
  const sign = () => {
    signCalls += 1;
    return VECTOR_RAW;
  };

  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, to: "0x" + "35".repeat(19) + "36" },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign
    }),
    /The reviewed token calldata does not match the reviewed recipient and amount\. Refusing to sign\./
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, tokenAmountWei: review.tokenAmountWei + 1n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign
    }),
    /The reviewed token calldata does not match the reviewed recipient and amount\. Refusing to sign\./
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, valueWei: 1n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign
    }),
    /A token transfer must not send native value; the reviewed value is not zero\. Refusing to sign\./
  );
  assert.equal(signCalls, 0);
  assert.equal(sendMock.calls.length, 0);
});

test("a prepared token review cannot be confirmed after the arm is removed", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareTransaction(tokenOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: () => "0x02f8"
  }));
  const sendMock = rpcMock({ chainId: "0x1" });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: sendMock.fetchJson,
      mainnetArmed: false,
      sign: () => VECTOR_RAW
    }),
    /Mainnet signing is not armed/
  );
  assert.equal(sendMock.calls.length, 0);
});

test("a token send on Sepolia needs no arm and skips the mainnet gas buffer", async () => {
  const mock = rpcMock({ chainId: SEPOLIA_CHAIN });
  let fields = null;
  const review = await evm.prepareTransaction(tokenOptions({
    expectedChainId: 11155111,
    mainnetArmed: false,
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    }
  }));
  assert.equal(review.testnet, true);
  assert.equal(review.gasEstimate, 50000n);
  assert.equal(review.gasLimit, 50000n);
  assert.equal(fields.chain_id, "11155111");
  assert.equal(fields.to, TOKEN);
  assert.equal(fields.data, CALLDATA);
});

/* ---------------------------------------------------------- signing vector */

test("the wasm core signs the pinned Ethereum mainnet ERC-20 vector", async () => {
  const wasm = await loadWasm();
  const request = {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: CALLDATA,
    private_key: KEY1
  };
  const raw = evm.callWasmString(wasm, "evm_sign_tx", JSON.stringify(request));
  assert.equal(raw, VECTOR_RAW);
  assert.equal("0x" + evm.keccak256Hex(bytesFromHex(raw)), VECTOR_HASH);
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
  console.error(`\n${failed} of ${cases.length} wallet ERC-20 tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length} wallet ERC-20 tests passed`);
