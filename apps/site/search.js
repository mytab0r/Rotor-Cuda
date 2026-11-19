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

  function hexFromBytes(bytes) {
    return bytes.map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }

  var MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

  /**
   * Auto-detect the input format without deriving anything.
   * Returns { kind, hex?, curve?, phrase?, chain? } or throws a precise error
   * for formats the key page cannot consume (XRP family seeds, bad keypairs).
   * Never falls back to a brainwallet hash for a recognized non-text format.
   */
  async function detect(text) {
    var value = String(text || '').trim();
    if (!value) throw new Error('Paste a key, WIF, mnemonic or brainwallet text first.');
    var words = value.split(/\s+/);
    if (MNEMONIC_WORD_COUNTS.indexOf(words.length) >= 0 &&
        words.every(function (word) { return /^[a-z]+$/.test(word); })) {
      return { kind: 'mnemonic', phrase: words.join(' ') };
    }
    if (/^s[1-9A-HJ-NP-Za-km-z]{20,30}$/.test(value)) {
      throw new Error('XRP family seeds (s…) are not supported in this search. Paste the 64-hex private key or export the hex key from your wallet.');
    }
    if (/^\[[\d,\s]+\]$/.test(value)) {
      var parsed;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        throw new Error('Keypair JSON is not valid.');
      }
      if (!Array.isArray(parsed) || (parsed.length !== 32 && parsed.length !== 64) ||
          !parsed.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
        throw new Error('Keypair must be a JSON array of 32 (seed) or 64 (secret key) byte values 0–255.');
      }
      return { kind: 'keypair', hex: hexFromBytes(parsed.slice(0, 32)), curve: 'ed25519', chain: 'solana' };
    }
    var normalized = value;
    if (/^0x[0-9a-fA-F]{1,64}$/.test(normalized)) normalized = normalized.slice(2);
    if (/^[0-9a-fA-F]{1,64}$/.test(normalized)) {
      return { kind: 'hex', hex: normalized.toLowerCase().padStart(64, '0') };
    }
    if (/^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/.test(value)) {
      return { kind: 'wif', hex: await decodeWif(value) };
    }
    if (!window.crypto || !window.crypto.subtle) {
      throw new Error('Brainwallet search needs HTTPS in this browser.');
    }
    return { kind: 'brainwallet', hex: await sha256Hex(value) };
  }

  async function resolve(text) {
    var result = await detect(text);
    if (result.kind === 'mnemonic') {
      throw new Error('A mnemonic opens the seed tools; it is not a single private key.');
    }
    return result.hex;
  }

  window.RotorSearch = { resolve: resolve, detect: detect };
})();
