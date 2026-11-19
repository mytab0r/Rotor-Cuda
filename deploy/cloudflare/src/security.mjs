// Detection of secret-shaped material.
//
// The edge cache only ever handles public chain data. If a request body looks
// like a private key, WIF, extended key, seed phrase or keypair/keystore JSON,
// the report endpoint rejects it without echoing it back and without logging
// it. The worker never logs request bodies at all.

const PATTERNS = [
  { kind: "pem_private_key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: "extended_private_key", re: /\b(?:xprv|tprv|yprv|zprv|uprv|vprv)[1-9A-HJ-NP-Za-km-z]{20,}\b/ },
  { kind: "wif", re: /\b[5KLc9][1-9A-HJ-NP-Za-km-z]{50,51}\b/ },
  { kind: "hex_private_key", re: /\b[0-9a-fA-F]{64}\b/ },
  { kind: "keypair_json", re: /"(?:private_?key|secret_?key|mnemonic|seed_?phrase|recovery_?phrase|wif)"\s*:/i },
  { kind: "keystore_json", re: /"kdf"\s*:\s*"scrypt"|"crypto"\s*:\s*\{\s*"cipher"/i },
  // 12+ consecutive lowercase words is the shape of a BIP-39 phrase.
  { kind: "seed_words", re: /\b(?:[a-z]{3,8}\s+){11,23}[a-z]{3,8}\b/ },
  { kind: "seed_phrase_words", re: /\b(?:mnemonic|seed phrase|recovery phrase)\b/i },
];

export function findSensitiveMaterial(text) {
  if (typeof text !== "string" || text.length === 0) return [];
  return PATTERNS.filter(({ re }) => re.test(text)).map(({ kind }) => kind);
}

export function containsSensitiveMaterial(text) {
  return findSensitiveMaterial(text).length > 0;
}
