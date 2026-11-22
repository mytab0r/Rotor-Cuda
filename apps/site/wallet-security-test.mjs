#!/usr/bin/env node
// Tests for the cabinet wallet security-status helpers. No DOM, no network.
//
// Usage: node apps/site/wallet-security-test.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const security = require("./wallet-security.js");

let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    failed += 1;
    console.error(`not ok - ${name}\n  ${err && err.stack ? err.stack : err}`);
  }
}

function advisory(id, overrides = {}) {
  return {
    id,
    kind: "vulnerability",
    title: id,
    severity: "high",
    summary: "s",
    user_impact: "u",
    actions: ["a"],
    sources: [{ label: "l", url: "https://example.test/", primary: true }],
    affected: { tools: ["t"], versions: [], chains: ["bitcoin"] },
    checker: null,
    review: { status: "reviewed", reviewed_by: "r", reviewed_at: "2026-11-22" },
    ...overrides,
  };
}

const catalog = {
  version: 1,
  checkers: [
    {
      id: "local-seed-range",
      kind: "local-seed-range",
      title: "local",
      chains: ["bitcoin"],
      route: "/milk-sad#address-audit",
      limits: { max_seeds_per_run: 2000 },
    },
  ],
  advisories: [
    advisory("milk-sad", { checker: "local-seed-range" }),
    advisory("android"),
    advisory("draft-only", {
      review: { status: "draft" },
    }),
  ],
};

const bitcoin = { id: "entry-btc", chain: "bitcoin", label: "cold" };
const ethereum = { id: "entry-evm", chain: "ethereum", label: "hot" };
const testnet = { id: "entry-tbtc", chain: "bitcoin-testnet", label: "test" };

function memoryStorage() {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    raw: map,
  };
}

await test("a Bitcoin entry selects the checkable advisory and the uncheckable one", () => {
  const selection = security.selectForEntries(catalog, [bitcoin]);
  assert.deepEqual(selection.applicable.map((item) => item.advisory.id), ["milk-sad"]);
  assert.deepEqual(selection.uncheckable.map((item) => item.advisory.id), ["android"]);
});

await test("an Ethereum-only vault has no applicable advisory", () => {
  const selection = security.selectForEntries(catalog, [ethereum]);
  assert.equal(selection.applicable.length, 0);
  assert.equal(selection.uncheckable.length, 0);
});

await test("bitcoin-testnet is not treated as mainnet Bitcoin", () => {
  const selection = security.selectForEntries(catalog, [testnet]);
  assert.equal(selection.applicable.length + selection.uncheckable.length, 0);
});

await test("draft advisories never reach the wallet", () => {
  const selection = security.selectForEntries(catalog, [bitcoin]);
  const ids = selection.applicable.concat(selection.uncheckable).map((item) => item.advisory.id);
  assert.equal(ids.includes("draft-only"), false);
});

await test("check timestamps persist by advisory and entry id, never by address", () => {
  const storage = memoryStorage();
  const iso = "2026-11-22T10:00:00.000Z";
  const times = security.writeCheckTime(storage, "milk-sad", "entry-btc", iso);
  assert.equal(times[security.checkKey("milk-sad", "entry-btc")], iso);
  const raw = storage.raw.get(security.STORAGE_KEY);
  assert.ok(raw.includes("milk-sad"));
  assert.equal(raw.includes("bc1"), false);
  assert.equal(raw.includes("1Boat"), false);
  assert.deepEqual(security.readCheckTimes(storage), times);
});

await test("counts and the latest check use only applicable items", () => {
  const storage = memoryStorage();
  security.writeCheckTime(storage, "milk-sad", "entry-btc", "2026-11-20T00:00:00.000Z");
  security.writeCheckTime(storage, "milk-sad", "entry-btc", "2026-11-22T00:00:00.000Z");
  const selection = security.selectForEntries(catalog, [bitcoin]);
  const times = security.readCheckTimes(storage);
  assert.equal(security.countChecks(times, selection.applicable), 1);
  assert.equal(security.latestCheck(times, selection.applicable), "2026-11-22T00:00:00.000Z");
});

await test("bad or hostile storage fails closed to an empty map", () => {
  const storage = { getItem: () => "{not json", setItem: () => { throw new Error("quota"); } };
  assert.deepEqual(security.readCheckTimes(storage), {});
  assert.doesNotThrow(() => security.writeCheckTime(storage, "a", "b", "2026-11-22"));
});

await test("runCheck passes only the user's address and the checker limit to the scan", async () => {
  const selection = security.selectForEntries(catalog, [bitcoin]);
  const item = selection.applicable[0];
  let seen = null;
  const result = await security.runCheck(item, bitcoin, "bc1quser", {
    start: 0,
    count: 10,
    scanRange: async (options) => {
      seen = options;
      return { matched: false, checked: 10 };
    },
    derive: () => null,
  });
  assert.equal(result.checked, 10);
  assert.equal(seen.address, "bc1quser");
  assert.equal(seen.maxSeeds, 2000);
  assert.equal(seen.start, 0);
  assert.equal(seen.count, 10);
});

await test("runCheck refuses a missing scan function or an unsupported checker", async () => {
  const selection = security.selectForEntries(catalog, [bitcoin]);
  await assert.rejects(
    () => security.runCheck(selection.applicable[0], bitcoin, "bc1quser", {}),
    /scan library/,
  );
  const fake = {
    advisory: advisory("future"),
    checker: { kind: "remote-lookup", limits: { max_seeds_per_run: 1 } },
    entries: [bitcoin],
  };
  await assert.rejects(
    () => security.runCheck(fake, bitcoin, "bc1quser", {}),
    /Unsupported checker/,
  );
});

await test("shortAddress and formatTime stay bounded", () => {
  assert.equal(security.shortAddress("bc1qabcdefghijklmnop"), "bc1qab…mnop");
  assert.equal(security.shortAddress("short"), "short");
  assert.equal(security.formatTime("2026-11-22T10:05:00.000Z"), "2026-11-22 10:05 UTC");
  assert.equal(security.formatTime("not a date"), "—");
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall wallet-security tests passed");
