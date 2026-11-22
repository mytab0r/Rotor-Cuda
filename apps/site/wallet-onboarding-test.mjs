// Static contract for the onboarding entry points: the page must expose a
// seed-phrase choice and a private-key / WIF choice next to each other, both
// as the shared 44px chip, and both must target an existing form. The runtime
// click-through (WIF and hex submissions) is exercised by scripts/ui-audit.mjs
// in a real browser.
//
// Usage: node apps/site/wallet-onboarding-test.mjs

import fs from "node:fs";

const html = fs.readFileSync(new URL("./wallet.html", import.meta.url), "utf8");
const script = fs.readFileSync(new URL("./wallet.js", import.meta.url), "utf8");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function between(start, end) {
  const from = html.indexOf(start);
  const to = html.indexOf(end, from + start.length);
  return from >= 0 && to > from ? html.slice(from, to) : "";
}

const onboarding = between('id="wallet-onboarding"', 'id="wallet-panel"');
assert(onboarding, "the onboarding section exists before the vault panel");

const seedChip = /<button[^>]*class="chip"[^>]*id="wallet-onboard-seed"[^>]*>([^<]*)<\/button>/.exec(onboarding);
const keyChip = /<button[^>]*class="chip"[^>]*id="wallet-onboard-key"[^>]*>([^<]*)<\/button>/.exec(onboarding);
assert(seedChip, "the seed-phrase onboarding chip is a shared .chip button");
assert(keyChip, "the private-key / WIF onboarding chip is a shared .chip button");
assert(/seed phrase/i.test(seedChip[1]), `seed chip copy: ${seedChip[1]}`);
assert(/private key\s*\/\s*WIF/i.test(keyChip[1]), `key chip copy: ${keyChip[1]}`);
assert(
  onboarding.indexOf('id="wallet-onboard-seed"') < onboarding.indexOf('id="wallet-onboard-key"'),
  "the two onboarding entries sit next to each other",
);
assert(/aria-pressed="false"/.test(onboarding), "chips expose aria-pressed state");
assert(/never sent to the server, logged or put in the URL/i.test(onboarding), "the safety copy is shared");

assert(
  /id="wallet-seed-phrase"/.test(html),
  "the seed-phrase target form exists",
);
assert(
  /id="wallet-import-form"/.test(html) && /id="wallet-secret"/.test(html),
  "the private-key / WIF target form exists",
);
assert(
  /WIF or 64-character hex/.test(html),
  "the import form names both WIF and 64-character hex",
);
assert(
  /wallet-import-help[\s\S]*never[^<]*server|wallet-import-help[\s\S]*encrypted/i.test(html) ||
    /encrypted/i.test(between('id="wallet-import-help"', "</p>")),
  "the import help carries the local-encryption safety copy",
);

assert(/function applyOnboardChoice\(/.test(script), "wallet.js applies the onboarding choice");
assert(/onboardSeed\.addEventListener/.test(script), "the seed chip is wired");
assert(/onboardKey\.addEventListener/.test(script), "the key chip is wired");
assert(
  /applyOnboardChoice\(state\.onboardChoice\)/.test(script),
  "the choice is applied after unlock",
);

console.log("wallet-onboarding-test: ok");
