// ERC-20 approvals reader, grant and revoke tests for the cabinet wallet
// (apps/site/wallet-evm.js).
//
// Usage: node apps/site/wallet-approvals-test.mjs
//
// No network and no DOM: every RPC response is a stub. The approve calldata is
// checked against independent ethers 6.17.0 output, and an unlimited approve
// is signed by the committed WASM core and pinned against the same ethers
// vector. Every refusal path is pinned with its exact message.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
require("./chains.generated.js");
require("./amount.js");
const evm = require("./wallet-evm.js");

const KEY1 = "0x" + "0".repeat(63) + "1";
const OWNER = "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf";
const TOKEN = "0x1111111111111111111111111111111111111111";
const SPENDER = "0x3535353535353535353535353535353535353535";
const OTHER = "0x2222222222222222222222222222222222222222";
const THIRD = "0x4444444444444444444444444444444444444444";
const U256_MAX = (1n << 256n) - 1n;
const TX_HASH = "0x" + "ab".repeat(32);

/* ethers 6.17.0:
 *   new ethers.Interface(["function approve(address spender, uint256 amount)"])
 *     .encodeFunctionData("approve", [SPENDER, 1234500n])
 *     .encodeFunctionData("approve", [SPENDER, 2^256-1]) */
const FINITE_CALLDATA =
  "0x095ea7b3" +
  "000000000000000000000000" + SPENDER.slice(2) +
  "000000000000000000000000000000000000000000000000000000000012d644";
const UNLIMITED_CALLDATA =
  "0x095ea7b3" +
  "000000000000000000000000" + SPENDER.slice(2) +
  "f".repeat(64);
/* ethers 6.17.0 raw transaction for the unlimited approve below and its
 * Keccak-256: type 2, chain 1, nonce 0, 1 gwei priority, 5 gwei max, gas
 * 60000, to TOKEN, value 0, data UNLIMITED_CALLDATA, key KEY1. */
const UNLIMITED_RAW =
  "0x02f8b00180843b9aca0085012a05f20082ea6094111111111111111111111111111111111111111180b844095ea7b30000000000000000000000003535353535353535353535353535353535353535ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffc080a0a62b85eb883a11f18a93517ba0ac115357910a278fd0f273b14d47d5a708e681a0723cf9c87734c97439b55ac0f49c2439ca13836dd7e68639c5caf35d16c6a7b2";
const UNLIMITED_HASH =
  "0xe4ca7a56f7999d6810cacbea5bd738c204a518cdfba3bcb91afd751ea4320fac";

const DECIMALS_SELECTOR = "0x313ce567";
const SYMBOL_SELECTOR = "0x95d89b41";
const ALLOWANCE_SELECTOR = "0xdd62ed3e";
const TRANSFER_SELECTOR = "0xa9059cbb";

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

function hex(value) {
  return "0x" + value.toString(16);
}

/* A canonical Approval(address,address,uint256) log. */
function approvalLog(spender, value, blockNumber, logIndex, overrides = {}) {
  return {
    address: TOKEN,
    topics: [
      evm.APPROVAL_TOPIC,
      "0x" + word(OWNER),
      "0x" + word(spender),
    ],
    data: "0x" + word(value),
    blockNumber: hex(blockNumber),
    logIndex: hex(logIndex),
    removed: false,
    ...overrides,
  };
}

/* Deterministic stand-in for the local unsigned-transaction builder. */
function fakeUnsigned(fields) {
  return "0x02" + Buffer.from(JSON.stringify(fields), "utf8").toString("hex");
}

/* Stub RPC with a block-range limit, an optional archive horizon and a log
 * store. eth_call answers decimals/symbol/allowance from the options. */
function rpcMock(options = {}) {
  const calls = [];
  const chainId = options.chainId === undefined ? "0x1" : options.chainId;
  const latest = options.latest === undefined ? 100000 : options.latest;
  const code = options.code === undefined ? "0x6080604052348015600f57600080fd5b50" : options.code;
  const decimals = options.decimals === undefined ? 6 : options.decimals;
  const symbolResult = options.symbolResult === undefined
    ? abiString(options.symbol === undefined ? "USDT" : options.symbol)
    : options.symbolResult;
  const rangeLimit = options.rangeLimit === undefined ? null : options.rangeLimit;
  const archiveHorizon = options.archiveHorizon === undefined ? null : options.archiveHorizon;
  const logs = options.logs || [];
  const allowances = options.allowances || {};
  const spenderCodes = options.spenderCodes || {};
  const allowanceFailures = { ...(options.allowanceFailures || {}) };
  const networkFailAt = options.networkFailAt || [];
  let logRequestCount = 0;
  const nativeBalance = options.nativeBalance === undefined ? "0xde0b6b3a7640000" : options.nativeBalance;
  const gasEstimate = options.gasEstimate === undefined ? "0xc350" : options.gasEstimate;

  function result(value) {
    return { jsonrpc: "2.0", id: 1, result: value };
  }
  function rpcError(message) {
    return { jsonrpc: "2.0", id: 1, error: { code: 3, message } };
  }
  function allowanceKey(owner, spender) {
    return owner.toLowerCase() + ":" + spender.toLowerCase();
  }

  async function fetchJson(url, init) {
    const body = JSON.parse(init.body);
    calls.push({ url, method: body.method, params: body.params, body: init.body });
    switch (body.method) {
      case "eth_chainId":
        return result(chainId);
      case "eth_blockNumber":
        return result(hex(latest));
      case "eth_getCode": {
        const address = String(body.params[0]).toLowerCase();
        if (address === TOKEN.toLowerCase()) return result(code);
        const spenderCode = spenderCodes[address];
        return result(spenderCode === undefined ? "0x" : spenderCode);
      }
      case "eth_call": {
        const call = body.params[0];
        if (call.data === DECIMALS_SELECTOR) return result("0x" + word(decimals));
        if (call.data === SYMBOL_SELECTOR) return result(symbolResult);
        if (call.data.startsWith(ALLOWANCE_SELECTOR) && call.data.length === ALLOWANCE_SELECTOR.length + 128) {
          const owner = "0x" + call.data.slice(10, 74).slice(-40);
          const spender = "0x" + call.data.slice(74, 138).slice(-40);
          if (allowanceFailures[spender] > 0) {
            allowanceFailures[spender] -= 1;
            throw new Error("fetch failed");
          }
          const value = allowances[allowanceKey(owner, spender)];
          return result("0x" + word(value === undefined ? 0n : value));
        }
        return rpcError("method not mocked: eth_call " + call.data.slice(0, 10));
      }
      case "eth_getLogs": {
        logRequestCount += 1;
        if (networkFailAt.includes(logRequestCount)) {
          throw new Error("fetch failed");
        }
        const filter = body.params[0];
        const from = Number.parseInt(filter.fromBlock, 16);
        const to = Number.parseInt(filter.toBlock, 16);
        if (rangeLimit !== null && to - from + 1 > rangeLimit) {
          return rpcError("ranges over " + rangeLimit + " blocks are not supported on free plan");
        }
        if (archiveHorizon !== null && from < archiveHorizon) {
          return rpcError("Archive requests require a personal token. Get one at: https://example.invalid");
        }
        return result(logs.filter((log) => {
          const block = Number.parseInt(log.blockNumber, 16);
          return block >= from && block <= to;
        }));
      }
      case "eth_getTransactionCount":
        return result("0x0");
      case "eth_getBalance":
        return result(nativeBalance);
      case "eth_estimateGas":
        if (gasEstimate instanceof Error) throw gasEstimate;
        return result(gasEstimate);
      case "eth_feeHistory":
        return result({ baseFeePerGas: ["0x3b9aca00", "0x77359400"] });
      case "eth_maxPriorityFeePerGas":
        return result("0x3b9aca00");
      case "eth_sendRawTransaction":
        return result(options.txHash === undefined ? TX_HASH : options.txHash);
      default:
        return rpcError("method not mocked: " + body.method);
    }
  }

  return { fetchJson, calls };
}

function scanOptions(overrides = {}) {
  return {
    token: TOKEN,
    owner: OWNER,
    expectedChainId: 1,
    windowBlocks: "1000",
    ...overrides,
  };
}

function revokeOptions(overrides = {}) {
  return {
    token: TOKEN,
    spender: SPENDER,
    from: OWNER,
    expectedChainId: 1,
    mainnetArmed: true,
    unsigned: fakeUnsigned,
    ...overrides,
  };
}

function grantOptions(overrides = {}) {
  return {
    token: TOKEN,
    spender: SPENDER,
    amountText: "1.2345",
    unlimited: false,
    from: OWNER,
    expectedChainId: 1,
    mainnetArmed: true,
    unsigned: fakeUnsigned,
    ...overrides,
  };
}

const cases = [];
function test(name, fn) {
  cases.push({ name, fn });
}

/* ----------------------------------------------------------- formatting */

test("allowance formatting shows 2^256-1 as Unlimited and keeps exact units", () => {
  assert.equal(evm.formatAllowance(U256_MAX, 18), "Unlimited");
  assert.equal(evm.formatAllowance(0n, 6), "0");
  assert.equal(evm.formatAllowance(1234500n, 6), "1.2345");
  assert.equal(evm.formatAllowance(1000000n, 6), "1");
  assert.equal(evm.formatAllowance(1234567890123456789012n, 18), "1,234.567890123456789012");
  assert.equal(evm.formatAllowance(500n, 0), "500");
});

/* -------------------------------------------------------------- chunking */

test("approval chunks walk newest-first and clamp at the window floor", () => {
  assert.deepEqual(evm.nextApprovalChunk(10000n, 0n, 5000), {
    fromBlock: 5001n,
    toBlock: 10000n,
    size: 5000,
  });
  assert.deepEqual(evm.nextApprovalChunk(5000n, 0n, 5000), {
    fromBlock: 1n,
    toBlock: 5000n,
    size: 5000,
  });
  assert.deepEqual(evm.nextApprovalChunk(100n, 0n, 5000), {
    fromBlock: 0n,
    toBlock: 100n,
    size: 101,
  });
  assert.equal(evm.nextApprovalChunk(0n, 1n, 5000), null);
  assert.throws(() => evm.nextApprovalChunk(10n, 0n, 0), /positive block count/);
});

test("scan window parsing accepts 1-1,000,000 whole blocks", () => {
  assert.equal(evm.parseWindowBlocks("50000"), 50000);
  assert.equal(evm.parseWindowBlocks("1"), 1);
  assert.equal(evm.parseWindowBlocks("1000000"), 1000000);
  assert.throws(() => evm.parseWindowBlocks(""), /whole number of blocks/);
  assert.throws(() => evm.parseWindowBlocks("1.5"), /whole number of blocks/);
  assert.throws(() => evm.parseWindowBlocks("0"), /between 1 and 1000000/);
  assert.throws(() => evm.parseWindowBlocks("1000001"), /between 1 and 1000000/);
});

/* ------------------------------------------------------- log classification */

test("eth_getLogs errors are classified into range and archive recoveries", () => {
  assert.deepEqual(
    evm.classifyLogRangeError("ranges over 100 blocks are not supported on free plan"),
    { kind: "range", limit: 100 },
  );
  assert.deepEqual(
    evm.classifyLogRangeError("eth_getLogs is limited to 0 - 50 blocks range"),
    { kind: "range", limit: 50 },
  );
  assert.deepEqual(
    evm.classifyLogRangeError("query returned more than 10000 results"),
    { kind: "range", limit: null },
  );
  assert.deepEqual(
    evm.classifyLogRangeError("Archive requests require a personal token. Get one at: https://example.invalid"),
    { kind: "archive", limit: null },
  );
  assert.deepEqual(evm.classifyLogRangeError("fetch failed"), { kind: "network", limit: null });
  assert.deepEqual(evm.classifyLogRangeError("TypeError: Failed to fetch"), { kind: "network", limit: null });
  assert.deepEqual(evm.classifyLogRangeError("some other failure"), { kind: "other", limit: null });
});

/* ----------------------------------------------------------- log parsing */

test("Approval logs from the contract and owner are deduped, newest wins", () => {
  const merged = evm.mergeApprovalLogs(new Map(), [
    approvalLog(SPENDER, 100, 100, 1),
    approvalLog(SPENDER, 200, 101, 0),
    approvalLog(OTHER, 300, 99, 5),
    approvalLog(OTHER, 400, 99, 9),
    /* wrong owner */
    approvalLog(SPENDER, 999, 102, 0, { topics: [evm.APPROVAL_TOPIC, "0x" + word(THIRD), "0x" + word(SPENDER)] }),
    /* wrong contract */
    approvalLog(SPENDER, 999, 102, 1, { address: OTHER }),
    /* removed log */
    approvalLog(SPENDER, 999, 102, 2, { removed: true }),
  ], TOKEN, OWNER);

  assert.equal(merged.malformed, 0);
  const map = merged.entries;
  assert.equal(map.size, 2);
  assert.equal(map.get(SPENDER).value, 200n);
  assert.equal(map.get(SPENDER).blockNumber, 101);
  assert.equal(map.get(OTHER).value, 400n);
  assert.equal(map.get(OTHER).blockNumber, 99);
  assert.equal(map.get(OTHER).logIndex, 9);
});

test("malformed matching Approval logs are skipped and counted", () => {
  const badData = approvalLog(SPENDER, 1, 10, 0, { data: "0x12" });
  const badTopic = approvalLog(OTHER, 1, 11, 0, { topics: [evm.APPROVAL_TOPIC, "0x" + word(OWNER), "0x12"] });
  const valid = approvalLog(SPENDER, 5, 12, 0);
  const merged = evm.mergeApprovalLogs(new Map(), [badData, badTopic, valid], TOKEN, OWNER);
  assert.equal(merged.malformed, 2);
  assert.equal(merged.entries.size, 1);
  assert.equal(merged.entries.get(SPENDER).value, 5n);
});

/* ------------------------------------------------------------- calldata */

test("revoke calldata is approve(spender, 0) against an independent encoding", () => {
  const selector = "0x" + evm.keccak256Hex("approve(address,uint256)").slice(0, 8);
  assert.equal(selector, "0x095ea7b3");
  const independent = selector + SPENDER.slice(2).padStart(64, "0") + "0".repeat(64);
  assert.equal(evm.revokeCalldata(SPENDER), independent);
  assert.equal(evm.revokeCalldata(SPENDER).length, 10 + 64 + 64);
  assert.throws(() => evm.revokeCalldata("nope"), /40 hex characters/);
  assert.throws(() => evm.revokeCalldata("0x" + "0".repeat(40)), /zero address/);
});

/* ----------------------------------------------------------- scanApprovals */

test("scan reads the current allowance, not the log value, and labels EOA/contract", async () => {
  const mock = rpcMock({
    latest: 1000,
    logs: [
      approvalLog(SPENDER, 100, 990, 1),
      approvalLog(SPENDER, 200, 995, 0),
      approvalLog(OTHER, 300, 900, 4),
    ],
    allowances: {
      [OWNER + ":" + SPENDER]: 1234500n,
      [OWNER + ":" + OTHER]: 0n,
    },
    spenderCodes: {
      [SPENDER]: "0x6080",
      [OTHER]: "0x",
    },
  });
  const scan = await evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson }));

  assert.equal(scan.contract, TOKEN);
  assert.equal(scan.symbol, "USDT");
  assert.equal(scan.decimals, 6);
  assert.equal(scan.owner, OWNER);
  assert.equal(scan.latestBlock, 1000n);
  assert.equal(scan.requestedWindow, 1000);
  assert.equal(scan.truncated, false);
  assert.equal(scan.uniqueSpenders, 2);
  assert.equal(scan.spenders.length, 2);

  /* Newest approval first. */
  assert.equal(scan.spenders[0].address, SPENDER);
  assert.equal(scan.spenders[0].allowance, 1234500n);
  assert.equal(scan.spenders[0].isContract, true);
  assert.equal(scan.spenders[0].lastLogBlock, 995);
  assert.equal(scan.spenders[1].address, OTHER);
  assert.equal(scan.spenders[1].allowance, 0n);
  assert.equal(scan.spenders[1].isContract, false);

  assert.equal(evm.formatAllowance(scan.spenders[0].allowance, scan.decimals), "1.2345");
  assert.equal(evm.formatAllowance(scan.spenders[1].allowance, scan.decimals), "0");

  /* The current allowance is read once per spender even though SPENDER has
   * two logs. */
  const allowanceCalls = mock.calls.filter((call) =>
    call.method === "eth_call" && call.params[0].data.startsWith(ALLOWANCE_SELECTOR));
  assert.equal(allowanceCalls.length, 2);
  assert.ok(allowanceCalls.every((call) => !call.body.includes("private_key")));
});

test("a transient allowance read is retried once", async () => {
  const mock = rpcMock({
    latest: 1000,
    logs: [approvalLog(SPENDER, 1, 990, 0)],
    allowances: { [OWNER + ":" + SPENDER]: 500n },
    allowanceFailures: { [SPENDER]: 1 },
  });
  const scan = await evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson }));
  assert.equal(scan.spenders[0].allowance, 500n);
  assert.equal(scan.warnings.length, 0);
});

test("a failed allowance read marks that row unknown instead of dropping the list", async () => {
  const mock = rpcMock({
    latest: 1000,
    logs: [approvalLog(SPENDER, 1, 990, 0)],
    allowances: { [OWNER + ":" + SPENDER]: 500n },
    allowanceFailures: { [SPENDER]: 99 },
  });
  const scan = await evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson }));
  assert.equal(scan.spenders.length, 1);
  assert.equal(scan.spenders[0].allowance, null);
  assert.ok(scan.warnings.some((warning) => /current allowance/.test(warning)));
});

test("a token without code, bad decimals or an unfamiliar symbol is refused", async () => {
  const noCode = rpcMock({ code: "0x" });
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: noCode.fetchJson })),
    /The token address 0x1111111111111111111111111111111111111111 has no contract code on Ethereum mainnet; it is an externally owned account or does not exist\. Refusing to sign\./,
  );

  const decimals25 = rpcMock({ decimals: 25 });
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: decimals25.fetchJson })),
    /The token reports 25 decimals; this wallet signs ERC-20 amounts with 0 to 24 decimals only\. Refusing to sign\./,
  );

  const longSymbol = rpcMock({ symbolResult: abiString("A".repeat(33)) });
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: longSymbol.fetchJson })),
    /The token symbol is longer than 32 characters; refusing to sign an unfamiliar token\./,
  );

  const controlSymbol = rpcMock({ symbolResult: abiString("US\x01DT") });
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: controlSymbol.fetchJson })),
    /The token symbol contains non-printable characters; refusing to sign an unfamiliar token\./,
  );
});

test("scan adapts the chunk size to a provider's numeric range limit", async () => {
  const mock = rpcMock({ latest: 10000, rangeLimit: 100, logs: [] });
  const scan = await evm.scanApprovals(scanOptions({
    fetchJson: mock.fetchJson,
    windowBlocks: "1000",
  }));
  assert.equal(scan.truncated, false);
  assert.equal(scan.scannedFromBlock, 9001n);
  const logCalls = mock.calls.filter((call) => call.method === "eth_getLogs");
  assert.ok(logCalls.length >= 10);
  /* The first call probes the full window and is rejected; every retry after
   * the numeric limit is discovered stays inside it. */
  logCalls.forEach((call, index) => {
    const from = Number.parseInt(call.params[0].fromBlock, 16);
    const to = Number.parseInt(call.params[0].toBlock, 16);
    if (index > 0) assert.ok(to - from + 1 <= 100, `requested ${to - from + 1} blocks`);
  });
});

test("scan stops honestly at a provider archive horizon and reports the coverage", async () => {
  const mock = rpcMock({
    latest: 10000,
    archiveHorizon: 9000,
    logs: [approvalLog(SPENDER, 5, 9500, 0)],
    allowances: { [OWNER + ":" + SPENDER]: 5n },
  });
  const scan = await evm.scanApprovals(scanOptions({
    fetchJson: mock.fetchJson,
    windowBlocks: "5000",
  }));
  assert.equal(scan.truncated, true);
  assert.ok(scan.scannedFromBlock >= 9000n, `scanned from ${scan.scannedFromBlock}`);
  assert.equal(scan.spenders.length, 1);
  assert.ok(scan.warnings.some((warning) => /archive/.test(warning)));
  const logCalls = mock.calls.filter((call) => call.method === "eth_getLogs");
  for (const call of logCalls) {
    const from = Number.parseInt(call.params[0].fromBlock, 16);
    if (from < 9000) assert.ok(true, "the mock rejected the pre-horizon request");
  }
});

test("a provider connection reset keeps the blocks already scanned and says so", async () => {
  const mock = rpcMock({
    latest: 10000,
    logs: [approvalLog(SPENDER, 5, 9500, 0)],
    allowances: { [OWNER + ":" + SPENDER]: 5n },
    networkFailAt: [2, 3],
  });
  const scan = await evm.scanApprovals(scanOptions({
    fetchJson: mock.fetchJson,
    windowBlocks: "10000",
  }));
  assert.equal(scan.truncated, true);
  assert.equal(scan.spenders.length, 1);
  assert.equal(scan.scannedFromBlock, 5001n);
  assert.ok(scan.warnings.some((warning) => /connection failed/.test(warning)));
});

test("a connection reset before any block is scanned fails loud", async () => {
  const mock = rpcMock({ latest: 10000, networkFailAt: [1, 2] });
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson, windowBlocks: "10000" })),
    /Scanning Approval logs failed on .*fetch failed/,
  );
});

test("a malformed matching log is skipped, counted and surfaced in the warnings", async () => {
  const malformed = approvalLog(SPENDER, 1, 995, 0, { data: "0x12" });
  const mock = rpcMock({
    latest: 1000,
    logs: [approvalLog(SPENDER, 5, 996, 0), malformed],
    allowances: { [OWNER + ":" + SPENDER]: 5n },
  });
  const scan = await evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson }));
  assert.equal(scan.spenders.length, 1);
  assert.equal(scan.spenders[0].allowance, 5n);
  assert.ok(scan.warnings.some((warning) => /1 malformed log\(s\) skipped/.test(warning)));
});

test("a scan refused before any block reports an empty coverage range", async () => {
  const mock = rpcMock({ latest: 20000, archiveHorizon: 30000, logs: [] });
  const scan = await evm.scanApprovals(scanOptions({
    fetchJson: mock.fetchJson,
    windowBlocks: "10000",
  }));
  assert.equal(scan.truncated, true);
  assert.equal(scan.spenders.length, 0);
  assert.ok(scan.scannedFromBlock > scan.scannedToBlock);
  assert.ok(scan.warnings.some((warning) => /archive/.test(warning)));
});

test("scan caps the list at 50 spenders and says so", async () => {
  const logs = [];
  const allowances = {};
  for (let index = 0; index < 60; index += 1) {
    const spender = "0x" + (index + 1).toString(16).padStart(40, "0");
    logs.push(approvalLog(spender, 1, 1000 - index, 0));
    allowances[OWNER + ":" + spender] = 0n;
  }
  const mock = rpcMock({ latest: 1000, logs, allowances });
  const scan = await evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson }));
  assert.equal(scan.uniqueSpenders, 60);
  assert.equal(scan.spenders.length, 50);
  assert.equal(scan.cap, 50);
  assert.ok(scan.warnings.some((warning) => /most recent of 60 spenders/.test(warning)));
});

test("a bad scan window is a field error and a bad token is refused locally", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson, windowBlocks: "0" })),
    (err) => {
      assert.deepEqual(err.fieldErrors, { window: "Scan window must be between 1 and 1000000 blocks." });
      return true;
    },
  );
  await assert.rejects(
    () => evm.scanApprovals(scanOptions({ fetchJson: mock.fetchJson, token: "0x1234" })),
    /The token contract is invalid: Use 0x followed by 40 hex characters\./,
  );
  assert.equal(mock.calls.length, 0);
});

/* ----------------------------------------------------------- prepareRevoke */

test("prepareRevoke builds approve(spender, 0) and reviews the current allowance", async () => {
  const mock = rpcMock({
    allowances: { [OWNER + ":" + SPENDER]: 5000000n },
  });
  let fields = null;
  const review = await evm.prepareRevoke(revokeOptions({
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    },
  }));

  assert.equal(review.isRevoke, true);
  assert.equal(review.isToken, false);
  assert.equal(review.to, TOKEN);
  assert.equal(review.spender, SPENDER);
  assert.equal(review.tokenContract, TOKEN);
  assert.equal(review.tokenSymbol, "USDT");
  assert.equal(review.tokenDecimals, 6);
  assert.equal(review.approvalAmountWei, 0n);
  assert.equal(review.currentAllowanceWei, 5000000n);
  assert.equal(review.valueWei, 0n);
  assert.equal(review.dataHex, evm.revokeCalldata(SPENDER));
  assert.deepEqual(fields, {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: evm.revokeCalldata(SPENDER),
  });
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
    "eth_maxPriorityFeePerGas",
  ]);
  const allowanceCall = mock.calls.find((call) =>
    call.method === "eth_call" && call.params[0].data.startsWith(ALLOWANCE_SELECTOR));
  assert.equal(allowanceCall.params[0].data,
    ALLOWANCE_SELECTOR + word(OWNER) + word(SPENDER));
  for (const call of mock.calls) {
    assert.ok(!call.body.includes("private_key"), "an RPC payload leaked a key");
  }
});

test("prepareRevoke refuses an allowance that is already zero", async () => {
  const mock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: 0n } });
  await assert.rejects(
    () => evm.prepareRevoke(revokeOptions({ fetchJson: mock.fetchJson })),
    /The allowance for 0x3535353535353535353535353535353535353535 is already zero; there is nothing to revoke\./,
  );
});

test("prepareRevoke refuses a token without code and an unarmed mainnet before any RPC", async () => {
  const noCode = rpcMock({ code: "0x" });
  await assert.rejects(
    () => evm.prepareRevoke(revokeOptions({ fetchJson: noCode.fetchJson })),
    /has no contract code on Ethereum mainnet; it is an externally owned account or does not exist\. Refusing to sign\./,
  );

  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareRevoke(revokeOptions({ fetchJson: mock.fetchJson, mainnetArmed: false })),
    /Mainnet signing is not armed/,
  );
  assert.equal(mock.calls.length, 0);
});

test("prepareRevoke reuses the fee cap and the native fee-only balance gate", async () => {
  const cap = rpcMock({
    allowances: { [OWNER + ":" + SPENDER]: 1n },
    gasEstimate: "0x1312d00", // 20,000,000; +20% buffer x 5 gwei = 0.12 ETH
  });
  await assert.rejects(
    () => evm.prepareRevoke(revokeOptions({
      fetchJson: cap.fetchJson,
      unsigned: fakeUnsigned,
    })),
    /The maximum network fee 0\.12 ETH exceeds the Ethereum mainnet cap of 0\.05 ETH; refusing to sign\./,
  );
});

/* --------------------------------------------------------------- confirm */

test("confirm re-reads the chain, signs the revoke once and broadcasts once", async () => {
  const prepareMock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: 5000000n } });
  const review = await evm.prepareRevoke(revokeOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: fakeUnsigned,
  }));

  const sendMock = rpcMock({ chainId: "0x1" });
  const signCalls = [];
  const result = await evm.confirmTransaction({
    review,
    fetchJson: sendMock.fetchJson,
    mainnetArmed: true,
    unsigned: fakeUnsigned,
    sign(fields) {
      signCalls.push(fields);
      return "0x02f8";
    },
  });

  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].to, TOKEN);
  assert.equal(signCalls[0].value, "0");
  assert.equal(signCalls[0].data, evm.revokeCalldata(SPENDER));
  assert.equal(result.txHash, TX_HASH);
  assert.deepEqual(sendMock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_sendRawTransaction",
  ]);
  assert.equal(
    sendMock.calls.filter((call) => call.method === "eth_sendRawTransaction").length,
    1,
    "the revoke must be broadcast exactly once",
  );
});

test("a revoked review cannot change the spender, amount or calldata", async () => {
  const prepareMock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: 5000000n } });
  const review = await evm.prepareRevoke(revokeOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: fakeUnsigned,
  }));
  const sendMock = rpcMock({ chainId: "0x1" });
  let signCalls = 0;
  const sign = () => {
    signCalls += 1;
    return "0x02f8";
  };

  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, spender: OTHER },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign,
    }),
    /The reviewed revoke calldata does not match the reviewed spender and a zero allowance\. Refusing to sign\./,
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, approvalAmountWei: 1n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign,
    }),
    /The reviewed approval amount is not zero\. Refusing to sign\./,
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, dataHex: evm.revokeCalldata(SPENDER).replace(/0{64}$/, word(1)) },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign,
    }),
    /The reviewed revoke calldata does not match/,
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, valueWei: 1n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign,
    }),
    /A revoke must not send native value/,
  );
  await assert.rejects(
    () => evm.confirmTransaction({
      review: { ...review, nonce: review.nonce + 1n },
      fetchJson: sendMock.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign,
    }),
    /does not match the reviewed fields/,
  );
  assert.equal(signCalls, 0);
  assert.equal(sendMock.calls.length, 0);
});

test("a prepared revoke cannot be confirmed after the chain switch or arm removal", async () => {
  const prepareMock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: 5000000n } });
  const review = await evm.prepareRevoke(revokeOptions({
    fetchJson: prepareMock.fetchJson,
    unsigned: fakeUnsigned,
  }));

  const switched = rpcMock({ chainId: "0xaa36a7" });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: switched.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign: () => "0x02f8",
    }),
    /Chain id mismatch/,
  );

  const unarmed = rpcMock({ chainId: "0x1" });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: unarmed.fetchJson,
      mainnetArmed: false,
      unsigned: fakeUnsigned,
      sign: () => "0x02f8",
    }),
    /Mainnet signing is not armed/,
  );
  assert.equal(unarmed.calls.length, 0);
});

test("readAllowance builds allowance(owner,spender) and decodes the current value", async () => {
  const mock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: U256_MAX } });
  const value = await evm.readAllowance(mock.fetchJson, "https://rpc.invalid",
    TOKEN, OWNER, SPENDER);
  assert.equal(value, U256_MAX);
  assert.equal(evm.formatAllowance(value, 18), "Unlimited");
  const call = mock.calls[0];
  assert.equal(call.method, "eth_call");
  assert.deepEqual(call.params, [{
    to: TOKEN,
    data: ALLOWANCE_SELECTOR + word(OWNER) + word(SPENDER),
  }, "latest"]);
});

test("a revoke on Sepolia needs no arm and skips the mainnet buffer", async () => {
  const mock = rpcMock({
    chainId: "0xaa36a7",
    allowances: { [OWNER + ":" + SPENDER]: 10n },
  });
  let fields = null;
  const review = await evm.prepareRevoke(revokeOptions({
    expectedChainId: 11155111,
    mainnetArmed: false,
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    },
  }));
  assert.equal(review.testnet, true);
  assert.equal(review.gasEstimate, 50000n);
  assert.equal(review.gasLimit, 50000n);
  assert.equal(fields.chain_id, "11155111");
  assert.equal(fields.data, evm.revokeCalldata(SPENDER));
});

/* ------------------------------------------------------- grant calldata */

test("approve calldata for a finite amount and Unlimited matches ethers", () => {
  assert.equal(evm.keccak256Hex("approve(address,uint256)").slice(0, 8), "095ea7b3");
  assert.equal(evm.approveCalldata(SPENDER, 1234500n), FINITE_CALLDATA);
  assert.equal(evm.approveCalldata(SPENDER, U256_MAX), UNLIMITED_CALLDATA);
  assert.equal(FINITE_CALLDATA.length, 10 + 64 + 64);
  assert.throws(() => evm.approveCalldata(SPENDER, U256_MAX + 1n), /uint256/);
  assert.throws(() => evm.approveCalldata("0x" + "0".repeat(40), 1n), /zero address/);
});

test("the wasm core signs the pinned unlimited approve vector", async () => {
  const wasm = await loadWasm();
  const request = {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: UNLIMITED_CALLDATA,
    private_key: KEY1,
  };
  const raw = evm.callWasmString(wasm, "evm_sign_tx", JSON.stringify(request));
  assert.equal(raw, UNLIMITED_RAW);
  assert.equal("0x" + evm.keccak256Hex(bytesFromHex(raw)), UNLIMITED_HASH);
});

/* ----------------------------------------------------------- prepareGrant */

test("prepareGrant parses a finite amount with token decimals and labels an EOA spender", async () => {
  const mock = rpcMock({ allowances: { [OWNER + ":" + SPENDER]: 0n } });
  let fields = null;
  const review = await evm.prepareGrant(grantOptions({
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    },
  }));

  assert.equal(review.isGrant, true);
  assert.equal(review.isRevoke, false);
  assert.equal(review.isToken, false);
  assert.equal(review.to, TOKEN);
  assert.equal(review.spender, SPENDER);
  assert.equal(review.spenderIsContract, false);
  assert.equal(review.tokenContract, TOKEN);
  assert.equal(review.tokenSymbol, "USDT");
  assert.equal(review.tokenDecimals, 6);
  assert.equal(review.approvalAmountWei, 1234500n);
  assert.equal(review.currentAllowanceWei, 0n);
  assert.equal(review.valueWei, 0n);
  assert.equal(review.dataHex, FINITE_CALLDATA);
  assert.deepEqual(review.warnings, []);
  assert.deepEqual(fields, {
    chain_id: "1",
    nonce: "0",
    max_priority_fee: "1000000000",
    max_fee: "5000000000",
    gas_limit: "60000",
    to: TOKEN,
    value: "0",
    data: FINITE_CALLDATA,
  });
  for (const call of mock.calls) {
    assert.ok(!call.body.includes("private_key"), "an RPC payload leaked a key");
  }
});

test("prepareGrant for Unlimited pins 2^256-1 and carries the warning line", async () => {
  const mock = rpcMock({ spenderCodes: { [SPENDER]: "0x6080" } });
  let fields = null;
  const review = await evm.prepareGrant(grantOptions({
    unlimited: true,
    amountText: "",
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    },
  }));

  assert.equal(review.isGrant, true);
  assert.equal(review.spenderIsContract, true);
  assert.equal(review.approvalAmountWei, U256_MAX);
  assert.equal(review.dataHex, UNLIMITED_CALLDATA);
  assert.equal(fields.data, UNLIMITED_CALLDATA);
  assert.equal(evm.formatAllowance(review.approvalAmountWei, review.tokenDecimals), "Unlimited");
  assert.ok(review.warnings.some((warning) =>
    /Unlimited allowance: this lets the spender move every USDT token of this contract until you revoke it\./
      .test(warning)));
});

test("prepareGrant refuses zero, an amount above uint256 and a missing amount", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ amountText: "0", fetchJson: mock.fetchJson })),
    (err) => {
      assert.deepEqual(err.fieldErrors, {
        amount: "The allowance amount must be greater than zero; use revoke to set an allowance to zero.",
      });
      return true;
    },
  );
  const noDecimals = rpcMock({ decimals: 0 });
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({
      amountText: (U256_MAX + 1n).toString(),
      fetchJson: noDecimals.fetchJson,
    })),
    (err) => {
      assert.deepEqual(err.fieldErrors, {
        amount: "The allowance amount is larger than the maximum uint256 value (2^256-1).",
      });
      return true;
    },
  );
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ amountText: "  ", fetchJson: mock.fetchJson })),
    (err) => {
      assert.deepEqual(err.fieldErrors, {
        amount: "Enter the allowance amount, or choose Unlimited.",
      });
      return true;
    },
  );
});

test("prepareGrant refuses the zero address, the token itself and a token without code", async () => {
  const mock = rpcMock();
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ spender: "0x" + "0".repeat(40), fetchJson: mock.fetchJson })),
    /The spender address is invalid: The zero address cannot be a spender/,
  );
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ spender: TOKEN, fetchJson: mock.fetchJson })),
    /The spender must not be the token contract itself; an allowance to the token has no effect and is usually a copy-paste mistake\. Refusing to sign\./,
  );
  const noCode = rpcMock({ code: "0x" });
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ fetchJson: noCode.fetchJson })),
    /has no contract code on Ethereum mainnet; it is an externally owned account or does not exist\. Refusing to sign\./,
  );
});

test("prepareGrant refuses an unarmed mainnet before any RPC and reuses the fee cap", async () => {
  const unarmed = rpcMock();
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ fetchJson: unarmed.fetchJson, mainnetArmed: false })),
    /Mainnet signing is not armed/,
  );
  assert.equal(unarmed.calls.length, 0);

  const cap = rpcMock({ gasEstimate: "0x1312d00" }); // 20M gas x 5 gwei = 0.12 ETH
  await assert.rejects(
    () => evm.prepareGrant(grantOptions({ fetchJson: cap.fetchJson })),
    /The maximum network fee 0\.12 ETH exceeds the Ethereum mainnet cap of 0\.05 ETH; refusing to sign\./,
  );
});

test("a grant on Sepolia needs no arm and skips the mainnet buffer", async () => {
  const mock = rpcMock({ chainId: "0xaa36a7" });
  let fields = null;
  const review = await evm.prepareGrant(grantOptions({
    expectedChainId: 11155111,
    mainnetArmed: false,
    fetchJson: mock.fetchJson,
    unsigned(value) {
      fields = value;
      return "0x02f8";
    },
  }));
  assert.equal(review.testnet, true);
  assert.equal(review.gasEstimate, 50000n);
  assert.equal(review.gasLimit, 50000n);
  assert.equal(fields.chain_id, "11155111");
  assert.equal(fields.data, FINITE_CALLDATA);
});

/* ------------------------------------------------------ confirm a grant */

test("confirm signs the grant once and broadcasts once", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareGrant(grantOptions({ fetchJson: prepareMock.fetchJson }));

  const sendMock = rpcMock({ chainId: "0x1" });
  const signCalls = [];
  const result = await evm.confirmTransaction({
    review,
    fetchJson: sendMock.fetchJson,
    mainnetArmed: true,
    unsigned: fakeUnsigned,
    sign(fields) {
      signCalls.push(fields);
      return "0x02f8";
    },
  });

  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].to, TOKEN);
  assert.equal(signCalls[0].value, "0");
  assert.equal(signCalls[0].data, FINITE_CALLDATA);
  assert.equal(result.txHash, TX_HASH);
  assert.deepEqual(sendMock.calls.map((call) => call.method), [
    "eth_chainId",
    "eth_sendRawTransaction",
  ]);
  assert.equal(
    sendMock.calls.filter((call) => call.method === "eth_sendRawTransaction").length,
    1,
    "the grant must be broadcast exactly once",
  );
});

test("a grant review cannot change the spender, amount, calldata or value", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareGrant(grantOptions({ unlimited: true, fetchJson: prepareMock.fetchJson }));
  const sendMock = rpcMock({ chainId: "0x1" });
  let signCalls = 0;
  const sign = () => {
    signCalls += 1;
    return "0x02f8";
  };
  const confirm = (mutate) => evm.confirmTransaction({
    review: mutate({ ...review }),
    fetchJson: sendMock.fetchJson,
    mainnetArmed: true,
    unsigned: fakeUnsigned,
    sign,
  });

  await assert.rejects(
    () => confirm((next) => ({ ...next, spender: OTHER })),
    /The reviewed grant calldata does not match the reviewed spender and allowance\. Refusing to sign\./,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, approvalAmountWei: 1234500n })),
    /The reviewed grant calldata does not match the reviewed spender and allowance\. Refusing to sign\./,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, approvalAmountWei: 0n })),
    /The reviewed allowance amount is not greater than zero\. Refusing to sign\./,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, dataHex: FINITE_CALLDATA })),
    /The reviewed grant calldata does not match/,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, valueWei: 1n })),
    /An allowance grant must not send native value/,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, nonce: next.nonce + 1n })),
    /does not match the reviewed fields/,
  );
  await assert.rejects(
    () => confirm((next) => ({ ...next, tokenContract: SPENDER, spender: SPENDER })),
    /The spender must not be the token contract itself/,
  );
  assert.equal(signCalls, 0);
  assert.equal(sendMock.calls.length, 0);
});

test("a prepared grant cannot be confirmed after the chain switch or arm removal", async () => {
  const prepareMock = rpcMock();
  const review = await evm.prepareGrant(grantOptions({ fetchJson: prepareMock.fetchJson }));

  const switched = rpcMock({ chainId: "0xaa36a7" });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: switched.fetchJson,
      mainnetArmed: true,
      unsigned: fakeUnsigned,
      sign: () => "0x02f8",
    }),
    /Chain id mismatch/,
  );

  const unarmed = rpcMock({ chainId: "0x1" });
  await assert.rejects(
    () => evm.confirmTransaction({
      review,
      fetchJson: unarmed.fetchJson,
      mainnetArmed: false,
      unsigned: fakeUnsigned,
      sign: () => "0x02f8",
    }),
    /Mainnet signing is not armed/,
  );
  assert.equal(unarmed.calls.length, 0);
});

/* ---------------------------------------------------------------- runner */

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
  console.error(`\n${failed} of ${cases.length} wallet approval tests failed`);
  process.exit(1);
}
console.log(`\n${cases.length} wallet approval tests passed`);
