#!/usr/bin/env node
// Tests for the shared Milk Sad seed-range helpers. No DOM, no network.
//
// Usage: node apps/site/milk-sad-scan-test.mjs

import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const scan = require("./milk-sad-scan.js");

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

await test("bxSeed is deterministic and 64 hex characters", () => {
  const first = scan.bxSeed(0);
  assert.match(first, /^[0-9a-f]{64}$/);
  assert.equal(scan.bxSeed(0), first);
  assert.notEqual(scan.bxSeed(1), first);
});

await test("addressProfile maps each supported Bitcoin address form", () => {
  assert.equal(scan.addressProfile("bc1pqqqq").id, "btc_p2tr");
  assert.equal(scan.addressProfile("bc1qxyz").id, "btc_p2wpkh");
  assert.equal(scan.addressProfile("3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy").id, "btc_p2sh_p2wpkh");
  assert.equal(scan.addressProfile("1BoatSLRHtKNngkdXEeobR76b53LETtpyT").id, "btc_p2pkh");
  assert.equal(scan.addressProfile("bc1qxyz").path, "m/84'/0'/0'/0/0");
});

await test("scanRange stops at the first matching seed", async () => {
  const seen = [];
  const result = await scan.scanRange({
    address: "1Target",
    start: 10,
    count: 20,
    derive: async (entropy, profile) => {
      seen.push({ entropy, profile: profile.id });
      // Pretend seed 14 reproduces the address.
      const match = seen.length === 5;
      return { address: match ? "1target" : "1other", mnemonic: "m", wif: "w" };
    },
  });
  assert.equal(result.matched, true);
  assert.equal(result.seed, 14);
  assert.equal(result.checked, 5);
  assert.equal(result.mnemonic, "m");
  assert.equal(result.profile, "btc_p2pkh");
  assert.equal(seen.length, 5);
  assert.match(seen[0].entropy, /^[0-9a-f]{64}$/);
});

await test("scanRange reports a bounded no-match without overrunning 2^32", async () => {
  let calls = 0;
  const result = await scan.scanRange({
    address: "bc1qaddress",
    start: 0xfffffffd,
    count: 2000,
    derive: () => {
      calls += 1;
      return { address: "bc1qother" };
    },
    yieldEvery: 1000,
  });
  assert.equal(result.matched, false);
  // Seeds 0xfffffffd, 0xfffffffe and 0xffffffff only.
  assert.equal(result.checked, 3);
  assert.equal(calls, 3);
  assert.equal(result.profile, "btc_p2wpkh");
});

await test("scanRange yields and reports progress", async () => {
  let progress = 0;
  let yields = 0;
  await scan.scanRange({
    address: "1Boat",
    start: 0,
    count: 25,
    derive: () => ({ address: "1other" }),
    yieldEvery: 10,
    onProgress: () => { progress += 1; },
    yieldTo: async () => { yields += 1; },
  });
  assert.equal(progress, 2);
  assert.equal(yields, 2);
});

await test("scanRange rejects an oversized or invalid range", async () => {
  await assert.rejects(
    () => scan.scanRange({ address: "1a", start: 0, count: 2001, derive: () => null }),
    /1…2000/,
  );
  await assert.rejects(
    () => scan.scanRange({ address: "1a", start: -1, count: 1, derive: () => null }),
    /0…4294967295/,
  );
  await assert.rejects(
    () => scan.scanRange({ address: "", start: 0, count: 1, derive: () => null }),
    /address you control/,
  );
});

if (failed) {
  console.error(`\n${failed} test(s) failed`);
  process.exit(1);
}
console.log("\nall milk-sad-scan tests passed");
