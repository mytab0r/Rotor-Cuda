// Validation of client-supplied balance hints.
//
// A hint is never truth: it must pass address/value/timestamp checks, it is
// stored with a shorter TTL than provider data, and it is always marked
// source: "client". The report endpoint additionally scans the raw body for
// secret-shaped material before this module sees it.

import { formatBalance, isKnownChain, isValidAddress, normalizeAddress, unitFor } from "./chains.mjs";
import { findSensitiveMaterial } from "./security.mjs";

export const HINT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
export const HINT_MAX_FUTURE_MS = 2 * 60 * 1000;

const MAX_U256 = (1n << 256n) - 1n;
const ALLOWED_FIELDS = new Set(["chain", "address", "value", "fetchedAt"]);

export function parseBalanceValue(raw) {
  let big;
  if (typeof raw === "number") {
    if (!Number.isFinite(raw) || !Number.isInteger(raw)) return null;
    big = BigInt(raw);
  } else if (typeof raw === "string" && /^(?:0|[1-9][0-9]*)$/.test(raw)) {
    big = BigInt(raw);
  } else {
    return null;
  }
  if (big < 0n || big > MAX_U256) return null;
  return formatBalance(big);
}

export function parseFetchedAt(raw) {
  if (typeof raw === "number") {
    return Number.isFinite(raw) && Number.isInteger(raw) ? raw : null;
  }
  if (typeof raw === "string") {
    if (/^[0-9]{1,16}$/.test(raw)) return Number(raw);
    const parsed = Date.parse(raw);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function validateHint(body, now = Date.now()) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, reasons: ["bad_body"] };
  }

  const reasons = [];
  if (findSensitiveMaterial(JSON.stringify(body) ?? "").length > 0) {
    reasons.push("sensitive_material");
  }
  for (const key of Object.keys(body)) {
    if (!ALLOWED_FIELDS.has(key)) reasons.push("unknown_field");
  }

  const chain = typeof body.chain === "string" ? body.chain.trim().toLowerCase() : "";
  const chainOk = isKnownChain(chain);
  if (!chainOk) reasons.push("bad_chain");

  const address = typeof body.address === "string" ? body.address.trim() : "";
  if (chainOk && !isValidAddress(chain, address)) reasons.push("bad_address");

  const value = parseBalanceValue(body.value);
  if (value === null) reasons.push("bad_value");

  const fetchedAt = parseFetchedAt(body.fetchedAt);
  if (fetchedAt === null) reasons.push("bad_timestamp");
  else if (fetchedAt > now + HINT_MAX_FUTURE_MS) reasons.push("future_timestamp");
  else if (fetchedAt < now - HINT_MAX_AGE_MS) reasons.push("ancient_timestamp");

  if (reasons.length > 0) {
    return { ok: false, reasons: [...new Set(reasons)] };
  }

  return {
    ok: true,
    hint: {
      chain,
      address: normalizeAddress(chain, address),
      value,
      unit: unitFor(chain),
      fetchedAt,
      source: "client",
    },
  };
}
