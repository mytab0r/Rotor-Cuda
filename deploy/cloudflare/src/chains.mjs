// Chain metadata and public-address validation.
//
// Only public chain data is allowed to cross this module: chain id, public
// address, balance, unit. Anything key-shaped is rejected elsewhere.

const EVM_CHAIN_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const BTC_LEGACY_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/;
const BTC_BECH32_RE = /^bc1[02-9ac-hj-np-z]{11,71}$/;
const TRON_ADDRESS_RE = /^T[1-9A-HJ-NP-Za-km-z]{33}$/;

export function isKnownChain(chain) {
  if (typeof chain !== "string" || chain.length === 0) return false;
  if (chain === "btc" || chain === "tron") return true;
  return EVM_CHAIN_RE.test(chain);
}

export function chainFamily(chain) {
  if (chain === "btc") return "btc";
  if (chain === "tron") return "tron";
  return isKnownChain(chain) ? "evm" : null;
}

export function isValidAddress(chain, address) {
  if (typeof address !== "string") return false;
  const family = chainFamily(chain);
  if (family === "btc") {
    if (BTC_LEGACY_RE.test(address)) return true;
    return BTC_BECH32_RE.test(address.toLowerCase());
  }
  if (family === "tron") return TRON_ADDRESS_RE.test(address);
  if (family === "evm") return EVM_ADDRESS_RE.test(address);
  return false;
}

// Normalize only where the chain rules allow it. Base58 is case-sensitive, so
// only bech32 and EVM addresses are lowercased.
export function normalizeAddress(chain, address) {
  const family = chainFamily(chain);
  if (family === "evm") return address.toLowerCase();
  if (family === "btc" && address.toLowerCase().startsWith("bc1")) return address.toLowerCase();
  return address;
}

export function unitFor(chain) {
  if (chain === "btc") return "sats";
  if (chain === "tron") return "sun";
  return "wei";
}

// JSON has no BigInt. Keep exactness: emit a number while it fits in a JS
// safe integer, otherwise emit a base-10 string that callers parse with
// BigInt. EVM wei routinely exceeds 2^53.
export function formatBalance(value) {
  const big = typeof value === "bigint" ? value : BigInt(value);
  if (big < 0n) throw new RangeError("balance must not be negative");
  return big <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(big) : big.toString();
}
