/* TRON Nile testnet TRX transfer core (pure browser/Node codec, no DOM).
 *
 * Foundation module only: it is NOT wired into /send yet. It owns the parts
 * that can be tested without a browser:
 *  - base58check validation of TRON addresses (21 bytes, 0x41 prefix);
 *  - exact sun <-> TRX conversion with BigInt (no float);
 *  - request normalization and the local WASM calls
 *    (`tron_unsigned_tx` / `tron_sign_tx`) that build and sign the protobuf
 *    TransferContract;
 *  - the Nile block-reference helper and the broadcast helper.
 *
 * Testnet only: every network call is hard-pinned to the canonical Nile
 * origin and path. Any other host or path is rejected with an explicit
 * "testnet only" error. The private key is never logged, stored, or put in a
 * URL or request body; only the signed transaction (txID, raw_data,
 * raw_data_hex, signature) is sent to the broadcaster.
 *
 * The wire format and validation live in crates/rotor-wasm/src/tron.rs. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorTronSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* The canonical Nile endpoint comes from data/providers.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  var NILE_BASE = SSOT_PROVIDERS.find('tron-nile', 'nileex').url;
  var NILE_HOST = NILE_BASE.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  var ENDPOINTS = {
    nowBlock: NILE_BASE + '/wallet/getnowblock',
    broadcast: NILE_BASE + '/wallet/broadcasttransaction'
  };

  var SUNDECIMALS = 6;
  var SUN_PER_TRX = 1000000n;
  var MAX_AMOUNT = 9223372036854775807n; // int64 max, 2^63 - 1 sun
  var MAX_JSON_SAFE = 9007199254740992n; // 2^53, largest exact JS integer
  var MAX_FEE_LIMIT = 100000000n; // 100 TRX
  var DEFAULT_EXPIRATION_MS = 60000n; // 60 s from the block timestamp
  var ADDRESS_PREFIX = 0x41;

  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var TRON_FIELDS = [
    'owner_address',
    'to_address',
    'amount',
    'ref_block_bytes',
    'ref_block_hash',
    'expiration',
    'timestamp',
    'fee_limit'
  ];

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* ------------------------------------------------------------- base58 */

  function decodeBase58(text) {
    var value = 0n;
    for (var i = 0; i < text.length; i += 1) {
      var digit = BASE58.indexOf(text.charAt(i));
      if (digit < 0) {
        throw new Error('invalid base58 character "' + text.charAt(i) + '"');
      }
      value = value * 58n + BigInt(digit);
    }
    var bytes = [];
    while (value > 0n) {
      bytes.unshift(Number(value & 0xffn));
      value >>= 8n;
    }
    var zeros = 0;
    while (zeros < text.length && text.charAt(zeros) === '1') zeros += 1;
    return Uint8Array.from(new Array(zeros).fill(0).concat(bytes));
  }

  /* --------------------------------------------------------------- sha256 */

  /* Minimal SHA-256. Address checksums are the only use; a dependency or an
   * async WebCrypto call would make validation awkward inside a sync getter. */
  var SHA256_K = [
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
    0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
    0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
    0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
    0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
    0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
    0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
    0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
    0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ];

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256(bytes) {
    var length = bytes.length;
    var total = Math.ceil((length + 9) / 64) * 64;
    var message = new Uint8Array(total);
    message.set(bytes);
    message[length] = 0x80;
    var bitLength = length * 8;
    var high = Math.floor(bitLength / 0x100000000);
    var low = bitLength % 0x100000000;
    message[total - 8] = (high >>> 24) & 0xff;
    message[total - 7] = (high >>> 16) & 0xff;
    message[total - 6] = (high >>> 8) & 0xff;
    message[total - 5] = high & 0xff;
    message[total - 4] = (low >>> 24) & 0xff;
    message[total - 3] = (low >>> 16) & 0xff;
    message[total - 2] = (low >>> 8) & 0xff;
    message[total - 1] = low & 0xff;

    var h = [
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ];
    var w = new Uint32Array(64);

    for (var offset = 0; offset < total; offset += 64) {
      for (var i = 0; i < 16; i += 1) {
        var at = offset + i * 4;
        w[i] = ((message[at] << 24) | (message[at + 1] << 16) |
          (message[at + 2] << 8) | message[at + 3]) >>> 0;
      }
      for (var j = 16; j < 64; j += 1) {
        var s0 = rotr(w[j - 15], 7) ^ rotr(w[j - 15], 18) ^ (w[j - 15] >>> 3);
        var s1 = rotr(w[j - 2], 17) ^ rotr(w[j - 2], 19) ^ (w[j - 2] >>> 10);
        w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
      }

      var a = h[0], b = h[1], c = h[2], d = h[3];
      var e = h[4], f = h[5], g = h[6], k = h[7];
      for (var r = 0; r < 64; r += 1) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (k + S1 + ch + SHA256_K[r] + w[r]) >>> 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) >>> 0;
        k = g;
        g = f;
        f = e;
        e = (d + t1) >>> 0;
        d = c;
        c = b;
        b = a;
        a = (t1 + t2) >>> 0;
      }
      h[0] = (h[0] + a) >>> 0;
      h[1] = (h[1] + b) >>> 0;
      h[2] = (h[2] + c) >>> 0;
      h[3] = (h[3] + d) >>> 0;
      h[4] = (h[4] + e) >>> 0;
      h[5] = (h[5] + f) >>> 0;
      h[6] = (h[6] + g) >>> 0;
      h[7] = (h[7] + k) >>> 0;
    }

    var out = new Uint8Array(32);
    for (var n = 0; n < 8; n += 1) {
      out[n * 4] = (h[n] >>> 24) & 0xff;
      out[n * 4 + 1] = (h[n] >>> 16) & 0xff;
      out[n * 4 + 2] = (h[n] >>> 8) & 0xff;
      out[n * 4 + 3] = h[n] & 0xff;
    }
    return out;
  }

  function sha256d(bytes) {
    return sha256(sha256(bytes));
  }

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 1) {
      out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    }
    return out;
  }

  /* ------------------------------------------------------------- address */

  /* Decode a TRON base58check address. Returns the 21-byte payload (0x41
   * prefix plus the 20-byte account) or throws. Shared testnet/mainnet
   * addresses use the same 0x41 prefix; this module still only broadcasts on
   * Nile, so a mainnet address is a valid destination but not a valid host. */
  function decodeAddress(address, label) {
    var name = label || 'address';
    if (typeof address !== 'string' || !address) {
      throw new Error(name + ' must be a TRON base58 address (T...).');
    }
    var text = address.trim();
    if (/^0x/i.test(text)) {
      throw new Error(name + ' must be a TRON base58 address (T...), not a 0x hex address.');
    }
    var raw;
    try {
      raw = decodeBase58(text);
    } catch (err) {
      throw new Error(name + ' is not a valid base58 address: ' + errorText(err));
    }
    if (raw.length !== 25) {
      throw new Error(name + ' is not a TRON address: expected 21 payload bytes plus a 4-byte checksum.');
    }
    var payload = raw.subarray(0, 21);
    if (payload[0] !== ADDRESS_PREFIX) {
      throw new Error(name + ' is not a TRON address: the payload prefix is 0x' +
        payload[0].toString(16) + ', not 0x41.');
    }
    var checksum = sha256d(payload).subarray(0, 4);
    if (toHex(checksum) !== toHex(raw.subarray(21))) {
      throw new Error(name + ' has an invalid base58check checksum.');
    }
    return {
      address: text,
      payloadHex: toHex(payload),
      accountHex: toHex(payload.subarray(1))
    };
  }

  function assertAddress(address, label) {
    return decodeAddress(address, label).address;
  }

  /* -------------------------------------------------------------- amounts */

  function toBigInt(value, field) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new Error(field + ' must be an exact integer (use a decimal string).');
      }
      return BigInt(value);
    }
    if (typeof value === 'string' && /^\d+$/.test(value.trim())) {
      return BigInt(value.trim());
    }
    throw new Error(field + ' must be a non-negative decimal string.');
  }

  function sunToTron(sun) {
    var value = toBigInt(sun, 'sun amount');
    if (value < 0n) throw new Error('sun amount must not be negative.');
    return AMOUNT.formatUnits(value, SUNDECIMALS);
  }

  function tronToSun(text) {
    if (typeof text !== 'string') {
      throw new Error('TRX amount must be a decimal string.');
    }
    try {
      return AMOUNT.parseUnits(text, SUNDECIMALS);
    } catch (err) {
      throw new Error('TRX amount must be a plain positive decimal with at most 6 decimals.');
    }
  }

  function amountSun(value) {
    var sun = toBigInt(value, 'amount');
    if (sun <= 0n) throw new Error('amount must be greater than zero sun.');
    if (sun > MAX_AMOUNT) throw new Error('amount exceeds the int64 maximum (2^63 - 1 sun).');
    return sun;
  }

  function timestampField(value, field) {
    var parsed = toBigInt(value, field);
    if (parsed <= 0n) throw new Error(field + ' must be greater than zero milliseconds.');
    if (parsed > MAX_JSON_SAFE) {
      throw new Error(field + ' exceeds 2^53 milliseconds and is not JSON-safe.');
    }
    return parsed.toString();
  }

  function hexField(value, field, length) {
    if (typeof value !== 'string' || value.length !== length || !/^[0-9a-fA-F]+$/.test(value)) {
      throw new Error(field + ' must be exactly ' + length + ' hex characters.');
    }
    return value.toLowerCase();
  }

  function normalizeKey(value) {
    if (typeof value !== 'string' || !/^(?:0x)?[0-9a-fA-F]{64}$/.test(value.trim())) {
      throw new Error('private_key must be a 32-byte hex key (64 hex characters).');
    }
    return '0x' + value.trim().replace(/^0x/i, '').toLowerCase();
  }

  /* Validate and normalize a request into the exact flat JSON schema the WASM
   * core accepts (all values strings). Unknown fields are rejected here as
   * well, so a typo never reaches the signer. */
  function normalizeRequest(request, withKey) {
    if (!request || typeof request !== 'object' || Array.isArray(request)) {
      throw new Error('request must be an object.');
    }
    var names = TRON_FIELDS.slice();
    if (withKey) names.push('private_key');
    Object.keys(request).forEach(function (key) {
      if (names.indexOf(key) < 0) {
        if (key === 'private_key') {
          throw new Error('private_key is not accepted by the unsigned review request.');
        }
        throw new Error('unknown request field: "' + key + '"');
      }
    });

    var fields = {
      owner_address: assertAddress(request.owner_address, 'owner_address'),
      to_address: assertAddress(request.to_address, 'to_address'),
      amount: amountSun(request.amount).toString(),
      ref_block_bytes: hexField(request.ref_block_bytes, 'ref_block_bytes', 4),
      ref_block_hash: hexField(request.ref_block_hash, 'ref_block_hash', 16),
      expiration: timestampField(request.expiration, 'expiration'),
      timestamp: timestampField(request.timestamp, 'timestamp'),
      fee_limit: '0'
    };
    if (request.fee_limit !== undefined && request.fee_limit !== null) {
      var fee = toBigInt(request.fee_limit, 'fee_limit');
      if (fee < 0n) throw new Error('fee_limit must not be negative.');
      if (fee > MAX_FEE_LIMIT) {
        throw new Error('fee_limit exceeds 100 TRX (100000000 sun).');
      }
      fields.fee_limit = fee.toString();
    }
    if (withKey) fields.private_key = normalizeKey(request.private_key);
    return fields;
  }

  /* --------------------------------------------------------------- wasm */

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return new TextDecoder('utf-8').decode(
      new Uint8Array(wasm.memory.buffer, pointer, length)
    );
  }

  /* Call a wasm string entry point and erase both the request buffer and the
   * JS copy afterwards. The result is wiped with clear_result on every path. */
  function callWasmString(wasm, name, request) {
    if (!wasm || typeof wasm[name] !== 'function') {
      throw new Error('The local core has no "' + name + '" export.');
    }
    var bytes = new TextEncoder().encode(request);
    var pointer = wasm.alloc(bytes.length) >>> 0;
    if (!pointer) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
      var status = wasm[name](pointer, bytes.length) >>> 0;
      if (status !== 0) {
        var detail = wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('The local core rejected the transaction' +
          (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      return wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
    } finally {
      new Uint8Array(wasm.memory.buffer, pointer, bytes.length).fill(0);
      bytes.fill(0);
      wasm.dealloc(pointer, bytes.length);
      if (typeof wasm.clear_result === 'function') wasm.clear_result();
    }
  }

  function parseResult(text) {
    var value;
    try {
      value = JSON.parse(text);
    } catch (err) {
      throw new Error('The local core returned invalid JSON.');
    }
    if (!value || typeof value !== 'object' || typeof value.txID !== 'string') {
      throw new Error('The local core returned an unexpected transaction.');
    }
    return value;
  }

  /* Build the unsigned TRX transfer for review. `wasm` is the instantiated
   * rotor_wasm module; the request must not contain a private key. */
  function unsignedTransfer(wasm, request) {
    var fields = normalizeRequest(request, false);
    return parseResult(
      callWasmString(wasm, 'tron_unsigned_tx', JSON.stringify(fields))
    );
  }

  /* Sign the TRX transfer. The private key goes to the WASM core in the
   * request buffer only; it is not part of the returned object and is wiped
   * from the buffer before this function returns. */
  function signTransfer(wasm, request) {
    var fields = normalizeRequest(request, true);
    var text = JSON.stringify(fields);
    try {
      return parseResult(callWasmString(wasm, 'tron_sign_tx', text));
    } finally {
      fields.private_key = null;
      fields = null;
      text = null;
    }
  }

  /* ---------------------------------------------------------- http gates */

  /* The only accepted origin/path for every TRON call. Anything else is a
   * hard error, not a fallback: a wrong host can be a mainnet node. */
  function assertNileUrl(url, path) {
    if (typeof url !== 'string' || !url) {
      throw new Error('TRON testnet only: a Nile endpoint URL is required.');
    }
    var parsed;
    try {
      parsed = new URL(url);
    } catch (err) {
      throw new Error('TRON testnet only: refusing a malformed URL.');
    }
    if (parsed.protocol !== 'https:') {
      throw new Error('TRON testnet only: refusing ' + parsed.protocol + '; https is required.');
    }
    if (parsed.username || parsed.password) {
      throw new Error('TRON testnet only: refusing a URL with credentials.');
    }
    if (parsed.hostname !== NILE_HOST) {
      throw new Error('TRON testnet only: refusing host "' + parsed.hostname +
        '"; only ' + NILE_HOST + ' is allowed.');
    }
    if (parsed.pathname !== path) {
      throw new Error('TRON testnet only: refusing path "' + parsed.pathname +
        '"; only ' + path + ' is allowed.');
    }
    if (parsed.search || parsed.hash) {
      throw new Error('TRON testnet only: refusing query strings or fragments.');
    }
    return NILE_BASE + path;
  }

  function defaultFetchJson(url, options) {
    if (typeof fetch !== 'function') {
      throw new Error('fetch is unavailable in this environment.');
    }
    return fetch(url, options).then(function (response) {
      return response.text().then(function (text) {
        var value;
        try {
          value = JSON.parse(text);
        } catch (err) {
          throw new Error('The Nile endpoint returned non-JSON (HTTP ' + response.status + ').');
        }
        if (!response.ok) {
          throw new Error('The Nile endpoint returned HTTP ' + response.status + '.');
        }
        return value;
      });
    });
  }

  function getJson(url, fetchJson) {
    var provider = typeof fetchJson === 'function' ? fetchJson : defaultFetchJson;
    return Promise.resolve(provider(url, {
      method: 'GET',
      headers: { Accept: 'application/json' }
    }));
  }

  function postJson(url, body, fetchJson) {
    var provider = typeof fetchJson === 'function' ? fetchJson : defaultFetchJson;
    return Promise.resolve(provider(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body)
    }));
  }

  /* GET the latest Nile block and derive the TAPOS reference fields:
   * ref_block_bytes = blockID bytes 6-7, ref_block_hash = bytes 8-15.
   * Returns decimal strings plus a 60-second expiration default. */
  function latestBlock(options) {
    var settings = options || {};
    var url = assertNileUrl(ENDPOINTS.nowBlock, '/wallet/getnowblock');
    return getJson(url, settings.fetchJson).then(function (block) {
      var blockId = block && block.blockID;
      if (typeof blockId !== 'string' || !/^[0-9a-fA-F]{64}$/.test(blockId)) {
        throw new Error('The Nile getnowblock response has no 64-hex blockID.');
      }
      var id = blockId.toLowerCase();
      var header = block.block_header && block.block_header.raw_data;
      var timestamp = header && header.timestamp;
      if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp <= 0) {
        throw new Error('The Nile getnowblock response has no safe timestamp.');
      }
      var number = header && header.number;
      return {
        blockID: id,
        blockNumber: typeof number === 'number' && Number.isSafeInteger(number)
          ? String(number)
          : '',
        ref_block_bytes: id.slice(12, 16),
        ref_block_hash: id.slice(16, 32),
        timestamp: String(timestamp),
        expiration: String(BigInt(timestamp) + DEFAULT_EXPIRATION_MS)
      };
    });
  }

  function bareHex(value, field, length) {
    if (typeof value !== 'string' || !value || !/^[0-9a-fA-F]+$/.test(value) ||
        (length && value.length !== length)) {
      throw new Error('signed transaction ' + field + ' is invalid.');
    }
    return value.toLowerCase();
  }

  /* POST the signed transaction to the Nile broadcaster. The body is built
   * from an explicit allowlist of signed fields, so nothing else in the
   * caller's object (a stray key, a WIF, an address book entry) can leak. */
  function broadcast(signed, options) {
    var settings = options || {};
    if (!signed || typeof signed !== 'object' || Array.isArray(signed)) {
      throw new Error('broadcast requires the signed transaction object.');
    }
    var rawData = signed.raw_data;
    if (!rawData || typeof rawData !== 'object' || Array.isArray(rawData)) {
      throw new Error('signed transaction raw_data is missing.');
    }
    var body = {
      txID: bareHex(signed.txID, 'txID', 64),
      raw_data: rawData,
      raw_data_hex: bareHex(signed.raw_data_hex, 'raw_data_hex', 0),
      signature: [bareHex(signed.signature, 'signature', 130)]
    };
    var url = assertNileUrl(ENDPOINTS.broadcast, '/wallet/broadcasttransaction');
    return postJson(url, body, settings.fetchJson).then(function (response) {
      if (!response || response.result !== true) {
        var code = response && response.code ? ' (' + response.code + ')' : '';
        throw new Error('Nile rejected the transaction' + code + '.');
      }
      return {
        txID: body.txID,
        result: true,
        response: response
      };
    });
  }

  return {
    NILE_BASE: NILE_BASE,
    NILE_HOST: NILE_HOST,
    ENDPOINTS: ENDPOINTS,
    SUN_PER_TRX: SUN_PER_TRX,
    MAX_AMOUNT: MAX_AMOUNT,
    MAX_FEE_LIMIT: MAX_FEE_LIMIT,
    DEFAULT_EXPIRATION_MS: DEFAULT_EXPIRATION_MS,
    decodeBase58: decodeBase58,
    sha256: sha256,
    decodeAddress: decodeAddress,
    assertAddress: assertAddress,
    sunToTron: sunToTron,
    tronToSun: tronToSun,
    normalizeRequest: normalizeRequest,
    callWasmString: callWasmString,
    unsignedTransfer: unsignedTransfer,
    signTransfer: signTransfer,
    assertNileUrl: assertNileUrl,
    latestBlock: latestBlock,
    broadcast: broadcast
  };
});
