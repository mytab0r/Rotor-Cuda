/* Shared private-key search parser: hex, WIF, byte array or brainwallet. */
(function () {
  'use strict';

  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function decodeBase58(text) {
    var number = 0n;
    for (var i = 0; i < text.length; i += 1) {
      var index = BASE58.indexOf(text[i]);
      if (index < 0) throw new Error('Invalid base58 character.');
      number = number * 58n + BigInt(index);
    }
    var hex = number === 0n ? '' : number.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var bytes = new Uint8Array(hex.length / 2);
    for (var j = 0; j < bytes.length; j += 1) bytes[j] = parseInt(hex.substr(j * 2, 2), 16);
    var leading = 0;
    while (leading < text.length && text[leading] === '1') leading += 1;
    if (!leading) return bytes;
    var out = new Uint8Array(bytes.length + leading);
    out.set(bytes, leading);
    return out;
  }

  async function decodeWif(text) {
    var raw = decodeBase58(text);
    if (raw.length !== 37 && raw.length !== 38) throw new Error('Not a WIF length.');
    if (raw[0] !== 0x80) throw new Error('Not a mainnet WIF.');
    if (raw.length === 38 && raw[33] !== 0x01) throw new Error('Bad compression marker.');
    var payload = raw.slice(0, raw.length - 4);
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', payload));
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', digest));
    for (var i = 0; i < 4; i += 1) {
      if (digest[i] !== raw[raw.length - 4 + i]) throw new Error('WIF checksum mismatch.');
    }
    return bytesToHex(payload.slice(1, 33));
  }

  async function sha256Hex(text) {
    var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return bytesToHex(digest);
  }

  async function resolve(text) {
    var value = String(text || '').trim();
    if (!value) throw new Error('Paste a key, WIF or brainwallet text first.');
    if (/^0x[0-9a-fA-F]{1,64}$/.test(value)) value = value.slice(2);
    if (/^[0-9a-fA-F]{1,64}$/.test(value)) {
      return value.toLowerCase().padStart(64, '0');
    }
    if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(value)) return decodeWif(value);
    if (/^\s*\[[\d,\s]+\]\s*$/.test(value)) {
      var parsed = JSON.parse(value);
      if (Array.isArray(parsed) && (parsed.length === 32 || parsed.length === 64) &&
          parsed.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
        return parsed.slice(0, 32).map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
      }
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Brainwallet search needs HTTPS in this browser.');
    }
    return sha256Hex(value);
  }

  window.RotorSearch = { resolve: resolve };
})();
