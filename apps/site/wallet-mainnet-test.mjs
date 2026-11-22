// Mainnet EVM signing tests for the cabinet wallet (apps/site/wallet-evm.js).
//
// Usage: node apps/site/wallet-mainnet-test.mjs
//
// No network and no DOM: every RPC response is a stub. The signing vector is
// the real committed wasm core signing a fixed key, checked against a raw
// transaction produced independently with ethers 6.17.0 on 2026-11-22.
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
const FROM_CHECKSUM = "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf";
const TO = "0x3535353535353535353535353535353535353535";
const ZERO = "0x" + "0".repeat(40);
const UNSIGNED = "0x02f8";
const TX_HASH = "0x" + "ab".repeat(32);

// ethers 6.17.0: new Wallet(KEY1).signTransaction({ type: 2, chainId: 1,
// nonce: 0, maxPriorityFeePerGas: 1 gwei, maxFeePerGas: 20 gwei,
// gasLimit: 21000, to: TO, value: 0.001 ETH, data: "0x" })
const VECTOR_RAW =
  "0x02f8720180843b9aca008504a817c80082520894353535353535353535353535353535353535353587038d7ea4c6800080c001a06d3bc7b5746e478cbb625caa5eb814c3d322d22f6d4689c460b9e443cdf690f3a00bda7f29c7cd9c9668bb35e62a1b6cc981ebdfcab4c04517b2af472230476fe9";
const VECTOR_HASH = "0xc2bf2f023f81b6a98dc9aea9895bd84759a61745d8efedc61bc83fc6e33c5a74";

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

const MAINNET_ANSWERS = {
  eth_chainId: "0x1",
  eth_getTransactionCount: "0x0",
  eth_getBalance: "0xde0b6b3a7640000", // 1 ETH
  eth_estimateGas: "0x5208", // 21000
  eth_feeHistory: { baseFeePerGas: ["0x3b9aca00", "0x77359400"] }, // next: 2 gwei
  eth_maxPriorityFeePerGas: "0x3b9aca00", // 1 gwei
  eth_gasPrice: "0x3b9aca00",
  eth_sendRawTransaction: TX_HASH
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
    value: "0.001",
    data: "",
    gasLimit: "",
    maxFee: "",
    priorityFee: "",
    ...overrides
  };
}

function mainnetOptions(overrides = {}) {
  return {
    form: baseForm(),
    from: FROM,
    expectedChainId: 1,
    mainnetArmed: true,
    unsigned: () => UNSIGNED,
    ...overrides
  };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

async function failureMessage(fn) {
  try {
    const value = await fn();
    return "resolved: " + String(value);
  } catch (err) {
    return err && err.message ? err.message : String(err);
  }
}

/* ---------------------------------------------------------- signing vector */

test("the wasm core signs the pinned Ethereum mainnet native-transfer vector", async () => {
  const wasm = await loadWasm();
  const request = {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "20000000000",
    gas_limit: "21000",
    to: TO,
    value: "1000000000000000",
    data: "0x",
    private_key: KEY1
  };
  const raw = evm.callWasmString(wasm, "evm_sign_tx", JSON.stringify(request));
  assert.equal(raw, VECTOR_RAW);
  assert.equal("0x" + evm.keccak256Hex(bytesFromHex(raw)), VECTOR_HASH);
});

/* ---------------------------------------------------------- EIP-55 / zero */

test("EIP-55 checksums the known key-1 address and rejects a wrong mixed case", async () => {
  assert.equal(evm.checksumAddress(FROM), FROM_CHECKSUM);
  assert.equal(evm.normalizeAddress(FROM_CHECKSUM), FROM);
  assert.equal(evm.normalizeAddress(TO), TO);
  assert.equal(evm.normalizeAddress("0x" + "35".repeat(20).toUpperCase().replace("0X", "0x")), TO);

  const badChecksum = FROM_CHECKSUM.slice(0, -1) +
    (FROM_CHECKSUM.endsWith("f") ? "F" : "f");
  assert.throws(() => evm.normalizeAddress(badChecksum), /EIP-55 checksum/);
  assert.match(await failureMessage(() => evm.normalizeAddress(badChecksum)), /EIP-55 checksum/);
});

test("the zero address is refused as a recipient", async () => {
  assert.throws(() => evm.normalizeAddress(ZERO), /zero address/);
  assert.match(await failureMessage(() => evm.normalizeAddress(ZERO)), /zero address/);
});

test("a mainnet review refuses a bad checksum or zero recipient before any RPC", async () => {
  const badChecksum = FROM_CHECKSUM.slice(0, -1) +
    (FROM_CHECKSUM.endsWith("f") ? "F" : "f");
  const mock = rpcMock(MAINNET_ANSWERS);
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      form: baseForm({ to: badChecksum }),
      fetchJson: mock.fetchJson
    })),
    (err) => {
      assert.match(err.fieldErrors.to, /EIP-55 checksum/);
      return true;
    }
  );
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      form: baseForm({ to: ZERO }),
      fetchJson: mock.fetchJson
    })),
    (err) => {
      assert.match(err.fieldErrors.to, /zero address/);
      return true;
    }
  );
  assert.equal(mock.calls.length, 0);
});

/* --------------------------------------------------------------- chain id */

test("a provider on the wrong chain is refused before review", async () => {
  const mock = rpcMock({ ...MAINNET_ANSWERS, eth_chainId: "0x38" }); // BNB mainnet
  let unsignedCalls = 0;
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      fetchJson: mock.fetchJson,
      unsigned() {
        unsignedCalls += 1;
        return UNSIGNED;
      }
    })),
    /Chain id mismatch/
  );
  assert.equal(unsignedCalls, 0);
});

test("a chain id outside the descriptor table is refused", async () => {
  const mock = rpcMock({ ...MAINNET_ANSWERS, eth_chainId: "0x270f" }); // 9999
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      expectedChainId: 9999,
      fetchJson: mock.fetchJson
    })),
    /not in the wallet chain table/
  );
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      expectedChainId: 1,
      fetchJson: mock.fetchJson,
      unsigned: () => UNSIGNED
    })),
    /Chain id mismatch/
  );
});

test("confirm re-reads the chain id and refuses a switch after review", async () => {
  const prepareMock = rpcMock(MAINNET_ANSWERS);
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: prepareMock.fetchJson
  }));
  assert.equal(review.chainId, 1);

  const sendMock = rpcMock({ eth_chainId: "0x38", eth_sendRawTransaction: TX_HASH });
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

test("Polygon and Optimism use verified anonymous RPC endpoints", () => {
  assert.deepEqual(
    evm.networkBySlug("polygon").providers.map((provider) => provider.url),
    ["https://polygon-bor-rpc.publicnode.com", "https://polygon.drpc.org"]
  );
  assert.deepEqual(
    evm.networkBySlug("optimism").providers.map((provider) => provider.url),
    ["https://optimism-rpc.publicnode.com", "https://optimism.drpc.org"]
  );
});

/* ------------------------------------------------------------- arm gate */

test("a mainnet review is refused until mainnet is armed", async () => {
  const mock = rpcMock(MAINNET_ANSWERS);
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      mainnetArmed: false,
      fetchJson: mock.fetchJson
    })),
    /Mainnet signing is not armed/
  );
  assert.equal(mock.calls.length, 0, "an unarmed mainnet send must not touch the RPC");
  assert.match(
    await failureMessage(() => evm.prepareTransaction(mainnetOptions({
      mainnetArmed: false,
      fetchJson: mock.fetchJson
    }))),
    /Mainnet signing is not armed/
  );
});

test("a prepared mainnet review cannot be confirmed after the arm is removed", async () => {
  const prepareMock = rpcMock(MAINNET_ANSWERS);
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: prepareMock.fetchJson
  }));
  const sendMock = rpcMock({ eth_chainId: "0x1", eth_sendRawTransaction: TX_HASH });
  let signCalls = 0;
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: sendMock.fetchJson,
      mainnetArmed: false,
      sign() {
        signCalls += 1;
        return VECTOR_RAW;
      }
    }),
    /Mainnet signing is not armed/
  );
  assert.equal(signCalls, 0);
  assert.equal(sendMock.calls.length, 0);
});

test("a mutated mainnet review cannot sign calldata or a zero-value transfer", async () => {
  const prepareMock = rpcMock(MAINNET_ANSWERS);
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: prepareMock.fetchJson
  }));
  const sendMock = rpcMock({ eth_chainId: "0x1", eth_sendRawTransaction: TX_HASH });
  const signCalls = [];
  const sign = (value) => {
    signCalls.push(value);
    return VECTOR_RAW;
  };
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, dataHex: "0xabcd" },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign
    }),
    /the reviewed transaction has calldata/
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, valueWei: 0n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign
    }),
    /the reviewed amount is not greater than zero/
  );
  assert.equal(signCalls.length, 0);
  assert.equal(sendMock.calls.length, 0);
});

/* ---------------------------------------------------------- fee/balance */

test("the per-chain fee cap is one table and refuses with exact numbers", async () => {
  assert.equal(evm.networkBySlug("ethereum").feeCapWei, 5n * 10n ** 16n);
  for (const slug of ["bnb", "arbitrum", "optimism", "base", "polygon", "avalanche", "zksync"]) {
    assert.equal(evm.networkBySlug(slug).feeCapWei, 10n ** 16n, slug);
  }
  const mock = rpcMock(MAINNET_ANSWERS);
  const options = mainnetOptions({
    form: baseForm({ gasLimit: "21000", maxFee: "3000", priorityFee: "1" }),
    fetchJson: mock.fetchJson
  });
  await assert.rejects(
    () => evm.prepareTransaction(options),
    /The maximum network fee 0\.063 ETH exceeds the Ethereum mainnet cap of 0\.05 ETH; refusing to sign\./
  );
  assert.match(
    await failureMessage(() => evm.prepareTransaction(options)),
    /0\.063 ETH exceeds the Ethereum mainnet cap of 0\.05 ETH/
  );
});

test("amount plus the maximum network fee above the balance is refused", async () => {
  const answers = {
    ...MAINNET_ANSWERS,
    eth_getBalance: "0x11c37937e08000" // 0.005 ETH
  };
  const mock = rpcMock(answers);
  const options = mainnetOptions({
    form: baseForm({ value: "0.004", gasLimit: "21000", maxFee: "100", priorityFee: "1" }),
    fetchJson: mock.fetchJson
  });
  await assert.rejects(
    () => evm.prepareTransaction(options),
    /The amount plus the maximum network fee \(0\.0061 ETH\) exceeds the balance of 0\.005 ETH; refusing to sign\./
  );
});

test("mainnet refuses calldata and zero-value transfers", async () => {
  const mock = rpcMock(MAINNET_ANSWERS);
  let unsignedCalls = 0;
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      form: baseForm({ data: "0xabcd" }),
      fetchJson: mock.fetchJson,
      unsigned() {
        unsignedCalls += 1;
        return UNSIGNED;
      }
    })),
    /Fix the highlighted fields/
  );
  await assert.rejects(
    () => evm.prepareTransaction(mainnetOptions({
      form: baseForm({ value: "0" }),
      fetchJson: mock.fetchJson,
      unsigned() {
        unsignedCalls += 1;
        return UNSIGNED;
      }
    })),
    /Fix the highlighted fields/
  );
  assert.equal(unsignedCalls, 0);
  assert.equal(mock.calls.length, 0);
});

test("mainnet gas uses eth_estimateGas plus a 20% buffer", async () => {
  const mock = rpcMock(MAINNET_ANSWERS);
  let fields = null;
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return UNSIGNED;
    }
  }));
  assert.equal(review.gasEstimate, 21000n);
  assert.equal(review.gasLimit, 25200n);
  assert.equal(review.gasLimitIsManual, false);
  assert.equal(fields.gas_limit, "25200");
  assert.equal(fields.chain_id, "1");
});

/* --------------------------------------------------------------- happy path */

test("a mainnet review and confirm stay local and broadcast exactly once", async () => {
  const prepareMock = rpcMock(MAINNET_ANSWERS);
  let fields = null;
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned(value) {
      fields = value;
      return UNSIGNED;
    }
  }));
  assert.equal(review.chainId, 1);
  assert.equal(review.chainName, "Ethereum mainnet");
  assert.equal(review.testnet, false);
  assert.equal(review.symbol, "ETH");
  assert.equal(review.explorerTx, "https://etherscan.io/tx/");
  assert.equal(review.feeCapWei, 5n * 10n ** 16n);
  assert.equal(fields.chain_id, "1");
  assert.equal(fields.value, "1000000000000000");
  assert.equal(fields.to, TO);

  const sendMock = rpcMock({ eth_chainId: "0x1", eth_sendRawTransaction: TX_HASH });
  const signCalls = [];
  const result = await evm.confirmTransaction({
    review,
    fetchJson: sendMock.fetchJson,
    mainnetArmed: true,
    sign(value) {
      signCalls.push(value);
      return VECTOR_RAW;
    }
  });
  assert.equal(signCalls.length, 1);
  assert.equal(result.signedHex, VECTOR_RAW);
  assert.equal(result.txHash, TX_HASH);
  assert.equal(result.chainName, "Ethereum mainnet");
  assert.equal(result.explorerUrl, "https://etherscan.io/tx/" + TX_HASH);
  assert.deepEqual(sendMock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_sendRawTransaction"
  ]);
  const broadcasts = sendMock.calls.filter((call) => call.method === "eth_sendRawTransaction");
  assert.equal(broadcasts.length, 1, "the raw transaction must be sent exactly once");
  for (const call of [...prepareMock.calls, ...sendMock.calls]) {
    assert.ok(!call.body.includes("private_key"), "an RPC payload leaked a key");
    assert.ok(!call.body.includes(KEY1.slice(2)), "an RPC payload leaked the key bytes");
  }
});

test("a broadcast error is returned verbatim and not retried", async () => {
  const prepareMock = rpcMock(MAINNET_ANSWERS);
  const review = await evm.prepareTransaction(mainnetOptions({
    fetchJson: prepareMock.fetchJson
  }));
  const sendMock = rpcMock({
    eth_chainId: "0x1",
    eth_sendRawTransaction: { rpcError: "nonce too low" }
  });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      sign: () => VECTOR_RAW
    }),
    /Broadcasting to publicnode\.com failed: nonce too low/
  );
  assert.equal(
    sendMock.calls.filter((call) => call.method === "eth_sendRawTransaction").length,
    1,
    "a failed broadcast must not be retried"
  );
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
  console.error(`\n${failed} of ${cases.length} wallet mainnet tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length} wallet mainnet tests passed`);
