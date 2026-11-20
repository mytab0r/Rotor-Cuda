/* Pure address encoders for the key page: Bitcoin Cash CashAddr and
 * Base58Check variants. No DOM, no network, no storage.
 *
 * The encoders take the hash160 that the WASM derivation report already
 * produced; this module never recomputes SHA-256/RIPEMD-160 over a public key.
 * It does hash the checksum bytes, which is part of Base58Check. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorKeyTypes = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var CASHADDR_PREFIX = 'bitcoincash';
  var CASHADDR_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var CASHADDR_MODS = [
    0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n
  ];
  var BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  /* --------------------------------------------------------------- sha256 */

  var SHA256_K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function rotr(value, bits) {
    return (value >>> bits) | (value << (32 - bits));
  }

  function sha256(bytes) {
    var initial = new Uint32Array([
      0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
      0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19
    ]);
    var length = bytes.length;
    var bitLength = length * 8;
    var paddedLength = ((length + 9 + 63) >> 6) << 6;
    var padded = new Uint8Array(paddedLength);
    padded.set(bytes, 0);
    padded[length] = 0x80;
    var view = new DataView(padded.buffer);
    view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
    view.setUint32(paddedLength - 4, bitLength >>> 0);

    var w = new Uint32Array(64);
    for (var offset = 0; offset < paddedLength; offset += 64) {
      for (var i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
      for (i = 16; i < 64; i += 1) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
      }
      var a = initial[0], b = initial[1], c = initial[2], d = initial[3];
      var e = initial[4], f = initial[5], g = initial[6], h = initial[7];
      for (i = 0; i < 64; i += 1) {
        var bigS1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var temp1 = (h + bigS1 + ch + SHA256_K[i] + w[i]) >>> 0;
        var bigS0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var temp2 = (bigS0 + maj) >>> 0;
        h = g; g = f; f = e; e = (d + temp1) >>> 0;
        d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
      }
      initial[0] = (initial[0] + a) >>> 0;
      initial[1] = (initial[1] + b) >>> 0;
      initial[2] = (initial[2] + c) >>> 0;
      initial[3] = (initial[3] + d) >>> 0;
      initial[4] = (initial[4] + e) >>> 0;
      initial[5] = (initial[5] + f) >>> 0;
      initial[6] = (initial[6] + g) >>> 0;
      initial[7] = (initial[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    var outView = new DataView(out.buffer);
    for (i = 0; i < 8; i += 1) outView.setUint32(i * 4, initial[i]);
    return out;
  }

  function sha256d(bytes) {
    return sha256(sha256(bytes));
  }

  /* ----------------------------------------------------------- validation */

  /* Accept a Uint8Array, a byte array or a hex string. `size === null` means
   * 1..2 bytes (a Base58Check version prefix). */
  function bytesOf(value, name, size) {
    var bytes;
    if (typeof value === 'string') {
      if (!/^[0-9a-fA-F]*$/.test(value) || value.length % 2 !== 0) {
        throw new Error(name + ' must be a hex string with an even number of digits.');
      }
      bytes = new Uint8Array(value.length / 2);
      for (var h = 0; h < bytes.length; h += 1) {
        bytes[h] = parseInt(value.slice(h * 2, h * 2 + 2), 16);
      }
    } else if (value instanceof Uint8Array) {
      bytes = value;
    } else if (Array.isArray(value)) {
      bytes = new Uint8Array(value.length);
      for (var i = 0; i < value.length; i += 1) {
        var byte = value[i];
        if (!Number.isInteger(byte) || byte < 0 || byte > 255) {
          throw new Error(name + ' must contain only byte values 0-255.');
        }
        bytes[i] = byte;
      }
    } else {
      throw new Error(name + ' must be a byte array or a hex string.');
    }
    if (size === null ? (bytes.length < 1 || bytes.length > 2) : bytes.length !== size) {
      throw new Error(name + ' must be ' + (size === null ? '1-2' : String(size)) + ' byte(s), got ' + bytes.length + '.');
    }
    return bytes;
  }

  /* ------------------------------------------------------------- cashaddr */

  /* 8-bit bytes -> 5-bit groups, padded on the right like the spec says. */
  function to5Bit(bytes) {
    var out = [];
    var buffer = 0;
    var bits = 0;
    for (var i = 0; i < bytes.length; i += 1) {
      buffer = (buffer << 8) | bytes[i];
      bits += 8;
      while (bits >= 5) {
        bits -= 5;
        out.push((buffer >> bits) & 31);
      }
      buffer &= (1 << bits) - 1;
    }
    if (bits > 0) out.push((buffer << (5 - bits)) & 31);
    return out;
  }

  function cashaddrPolymod(values) {
    var c = 1n;
    for (var i = 0; i < values.length; i += 1) {
      var c0 = c >> 35n;
      c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(values[i]);
      for (var bit = 0; bit < 5; bit += 1) {
        if ((c0 >> BigInt(bit)) & 1n) c ^= CASHADDR_MODS[bit];
      }
    }
    return c ^ 1n;
  }

  /* CashAddr for a 20-byte hash. `type` is the 4-bit address type
   * (0 P2PKH, 1 P2SH); the 3-bit size field is 0 for a 160-bit hash. */
  function cashaddr(hash20, type) {
    var hash = bytesOf(hash20, 'hash160', 20);
    if (!Number.isInteger(type) || type < 0 || type > 15) {
      throw new Error('CashAddr type must be an integer 0-15.');
    }
    var version = type << 3;
    var payload = new Uint8Array(hash.length + 1);
    payload[0] = version;
    payload.set(hash, 1);
    var fiveBit = to5Bit(payload);

    var checksumInput = [];
    for (var i = 0; i < CASHADDR_PREFIX.length; i += 1) {
      checksumInput.push(CASHADDR_PREFIX.charCodeAt(i) & 31);
    }
    checksumInput.push(0);
    for (i = 0; i < fiveBit.length; i += 1) checksumInput.push(fiveBit[i]);
    for (i = 0; i < 8; i += 1) checksumInput.push(0);

    var mod = cashaddrPolymod(checksumInput);
    var chars = '';
    for (i = 0; i < fiveBit.length; i += 1) chars += CASHADDR_CHARSET.charAt(fiveBit[i]);
    for (i = 0; i < 8; i += 1) {
      chars += CASHADDR_CHARSET.charAt(Number((mod >> BigInt((7 - i) * 5)) & 31n));
    }
    return CASHADDR_PREFIX + ':' + chars;
  }

  /* ----------------------------------------------------------- base58check */

  function base58(bytes) {
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    var digits = [];
    for (var i = zeros; i < bytes.length; i += 1) {
      var carry = bytes[i];
      for (var j = 0; j < digits.length; j += 1) {
        var value = digits[j] * 256 + carry;
        digits[j] = value % 58;
        carry = Math.floor(value / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    var out = '';
    for (i = 0; i < zeros; i += 1) out += '1';
    for (i = digits.length - 1; i >= 0; i -= 1) out += BASE58_ALPHABET.charAt(digits[i]);
    return out;
  }

  /* prefixBytes || payload20 || first 4 bytes of SHA-256(SHA-256(...)). */
  function base58check(prefixBytes, payload20) {
    var prefix = bytesOf(prefixBytes, 'version prefix', null);
    var payload = bytesOf(payload20, 'payload', 20);
    var body = new Uint8Array(prefix.length + payload.length);
    body.set(prefix, 0);
    body.set(payload, prefix.length);
    var checksum = sha256d(body).subarray(0, 4);
    var data = new Uint8Array(body.length + 4);
    data.set(body, 0);
    data.set(checksum, body.length);
    return base58(data);
  }

  /* --------------------------------------------------------------- derive */

  function findRow(report, id) {
    if (!report || !Array.isArray(report.addresses)) return null;
    for (var i = 0; i < report.addresses.length; i += 1) {
      var row = report.addresses[i];
      if (row && row.id === id) return row;
    }
    return null;
  }

  function stepString(row, key) {
    return row && row.steps && typeof row.steps[key] === 'string' ? row.steps[key] : '';
  }

  function hash160Of(row) {
    var hex = stepString(row, 'hash160');
    if (!/^[0-9a-fA-F]{40}$/.test(hex)) return null;
    var bytes = new Uint8Array(20);
    for (var i = 0; i < 20; i += 1) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return bytes;
  }

  /* Derive the three extra rows from a WASM report. Unavailable inputs yield
   * null, so the caller can append only what the report can support. */
  function derive(report) {
    var out = {
      bch_cashaddr: null,
      doge_p2pkh_uncompressed: null,
      zcash_p2pkh_uncompressed: null
    };
    if (!report || report.curve !== 'secp256k1') return out;

    var legacy = findRow(report, 'bch_legacy');
    var compressed = hash160Of(legacy);
    if (compressed) {
      var cash = cashaddr(compressed, 0);
      out.bch_cashaddr = {
        id: 'bch_cashaddr',
        label: 'Bitcoin Cash CashAddr (compressed)',
        address: cash,
        steps: {
          pubkey: stepString(legacy, 'pubkey'),
          hash160: stepString(legacy, 'hash160'),
          cashaddr: cash
        }
      };
    }

    var uncompressedRow = findRow(report, 'btc_p2pkh_uncompressed');
    var uncompressed = hash160Of(uncompressedRow);
    if (uncompressed) {
      var pubkey = stepString(uncompressedRow, 'pubkey');
      var hashHex = stepString(uncompressedRow, 'hash160');
      var doge = base58check([0x1e], uncompressed);
      var zcash = base58check([0x1c, 0xb8], uncompressed);
      out.doge_p2pkh_uncompressed = {
        id: 'doge_p2pkh_uncompressed',
        label: 'Dogecoin legacy (uncompressed)',
        address: doge,
        steps: { pubkey: pubkey, hash160: hashHex, base58: doge }
      };
      out.zcash_p2pkh_uncompressed = {
        id: 'zcash_p2pkh_uncompressed',
        label: 'Zcash transparent (uncompressed)',
        address: zcash,
        steps: { pubkey: pubkey, hash160: hashHex, base58: zcash }
      };
    }
    return out;
  }

  return {
    cashaddr: cashaddr,
    base58check: base58check,
    derive: derive
  };
});
