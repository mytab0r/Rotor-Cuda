# Cabinet wallet design

## Boundaries

- `apps/site/wallet-*` owns UI and browser crypto orchestration.
- `crates/rotor-wasm` owns curve signing and transaction hashing; no network.
- Coordinator owns HTTP routes and static assets only. It must not accept or
  persist secrets.
- Public providers are called from the browser. The honest `Origin` is sent;
  we do not spoof it.

## Vault

IndexedDB database `rotor-wallet`, store `vault`, one record per browser:

```json
{
  "version": 1,
  "kdf": { "name": "PBKDF2-SHA256", "iterations": 600000, "salt": "base64" },
  "cipher": { "name": "AES-GCM", "iv": "base64" },
  "ciphertext": "base64",
  "updated_at": "ISO-8601"
}
```

Plaintext is `{ entries: [{ id, chain, label, secret_type: "wif"|"hex", secret }] }`.
Secret handling:

- derive the AES key from the passphrase with PBKDF2-SHA256;
- encrypt/decrypt with AES-GCM-256, random 12-byte IV per save;
- never write the passphrase or plaintext to storage; keep it only while unlocked;
- auto-lock on idle (default 10 minutes), `pagehide`, explicit Lock;
- export/import only the encrypted blob, never a decrypted JSON.

Address derivation reuses the WASM `derive_report` path and the site's chain
registry, so a WIF is validated and mapped to its network before it is stored.

## Transactions

Shared flow:

1. Build an unsigned transaction from the vault entry and provider data.
2. Decode it into a human-readable review (inputs, outputs, fee, change,
   nonce/chain id, raw hex).
3. Sign locally in WASM.
4. Broadcast the signed raw transaction directly to the selected provider.
5. Show the provider response and an explorer link.

EVM: EIP-1559 type-2, chain id from the selected network, nonce and fees from
`eth_getTransactionCount` / `eth_feeHistory` or `eth_gasPrice`; sign
keccak(RLP(unsigned)); broadcast via `eth_sendRawTransaction`.

Bitcoin: P2WPKH first, P2PKH later; UTXOs from mempool.space; BIP143 sighash;
low-R level DER; broadcast via `POST /api/tx`. Testnet is the default network in
this phase.

No signing or broadcast on mainnet until the testnet review is verified.

## Providers and CORS

Preferred direct endpoints (documented in the UI):

- EVM: a public JSON-RPC endpoint with CORS for the selected chain.
- Bitcoin: mempool.space API (CORS enabled).
- Solana/TON: their public RPC endpoints with CORS.

If a provider does not allow CORS, the UI offers an explicit fallback through
`/api/v1/wallet/broadcast` on our origin. That proxy forwards only a signed raw
transaction, enforces a size limit and a per-IP rate limit, and never stores the
payload. We do not fake `Origin` or `Referer`; the browser does not allow it and
it violates provider terms.

## Threat model

- XSS: all user labels rendered with `textContent`; no `innerHTML` for vault data.
- Malicious provider: the review screen shows the exact destination and raw
  bytes before signing; provider responses are untrusted strings.
- Wrong network: chain id and testnet flag are explicit; a mismatch blocks send.
- Clipboard: copied secrets are cleared from the UI on lock; the wallet warns
  that clipboard managers may retain values.
- Lost passphrase: no recovery; the UI requires an encrypted backup.
