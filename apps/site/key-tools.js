/* Integer and byte-fragment helpers shared by the key utility pages.
 * Pure functions only: no DOM, no network, no storage. */
(function (global) {
  'use strict';

  var LIMIT = 1n << 256n;
  var SECP_ORDER = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

  var SSOT_ROOT = typeof window !== 'undefined' ? window : globalThis;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var AMOUNT = SSOT_ROOT.RotorAmount;

  function clean(text) {
    return String(text == null ? '' : text).trim().replace(/[\s_]+/g, '');
  }

  function parseInteger(text) {
    var raw = clean(text).toLowerCase();
    if (!raw) throw new Error('Enter a hex, decimal or binary value.');
    var digits;
    if (raw.slice(0, 2) === '0x') {
      digits = raw.slice(2);
      if (!/^[0-9a-f]+$/.test(digits)) {
        throw new Error('Hex values may only contain 0-9 and a-f after 0x.');
      }
    } else if (raw.slice(0, 2) === '0b') {
      digits = raw.slice(2);
      if (!/^[01]+$/.test(digits)) {
        throw new Error('Binary values may only contain 0 and 1 after 0b.');
      }
    } else {
      digits = raw;
      if (!/^[0-9]+$/.test(digits)) {
        throw new Error('Use 0x for hex, 0b for binary, or plain digits for decimal.');
      }
    }
    var value = BigInt((raw.slice(0, 2) === '0x' ? '0x' : raw.slice(0, 2) === '0b' ? '0b' : '') + digits);
    if (value >= LIMIT) {
      throw new Error('The value is wider than 256 bits. This tool stops at 256 bits.');
    }
    return value;
  }

  function formatInteger(value) {
    if (typeof value !== 'bigint') value = BigInt(value);
    if (value < 0n || value >= LIMIT) {
      throw new Error('The value must be between 0 and 2^256 - 1.');
    }
    var hex = value.toString(16);
    var binary = value.toString(2);
    var digits = Math.max(1, Math.ceil(hex.length / 2));
    return {
      decimal: value.toString(10),
      hex: '0x' + hex,
      hexPadded: hex.padStart(64, '0'),
      binary: '0b' + binary,
      binaryPadded: binary.padStart(256, '0'),
      bytes: digits
    };
  }

  function integerBytes(value) {
    var padded = formatInteger(value).hexPadded;
    var out = new Uint8Array(32);
    for (var index = 0; index < 32; index += 1) {
      out[index] = parseInt(padded.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var index = 0; index < out.length; index += 1) {
      out[index] = parseInt(hex.slice(index * 2, index * 2 + 2), 16);
    }
    return out;
  }

  function bytesToHex(bytes) {
    var out = '';
    for (var index = 0; index < bytes.length; index += 1) {
      out += bytes[index].toString(16).padStart(2, '0');
    }
    return out;
  }

  function fragmentBytes(format, value) {
    var text = String(value == null ? '' : value).trim();
    if (!text) throw new Error('The fragment value is empty.');
    var bytes;
    if (format === 'hex') {
      var hex = clean(text).replace(/^0x/i, '');
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length % 2 !== 0) {
        throw new Error('Hex fragments need an even number of 0-9/a-f digits.');
      }
      bytes = hexToBytes(hex);
    } else if (format === 'bin') {
      var bits = clean(text).replace(/^0b/i, '');
      if (!/^[01]+$/.test(bits) || bits.length % 8 !== 0) {
        throw new Error('Binary fragments need a whole number of 8-bit bytes.');
      }
      bytes = new Uint8Array(bits.length / 8);
      for (var index = 0; index < bytes.length; index += 1) {
        bytes[index] = parseInt(bits.slice(index * 8, index * 8 + 8), 2);
      }
    } else if (format === 'dec') {
      if (!/^[0-9]+$/.test(clean(text))) {
        throw new Error('Decimal fragments must be a whole number from 0 to 255.');
      }
      var number = Number(clean(text));
      if (number > 255) throw new Error('A decimal fragment is one byte, so it must be 0-255.');
      bytes = Uint8Array.of(number);
    } else if (format === 'ascii') {
      bytes = new TextEncoder().encode(text);
    } else {
      throw new Error('Unknown fragment format "' + format + '". Use hex, bin, dec or ascii.');
    }
    return bytes;
  }

  /* Each non-blank, non-# line is `offset:format:value`, for example
   * `0:hex:2c7536e3605d9c16`. Offsets are byte positions 0-31. */
  function assembleKey(text) {
    var lines = String(text == null ? '' : text).split(/\r?\n/);
    var buffer = new Array(32).fill(null);
    var fragments = 0;
    for (var index = 0; index < lines.length; index += 1) {
      var line = lines[index].trim();
      if (!line || line.charAt(0) === '#') continue;
      var first = line.indexOf(':');
      var second = first < 0 ? -1 : line.indexOf(':', first + 1);
      if (first < 1 || second < 0) {
        throw new Error('Line ' + (index + 1) + ': use offset:format:value.');
      }
      var offsetText = line.slice(0, first).trim();
      if (!/^[0-9]+$/.test(offsetText)) {
        throw new Error('Line ' + (index + 1) + ': the offset must be a byte number 0-31.');
      }
      var offset = Number(offsetText);
      if (offset > 31) {
        throw new Error('Line ' + (index + 1) + ': the offset must be 0-31.');
      }
      var format = line.slice(first + 1, second).trim().toLowerCase();
      var bytes = fragmentBytes(format, line.slice(second + 1));
      if (offset + bytes.length > 32) {
        throw new Error('Line ' + (index + 1) + ': the fragment runs past byte 31.');
      }
      for (var cursor = 0; cursor < bytes.length; cursor += 1) {
        if (buffer[offset + cursor] !== null) {
          throw new Error('Line ' + (index + 1) + ': byte ' + (offset + cursor) + ' is already set by another fragment.');
        }
        buffer[offset + cursor] = bytes[cursor];
      }
      fragments += 1;
    }
    if (fragments === 0) throw new Error('Add at least one fragment.');
    var missing = [];
    for (var position = 0; position < 32; position += 1) {
      if (buffer[position] === null) missing.push(position);
    }
    if (missing.length) {
      return { complete: false, missing: missing, fragments: fragments };
    }
    var filled = Uint8Array.from(buffer);
    return { complete: true, missing: [], fragments: fragments, bytes: filled, hex: bytesToHex(filled) };
  }

  /* ---------------------------------------------------------- wasm helpers */

  var decoder = new TextDecoder('utf-8');
  var encoder = new TextEncoder();

  async function loadWasm(url) {
    var response = await fetch(url || (window.RotorAssets
      ? window.RotorAssets.url('/rotor_wasm.wasm')
      : '/rotor_wasm.wasm'));
    if (!response.ok) throw new Error('Cannot load the calculation core: HTTP ' + response.status);
    var module;
    try {
      module = await WebAssembly.instantiateStreaming(response.clone(), {});
    } catch (err) {
      module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
    }
    var wasm = module.instance ? module.instance.exports : module.exports;
    if (!wasm.memory || typeof wasm.alloc !== 'function' || typeof wasm.dealloc !== 'function') {
      throw new Error('The calculation core has an unexpected ABI. Reload the page.');
    }
    return wasm;
  }

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return decoder.decode(new Uint8Array(wasm.memory.buffer, pointer, length));
  }

  /* Copy bytes into wasm memory. The caller must `dealloc(pointer, length)`. */
  function upload(wasm, data) {
    var bytes = typeof data === 'string' ? encoder.encode(data) : data;
    var pointer = wasm.alloc(bytes.length) >>> 0;
    if (!pointer) throw new Error('The calculation core ran out of memory.');
    new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
    return { pointer: pointer, length: bytes.length };
  }

  function wasmResultJson(wasm) {
    return JSON.parse(wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
  }

  function wasmError(wasm) {
    return wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0) || 'The calculation failed.';
  }

  function scrollBehavior() {
    if (typeof window !== 'undefined' && window.matchMedia &&
        window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      return 'auto';
    }
    return 'smooth';
  }

  /* ---------------------------------------------------- key-fact shaping */
  /* Pure formatting for the key page summary: all key encodings the
   * derivation report can support, with an explicit reason when a format is
   * not defined for the current curve. */

  var BITCOIN_BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var RIPPLE_BASE58 = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz';
  var DIRECTORY_PAGE_SIZE = 60n;
  /* A key's JSON secret envelope: a private-key type byte, the 32-byte key
   * and a four-byte double-SHA256 checksum. */
  var XRP_SECRET_PREFIX = 0x23;

  function base58Encode(bytes, alphabet) {
    var chars = alphabet || BITCOIN_BASE58;
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    var value = 0n;
    for (var index = zeros; index < bytes.length; index += 1) {
      value = value * 256n + BigInt(bytes[index]);
    }
    var digits = '';
    while (value > 0n) {
      digits = chars[Number(value % 58n)] + digits;
      value /= 58n;
    }
    return chars[0].repeat(zeros) + digits;
  }

  function rippleBase58Encode(bytes) {
    return base58Encode(bytes, RIPPLE_BASE58);
  }

  function base58Decode(text, alphabet) {
    var chars = alphabet || BITCOIN_BASE58;
    var value = 0n;
    for (var index = 0; index < text.length; index += 1) {
      var digit = chars.indexOf(text.charAt(index));
      if (digit < 0) throw new Error('Invalid base58 character in the WIF.');
      value = value * 58n + BigInt(digit);
    }
    var leading = 0;
    while (leading < text.length && text.charAt(leading) === chars.charAt(0)) leading += 1;
    var hex = value === 0n ? '' : value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var body = hex ? hexToBytes(hex) : new Uint8Array(0);
    var out = new Uint8Array(leading + body.length);
    out.set(body, leading);
    return out;
  }

  /* Mainnet Wallet Import Format versions for the secp256k1 UTXO chains this
   * site derives. BCH uses the Bitcoin byte, so its WIF is identical to BTC's. */
  var WIF_VERSIONS = { bitcoin: 0x80, litecoin: 0xb0, dogecoin: 0x9e };
  var WIF_NETWORKS = {};
  Object.keys(WIF_VERSIONS).forEach(function (name) {
    WIF_NETWORKS[WIF_VERSIONS[name]] = name;
  });

  /* Mainnet WIF: version || 32-byte key || (0x01 when compressed) || first
   * four bytes of double-SHA256. `compressed` defaults to true; pass false for
   * the 37-byte legacy form. doubleSha256 is injected so the same code runs in
   * the browser (crypto.subtle) and under Node tests (node:crypto). */
  async function wifEncode(keyBytes, network, doubleSha256, compressed) {
    var version = WIF_VERSIONS[network];
    if (version === undefined) {
      throw new Error('Unknown WIF network "' + network + '". Use bitcoin, litecoin or dogecoin.');
    }
    if (!keyBytes || keyBytes.length !== 32) {
      throw new Error('A WIF needs a 32-byte private key.');
    }
    if (typeof doubleSha256 !== 'function') {
      throw new Error('The WIF checksum needs SHA-256 support in this browser.');
    }
    var isCompressed = compressed !== false;
    var bodyLength = isCompressed ? 34 : 33;
    var payload = new Uint8Array(bodyLength);
    payload[0] = version;
    payload.set(keyBytes, 1);
    if (isCompressed) payload[33] = 0x01;
    var digest = await doubleSha256(payload);
    if (!digest || typeof digest.length !== 'number' || digest.length < 4) {
      throw new Error('The checksum function returned no digest.');
    }
    var data = new Uint8Array(bodyLength + 4);
    data.set(payload, 0);
    data.set(digest.slice(0, 4), bodyLength);
    return base58Encode(data);
  }

  async function wifDecode(text, doubleSha256) {
    if (typeof doubleSha256 !== 'function') {
      throw new Error('The WIF checksum needs SHA-256 support in this browser.');
    }
    var raw = base58Decode(String(text == null ? '' : text).trim());
    if (raw.length !== 37 && raw.length !== 38) throw new Error('Not a valid WIF length.');
    var network = WIF_NETWORKS[raw[0]];
    if (!network) throw new Error('Not a Bitcoin, Litecoin or Dogecoin mainnet WIF.');
    if (raw.length === 38 && raw[33] !== 0x01) throw new Error('Invalid WIF compression marker.');
    var payload = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var digest = await doubleSha256(payload);
    for (var index = 0; index < 4; index += 1) {
      if (digest[index] !== checksum[index]) throw new Error('WIF checksum mismatch.');
    }
    return {
      bytes: raw.slice(1, 33),
      version: raw[0],
      network: network,
      compressed: raw.length === 38
    };
  }

  function solanaKeypair(seedHex, pubHex) {
    var seed = hexToBytes(String(seedHex || ''));
    var publicKey = hexToBytes(String(pubHex || ''));
    if (seed.length !== 32 || publicKey.length !== 32) {
      throw new Error('A Solana keypair needs a 32-byte seed and a 32-byte public key.');
    }
    var data = new Uint8Array(64);
    data.set(seed, 0);
    data.set(publicKey, 32);
    return base58Encode(data);
  }

  /* doubleSha256(bytes) must resolve to a 32-byte digest. The caller injects
   * it because the browser uses crypto.subtle and tests use node:crypto. */
  async function xrpSecret(keyHex, doubleSha256) {
    var key = hexToBytes(String(keyHex || ''));
    if (key.length !== 32) throw new Error('The XRP secret needs a 32-byte private key.');
    if (typeof doubleSha256 !== 'function') {
      throw new Error('The XRP checksum needs SHA-256 support in this browser.');
    }
    var payload = new Uint8Array(33);
    payload[0] = XRP_SECRET_PREFIX;
    payload.set(key, 1);
    var digest = await doubleSha256(payload);
    if (!digest || typeof digest.length !== 'number' || digest.length < 4) {
      throw new Error('The checksum function returned no digest.');
    }
    var data = new Uint8Array(37);
    data.set(payload, 0);
    data.set(digest.slice(0, 4), 33);
    return rippleBase58Encode(data);
  }

  /* XRP accepts two secret envelopes as input: a 0x21 family seed (usually
   * written with an "s" prefix) and a 0x23 bare private key (written with a
   * "p" prefix). Both carry a four-byte double-SHA256 checksum. */
  var XRP_FAMILY_SEED_PREFIX = 0x21;
  var XRP_SECRET_SHAPE = /^[rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz]{29,53}$/;

  function looksLikeXrpSecret(text) {
    var value = String(text == null ? '' : text).trim();
    if (!XRP_SECRET_SHAPE.test(value)) return false;
    var first = value.charAt(0);
    return first === 's' || first === 'p';
  }

  /* ------------------------------------------------------ search routing */
  /* The donor search modal detects and routes without deriving anything.
   * These helpers are the single mapping from pasted text to a destination:
   * key-like values open /key/<value>, a mnemonic opens /mnemonic-converter,
   * and any other text is a brainwallet. Kept pure so Node tests can pin the
   * vectors and so the modal and the key page agree on what an input means. */

  /* The donor WIF shape, shared with the key page and the global search:
   * 5/K/L (Bitcoin), T/6 (Litecoin) or Q/6 (Dogecoin). */
  var SEARCH_WIF_SHAPE = /^[5KLT6Q][1-9A-HJ-NP-Za-km-z]{50,51}$/;
  var MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];

  function isMnemonicPhrase(text) {
    var words = String(text == null ? '' : text).trim().split(/\s+/);
    return MNEMONIC_WORD_COUNTS.indexOf(words.length) >= 0 &&
      words.every(function (word) { return /^[a-z]+$/.test(word); });
  }

  function jsonKeypair(text) {
    var value = String(text == null ? '' : text).trim();
    if (value.charAt(0) !== '[') return null;
    var parsed;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      return null;
    }
    if (!Array.isArray(parsed) || (parsed.length !== 32 && parsed.length !== 64) ||
        !parsed.every(function (number) {
          return Number.isInteger(number) && number >= 0 && number <= 255;
        })) {
      return null;
    }
    return parsed;
  }

  function base58Keypair(text) {
    var value = String(text == null ? '' : text).trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{80,100}$/.test(value)) return null;
    try {
      var bytes = base58Decode(value);
      return bytes.length === 64 ? bytes : null;
    } catch (err) {
      return null;
    }
  }

  var ROUTE_META = {
    hex: { label: 'Private Key (HEX)', viewLabel: 'Key Details' },
    wif: { label: 'WIF Format', viewLabel: 'Key Details' },
    keypair: { label: 'Keypair', viewLabel: 'Key Details' },
    xrp: { label: 'XRP Secret', viewLabel: 'Key Details' },
    mnemonic: { label: 'Mnemonic', viewLabel: 'Mnemonic Converter' },
    brainwallet: { label: 'Brainwallet', viewLabel: 'Brainwallet Generator' }
  };

  function routeResult(kind, href, extra) {
    var meta = ROUTE_META[kind];
    var out = { kind: kind, label: meta.label, viewLabel: meta.viewLabel, href: href };
    if (extra) {
      Object.keys(extra).forEach(function (key) { out[key] = extra[key]; });
    }
    return out;
  }

  /* Map pasted search text to { kind, label, viewLabel, href } (plus `hex`
   * for a canonical HEX key and `curve` for ed25519 keypairs). `mode` is one
   * of hex/wif/keypair/xrp/mnemonic/brainwallet to force a format, or empty
   * for donor auto-detection. Auto-detection only treats exactly 64 hex
   * characters as a key; a forced HEX chip pads shorter input. */
  function routeKeyInput(raw, mode) {
    var value = String(raw == null ? '' : raw).trim();
    var forced = String(mode == null ? '' : mode).toLowerCase();
    if (!value) return null;

    function hexRoute(allowShort) {
      var hex = value;
      if (hex.slice(0, 2).toLowerCase() === '0x') hex = hex.slice(2);
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length > 64 || (!allowShort && hex.length !== 64)) {
        throw new Error('HEX must be 64 hex characters (an optional 0x prefix is allowed).');
      }
      var padded = hex.toLowerCase().padStart(64, '0');
      return routeResult('hex', '/key/' + padded, { hex: padded });
    }

    function wifRoute() {
      if (!SEARCH_WIF_SHAPE.test(value)) {
        throw new Error('Not a WIF: expected a 51- or 52-character base58 key starting with 5, K, L, T, 6 or Q.');
      }
      return routeResult('wif', '/key/' + value);
    }

    function keypairRoute() {
      var bytes = jsonKeypair(value);
      if (bytes) {
        return routeResult('keypair', '/key/[' + bytes.join(',') + ']', { curve: 'ed25519' });
      }
      if (base58Keypair(value)) {
        return routeResult('keypair', '/key/' + value, { curve: 'ed25519' });
      }
      throw new Error('Keypair must be a Solana base58 keypair or a JSON array of 32 or 64 byte values.');
    }

    function xrpRoute() {
      if (!looksLikeXrpSecret(value)) {
        throw new Error('Not an XRP secret: expected a base58 string starting with "s" or "p".');
      }
      return routeResult('xrp', '/key/' + value);
    }

    function mnemonicRoute() {
      if (!isMnemonicPhrase(value)) {
        throw new Error('Mnemonic must be 12, 15, 18, 21 or 24 lower-case words.');
      }
      return routeResult('mnemonic', '/mnemonic-converter', {
        phrase: value.split(/\s+/).join(' ')
      });
    }

    function brainwalletRoute() {
      return routeResult('brainwallet', '/brainwallet');
    }

    if (forced === 'hex') return hexRoute(true);
    if (forced === 'wif') return wifRoute();
    if (forced === 'keypair') return keypairRoute();
    if (forced === 'xrp' || forced === 'xrp-secret') return xrpRoute();
    if (forced === 'mnemonic') return mnemonicRoute();
    if (forced === 'brainwallet') return brainwalletRoute();
    if (forced && forced !== 'auto') throw new Error('Unknown interpretation mode.');

    if (SEARCH_WIF_SHAPE.test(value)) return wifRoute();
    if (looksLikeXrpSecret(value)) return xrpRoute();
    if (jsonKeypair(value) || base58Keypair(value)) return keypairRoute();
    var prefixed = value.slice(0, 2).toLowerCase() === '0x';
    if (/^[0-9a-fA-F]{64}$/.test(prefixed ? value.slice(2) : value)) return hexRoute(false);
    if (isMnemonicPhrase(value)) return mnemonicRoute();
    return brainwalletRoute();
  }

  function u32(value) {
    return Uint8Array.of((value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff);
  }

  /* XRP derives an account key from a family seed by hashing the seed and,
   * when needed, the public generator with a discriminator and a counter.
   * `hashes.secpPublicKey(bytes)` returns the 33-byte compressed public key;
   * the caller injects it because the browser uses the wasm core. */
  async function xrpFamilySeedKey(seed, hashes) {
    if (typeof hashes.sha512 !== 'function') {
      throw new Error('An XRP family seed needs SHA-512 support in this browser.');
    }
    if (typeof hashes.secpPublicKey !== 'function') {
      throw new Error('An XRP family seed needs the secp256k1 derivation core.');
    }

    async function deriveScalar(bytes, discriminator) {
      for (var counter = 0; counter <= 0xffffffff; counter += 1) {
        var tail = discriminator === undefined
          ? u32(counter)
          : Uint8Array.of(...u32(discriminator), ...u32(counter));
        var input = new Uint8Array(bytes.length + tail.length);
        input.set(bytes, 0);
        input.set(tail, bytes.length);
        var digest = await hashes.sha512(input);
        if (!digest || digest.length < 32) throw new Error('The SHA-512 function returned no digest.');
        var value = BigInt('0x' + bytesToHex(digest.slice(0, 32)));
        if (value > 0n && value < SECP_ORDER) return value;
      }
      throw new Error('The XRP family seed did not produce a valid key.');
    }

    var privateGenerator = await deriveScalar(seed);
    var publicGenerator = await hashes.secpPublicKey(integerBytes(privateGenerator));
    var offset = await deriveScalar(publicGenerator, 0);
    var key = (offset + privateGenerator) % SECP_ORDER;
    if (key === 0n) throw new Error('The XRP family seed derived the zero key.');
    return integerBytes(key);
  }

  async function xrpSecretDecode(text, hashes) {
    hashes = hashes || {};
    if (typeof hashes.doubleSha256 !== 'function') {
      throw new Error('The XRP checksum needs SHA-256 support in this browser.');
    }
    var raw = base58Decode(String(text == null ? '' : text).trim(), RIPPLE_BASE58);
    if (raw.length < 5) throw new Error('Not a valid XRP secret length.');
    var payload = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var digest = await hashes.doubleSha256(payload);
    if (!digest || digest.length < 4) throw new Error('The checksum function returned no digest.');
    for (var index = 0; index < 4; index += 1) {
      if (digest[index] !== checksum[index]) throw new Error('XRP secret checksum mismatch.');
    }
    if (payload.length === 33 && payload[0] === XRP_SECRET_PREFIX) {
      return { bytes: payload.slice(1, 33), format: 'xrp' };
    }
    if (payload.length === 17 && payload[0] === XRP_FAMILY_SEED_PREFIX) {
      return { bytes: await xrpFamilySeedKey(payload.slice(1), hashes), format: 'xrp' };
    }
    throw new Error('Not an XRP family seed or private-key secret.');
  }

  /* Map every accepted key representation to one 32-byte key. This is the one
   * place that decides what a pasted value means, so every format shows the
   * same page and Keys table. Curve/range validation stays with the caller
   * because it depends on the selected curve. */
  async function resolveKeyInput(raw, hashes) {
    hashes = hashes || {};
    var value = String(raw == null ? '' : raw).trim();
    if (!value) throw new Error('Enter a private key.');

    if (value.charAt(0) === '[') {
      var parsed;
      try {
        parsed = JSON.parse(value);
      } catch (err) {
        throw new Error('Keypair JSON must be a flat array of byte values 0–255.');
      }
      if (!Array.isArray(parsed) || (parsed.length !== 32 && parsed.length !== 64) ||
          !parsed.every(function (number) {
            return Number.isInteger(number) && number >= 0 && number <= 255;
          })) {
        throw new Error('Keypair must be a JSON array of 32 (seed) or 64 (secret key) byte values 0–255.');
      }
      var seed = Uint8Array.from(parsed.slice(0, 32));
      return { bytes: seed, hex: bytesToHex(seed), format: 'keypair' };
    }

    /* A Solana keypair is also accepted as its 64-byte base58 form; the first
     * 32 bytes are the ed25519 seed, exactly as the JSON-array form. */
    var keypairBytes = base58Keypair(value);
    if (keypairBytes) {
      var seedBytes = keypairBytes.slice(0, 32);
      return { bytes: seedBytes, hex: bytesToHex(seedBytes), format: 'keypair' };
    }

    var hexValue = value;
    if (hexValue.slice(0, 2).toLowerCase() === '0x') hexValue = hexValue.slice(2);
    if (/^[0-9a-fA-F]{64}$/.test(hexValue)) {
      var keyBytes = hexToBytes(hexValue);
      return { bytes: keyBytes, hex: bytesToHex(keyBytes), format: 'hex' };
    }

    if (/^[0-9]+$/.test(value)) {
      var integer = BigInt(value);
      if (integer >= LIMIT) throw new Error('The decimal key is wider than 256 bits.');
      var integerBytesValue = integerBytes(integer);
      return { bytes: integerBytesValue, hex: bytesToHex(integerBytesValue), format: 'decimal' };
    }

    if (SEARCH_WIF_SHAPE.test(value)) {
      if (typeof hashes.doubleSha256 !== 'function') {
        throw new Error('The WIF checksum needs SHA-256 support in this browser.');
      }
      var decoded = await wifDecode(value, hashes.doubleSha256);
      return {
        bytes: decoded.bytes,
        hex: bytesToHex(decoded.bytes),
        format: 'wif',
        network: decoded.network
      };
    }

    if (looksLikeXrpSecret(value)) {
      try {
        var secret = await xrpSecretDecode(value, hashes);
        return { bytes: secret.bytes, hex: bytesToHex(secret.bytes), format: 'xrp' };
      } catch (err) {
        /* Not a checksum-valid XRP secret: fall through to the brainwallet. */
      }
    }

    if (typeof hashes.sha256 !== 'function') {
      throw new Error('Brainwallet hashing needs SHA-256 support in this browser.');
    }
    var encoded = encoder.encode(value);
    try {
      var hashed = await hashes.sha256(encoded);
      return { bytes: hashed, hex: bytesToHex(hashed), format: 'brainwallet' };
    } finally {
      encoded.fill(0);
    }
  }

  /* The private-key directory page that lists this key: 60 keys per page,
   * starting at key 1. Key 0 is not enumerated. */
  function privateKeyPage(keyHex, curve) {
    var text = String(keyHex || '');
    if (text.length !== 64 || !/^[0-9a-fA-F]+$/.test(text)) return null;
    var value = BigInt('0x' + text);
    if (value < 1n) return null;
    var page = (value - 1n) / DIRECTORY_PAGE_SIZE + 1n;
    var chain = curve === 'ed25519' ? 'solana' : 'bitcoin';
    return {
      page: page.toString(),
      href: '/private-keys/' + chain + (page === 1n ? '' : '/' + page)
    };
  }

  /* Facts render in this order; `unavailable` replaces the value with a
   * reason instead of leaving a blank. `href` links the label, `valueHref`
   * links the value. The donor key page shows exactly these eight rows, so
   * the curve (already visible in the key input) is not one of them. */
  async function buildKeyFacts(report, doubleSha256) {
    report = report || {};
    var curve = report.curve || 'secp256k1';
    var secp = curve !== 'ed25519';
    var facts = [];
    facts.push(report.priv_hex
      ? { id: 'hex', label: 'HEX', value: report.priv_hex, href: '/key/hex' }
      : { id: 'hex', label: 'HEX', href: '/key/hex', unavailable: 'The derivation report did not return a private key.' });
    facts.push(report.priv_dec
      ? { id: 'decimal', label: 'Decimal', value: report.priv_dec }
      : { id: 'decimal', label: 'Decimal', unavailable: 'The derivation report did not return a decimal key.' });

    if (secp && report.wif_compressed) {
      facts.push({ id: 'wif', label: 'WIF', value: report.wif_compressed, href: '/key/wif' });
    } else {
      facts.push({
        id: 'wif', label: 'WIF', href: '/key/wif',
        unavailable: secp
          ? 'The derivation report did not return a compressed WIF.'
          : 'A WIF encodes a secp256k1 key; switch the curve to secp256k1.'
      });
    }
    if (secp && report.wif_uncompressed) {
      facts.push({ id: 'wif_u', label: 'WIF (u)', value: report.wif_uncompressed, href: '/key/wif' });
    } else {
      facts.push({
        id: 'wif_u', label: 'WIF (u)', href: '/key/wif',
        unavailable: secp
          ? 'The derivation report did not return an uncompressed WIF.'
          : 'An uncompressed WIF is secp256k1-only; switch the curve.'
      });
    }

    if (!secp && report.priv_hex && report.ed_pubkey) {
      try {
        facts.push({ id: 'keypair', label: 'Keypair (SOL)', value: solanaKeypair(report.priv_hex, report.ed_pubkey) });
      } catch (err) {
        facts.push({ id: 'keypair', label: 'Keypair (SOL)', unavailable: err.message || String(err) });
      }
    } else {
      facts.push({
        id: 'keypair', label: 'Keypair (SOL)',
        unavailable: secp
          ? 'Solana keypairs are ed25519; switch the curve to ed25519.'
          : 'The derivation report did not return an ed25519 public key.'
      });
    }

    if (secp && report.priv_hex && typeof doubleSha256 === 'function') {
      try {
        facts.push({ id: 'xrp', label: 'Secret (XRP)', value: await xrpSecret(report.priv_hex, doubleSha256) });
      } catch (err) {
        facts.push({ id: 'xrp', label: 'Secret (XRP)', unavailable: err && err.message ? err.message : String(err) });
      }
    } else {
      facts.push({
        id: 'xrp', label: 'Secret (XRP)',
        unavailable: secp
          ? 'The XRP checksum needs SHA-256 (a secure context: https or localhost).'
          : 'XRP classic accounts use secp256k1; switch the curve.'
      });
    }

    var pubkey = secp ? report.pubkey_compressed : report.ed_pubkey;
    facts.push(pubkey
      ? { id: 'pubkey', label: 'PubKey', value: pubkey }
      : { id: 'pubkey', label: 'PubKey', unavailable: 'The derivation report did not return a public key.' });

    var page = privateKeyPage(report.priv_hex, curve);
    facts.push(page
      ? { id: 'page', label: 'Page', value: page.href, valueHref: page.href }
      : { id: 'page', label: 'Page', unavailable: 'Key 0 is not listed in the integer private-key directory (it starts at 1).' });
    return facts;
  }

  /* ------------------------------------------------ key-page row plumbing */
  /* The donor key page orders chain groups BTC, EVM, TRX, SOL, TON, SUI,
   * XRP, LTC, BCH, DOGE, ZEC. Within a family the report order is kept. */
  var GROUP_ORDER = ['btc', 'evm', 'tron', 'solana', 'ton', 'sui', 'xrp', 'ltc', 'bch', 'doge', 'zcash'];
  var CHAIN_GROUP_TOTAL = 18;
  var FAMILY_PREFIXES = ['btc', 'ltc', 'doge', 'bch', 'zcash', 'xrp', 'ton'];

  /* Chain family used for ordering and counters. EVM rows keep their own
   * identity: the eight networks are eight chain groups, the generic parent
   * row is not a chain at all. TON V4R2 and W5 are one chain family, so they
   * share a chain cell and a single counter group. */
  function rowFamily(id) {
    var text = String(id == null ? '' : id);
    if (!text) return '';
    if (text === 'evm' || text.indexOf('evm_') === 0) return 'evm';
    for (var index = 0; index < FAMILY_PREFIXES.length; index += 1) {
      if (text.indexOf(FAMILY_PREFIXES[index] + '_') === 0) return FAMILY_PREFIXES[index];
    }
    return text;
  }

  /* Chain cell grouping: rows of one family share one Chain cell with a
   * rowspan (BTC 5, LTC 4 ...). EVM sub-rows keep their own cell, and the
   * shared 0x parent row is its own group. */
  function rowGroup(id) {
    var text = String(id == null ? '' : id);
    if (!text) return '';
    if (text === 'evm' || text.indexOf('evm_') === 0) return text;
    return rowFamily(text);
  }

  /* Chain identity for an address-row id. Symbol, icon and decimals come from
   * data/chains.json; the maps only translate the wasm row ids to slugs. */
  var ROW_CHAIN_SLUGS = {
    btc: 'bitcoin',
    evm: 'ethereum',
    evm_bnb: 'bnb',
    evm_arbitrum: 'arbitrum',
    evm_optimism: 'optimism',
    evm_base: 'base',
    evm_polygon: 'polygon',
    evm_avalanche: 'avalanche',
    evm_zksync: 'zksync',
    tron: 'tron',
    solana: 'solana',
    ltc: 'litecoin',
    doge: 'dogecoin',
    bch: 'bitcoin-cash',
    xrp: 'xrp',
    zcash: 'zcash',
    sui: 'sui',
    ton: 'ton'
  };

  function chainSlug(id) {
    var text = String(id == null ? '' : id);
    if (ROW_CHAIN_SLUGS[text]) return ROW_CHAIN_SLUGS[text];
    return ROW_CHAIN_SLUGS[text.split('_')[0]] || '';
  }

  function chainUnit(slug) {
    var meta = SSOT_CHAINS.bySlug[slug];
    return { symbol: meta.symbol, decimals: meta.decimals };
  }

  function chainMeta(id) {
    var slug = chainSlug(id);
    var meta = slug ? SSOT_CHAINS.bySlug[slug] : null;
    if (!meta) {
      return { ticker: String(id == null ? '' : id).toUpperCase(), icon: 'ui-blockchain', decimals: 0 };
    }
    return { ticker: meta.symbol, icon: meta.icon, decimals: meta.decimals };
  }

  function orderAddressRows(rows) {
    var list = Array.isArray(rows) ? rows.slice() : [];
    return list.map(function (row, index) {
      return { row: row, index: index };
    }).sort(function (left, right) {
      var a = GROUP_ORDER.indexOf(rowFamily(left.row && left.row.id));
      var b = GROUP_ORDER.indexOf(rowFamily(right.row && right.row.id));
      if (a < 0) a = GROUP_ORDER.length;
      if (b < 0) b = GROUP_ORDER.length;
      return a - b || left.index - right.index;
    }).map(function (entry) {
      return entry.row;
    });
  }

  /* The donor key page derives any 32-byte value on both curves, so its table
   * always carries the secp256k1 rows and the ed25519-only rows together.
   * `secpReport` and `edReport` are the two derive_report outputs (either may
   * be null: an out-of-range value has no secp256k1 report), and `extras`
   * carries rows the JS encoders add: { secp: [...], ed25519: [...] }. Each
   * returned row is tagged with the curve that produced it; ids are unique. */
  var ED25519_ONLY_IDS = ['solana', 'sui', 'ton_w5'];

  function mergeCurveAddresses(secpReport, edReport, extras) {
    var out = [];
    var seen = {};
    function add(row, curve) {
      if (!row || typeof row.id !== 'string' || !row.id) return;
      if (typeof row.address !== 'string' || !row.address) return;
      if (seen[row.id]) return;
      seen[row.id] = true;
      out.push(Object.assign({}, row, { curve: curve }));
    }
    function rowsOf(report) {
      return report && Array.isArray(report.addresses) ? report.addresses : [];
    }
    var extra = extras || {};
    rowsOf(secpReport).forEach(function (row) { add(row, 'secp256k1'); });
    (Array.isArray(extra.secp) ? extra.secp : []).forEach(function (row) { add(row, 'secp256k1'); });
    /* The TON V4R2 row is built by the page (the ed25519 report carries W5
     * only), so extras land before the report rows and keep V4R2 above W5 in
     * the TON group. */
    (Array.isArray(extra.ed25519) ? extra.ed25519 : []).forEach(function (row) { add(row, 'ed25519'); });
    rowsOf(edReport).forEach(function (row) {
      if (row && ED25519_ONLY_IDS.indexOf(row.id) >= 0) add(row, 'ed25519');
    });
    return out;
  }

  /* The single EVM account becomes the donor's generic 0x parent row followed
   * by one row per network id, all showing the same address ("↑ same").
   * `networks` is [{ id, label }] in display order. */
  function expandEvmAddresses(rows, networks, parentLabel) {
    var list = Array.isArray(rows) ? rows : [];
    var ids = Array.isArray(networks) ? networks : [];
    var out = [];
    list.forEach(function (row) {
      if (!row || !row.id) return;
      if (row.id !== 'evm') {
        out.push(row);
        return;
      }
      out.push({
        id: 'evm_parent',
        label: parentLabel || 'EVM (shared 0x address)',
        address: row.address,
        steps: row.steps,
        sharedParent: true,
        curve: row.curve
      });
      ids.forEach(function (network) {
        var id = typeof network === 'string' ? network : network && network.id;
        if (!id) return;
        out.push({
          id: id,
          label: network && network.label ? network.label : id,
          address: row.address,
          steps: null,
          sharedEvm: true,
          curve: row.curve
        });
      });
    });
    return out;
  }

  /* rows: [{ group, visible }] in DOM order. The returned array is aligned
   * with the input; `span` is set only on the first visible row of a run and
   * counts that run's visible rows. Hidden rows never open or extend a run,
   * so a filter that leaves two of five BTC rows shows a rowspan of 2. */
  function groupAddressRows(rows) {
    var list = Array.isArray(rows) ? rows : [];
    var out = [];
    var run = null;
    for (var index = 0; index < list.length; index += 1) {
      var row = list[index] || {};
      var group = String(row.group == null ? '' : row.group);
      out.push({ group: group, span: 0 });
      if (!row.visible) continue;
      if (!run || run.group !== group) run = { index: index, group: group, count: 0 };
      run.count += 1;
      out[run.index].span = run.count;
    }
    return out;
  }

  /* Donor type labels. The long descriptive name stays in the row's details
   * and title, so the table itself matches the donor vocabulary. */
  var ADDRESS_TYPE_LABELS = {
    btc_p2pkh: 'Legacy',
    btc_p2pkh_uncompressed: 'Legacy (u)',
    btc_p2sh_p2wpkh: 'P2SH',
    btc_p2wpkh: 'SegWit',
    btc_p2tr: 'Taproot',
    ltc_p2pkh: 'Legacy',
    ltc_p2sh_p2wpkh: 'P2SH',
    ltc_p2wpkh: 'SegWit',
    ltc_p2tr: 'Taproot',
    bch_cashaddr: 'CashAddr',
    bch_legacy: 'Legacy',
    doge_p2pkh: 'Legacy',
    doge_p2pkh_uncompressed: 'Legacy (u)',
    zcash_p2pkh: 't1 (c)',
    zcash_p2pkh_uncompressed: 't1 (u)',
    ton: 'V4R2',
    ton_w5: 'W5',
    sui: '0x',
    tron: 'Base58',
    solana: 'Base58',
    xrp_classic: 'r…',
    evm: 'EVM'
  };

  function addressTypeLabel(id) {
    var text = String(id == null ? '' : id);
    if (ADDRESS_TYPE_LABELS[text]) return ADDRESS_TYPE_LABELS[text];
    if (text.indexOf('evm_') === 0) return '';
    return text.replace(/_/g, ' ');
  }

  /* One key per chain group in the counters: 18 in total (BTC, LTC, BCH,
   * DOGE, TON, ZEC, TRX, SOL, SUI, XRP + eight EVM networks). The generic 0x
   * parent row is not a chain. */
  function counterChainKey(id) {
    var text = String(id == null ? '' : id);
    if (!text || text === 'evm_parent') return '';
    if (text === 'evm' || text.indexOf('evm_') === 0) return text;
    return rowFamily(text);
  }

  /* One formatter for the balance row and its title. `decimals` and `symbol`
   * come from the provider summary, never from a chain-page constant. */
  function formatAtomic(summary) {
    var amount = 0n;
    try {
      amount = BigInt(summary && summary.amount != null ? summary.amount : 0);
    } catch (err) {
      amount = 0n;
    }
    var decimals = summary && Number.isInteger(summary.decimals) ? summary.decimals : 0;
    if (decimals < 0) decimals = 0;
    if (decimals > 30) decimals = 30;
    return AMOUNT.formatUnits(amount, decimals, {
      symbol: summary && summary.symbol ? summary.symbol : ''
    });
  }

  /* The row text and the title are the same line: amount, tx count, nonce,
   * note and one relative time. */
  function balanceLine(summary, options) {
    var settings = options || {};
    var parts = [formatAtomic(summary)];
    if (summary && summary.txs !== null && summary.txs !== undefined) {
      parts.push(String(summary.txs) + ' tx');
    }
    if (summary && summary.nonce !== null && summary.nonce !== undefined) {
      parts.push('nonce ' + String(summary.nonce));
    }
    if (summary && summary.note) parts.push(String(summary.note));
    if (settings.lastTxAge) parts.push('last ' + String(settings.lastTxAge));
    else if (settings.age) parts.push(String(settings.age));
    return parts.join(' · ');
  }

  /* One EVM account, eight networks: each row keeps its own chain explorer.
   * The prefixes come from data/chains.json (chains.generated.js), the same
   * source the key page and the directory use. */
  var EVM_EXPLORER_SLUGS = {
    evm: 'ethereum',
    evm_bnb: 'bnb',
    evm_arbitrum: 'arbitrum',
    evm_optimism: 'optimism',
    evm_base: 'base',
    evm_polygon: 'polygon',
    evm_avalanche: 'avalanche',
    evm_zksync: 'zksync'
  };

  var ADDRESS_EXPLORER_SLUGS = {
    tron: 'tron',
    solana: 'solana',
    sui: 'sui',
    ton: 'ton',
    ton_w5: 'ton'
  };

  var ADDRESS_PREFIXES = {
    btc_: 'bitcoin',
    ltc_: 'litecoin',
    doge_: 'dogecoin',
    bch_: 'bitcoin-cash',
    zcash_: 'zcash',
    xrp_: 'xrp'
  };

  function explorerPrefixFor(slug) {
    var chain = SSOT_CHAINS.bySlug[slug];
    return chain ? chain.explorerPrefix : '';
  }

  /* Public explorer for one address row. The caller appends the encoded
   * address, so every prefix ends with "/address/" (or the chain's
   * equivalent). */
  function explorerFor(id) {
    if (EVM_EXPLORER_SLUGS[id]) return explorerPrefixFor(EVM_EXPLORER_SLUGS[id]);
    if (ADDRESS_EXPLORER_SLUGS[id]) return explorerPrefixFor(ADDRESS_EXPLORER_SLUGS[id]);
    if (typeof id === 'string') {
      for (var prefix in ADDRESS_PREFIXES) {
        if (id.indexOf(prefix) === 0) return explorerPrefixFor(ADDRESS_PREFIXES[prefix]);
      }
    }
    return '';
  }

  /* SoChain v3 `/balance/<ticker>/<address>` decimal strings are converted in
   * one place: `parseSochainBalance` in balance-cache.js, which every consumer
   * loads. This export keeps the key-tools API and delegates to it. */
  function parseSochainBalance(data) {
    var api = SSOT_ROOT.RotorBalanceCache;
    return api && typeof api.parseSochainBalance === 'function'
      ? api.parseSochainBalance(data)
      : null;
  }

  /* Counters over the visible address rows. `rows` entries:
   * { chain, state, amount, active, checkable, visible }.
   * - Has balance: unique chain groups with amount > 0 (not addresses).
   * - Active: unique chain groups with amount > 0 or a provider activity
   *   signal; chains without one count a balance only.
   * - Checked: chain groups whose visible rows are all done, out of the fixed
   *   18. A checkable row is done at ok/err. Every chain group now has a
   *   balance provider, so the `!checkable` branch is only a safety net for a
   *   row type that loses its provider. */
  function balanceCounters(rows, totalChains) {
    var groups = {};
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !row.chain || !row.visible) return;
      var key = String(row.chain);
      var group = groups[key] || (groups[key] = { funded: false, active: false, total: 0, done: 0 });
      group.total += 1;
      if (!row.checkable || row.state === 'ok' || row.state === 'err') group.done += 1;
      if (row.state !== 'ok' || row.amount === null || row.amount === undefined) return;
      var amount;
      try {
        amount = BigInt(row.amount);
      } catch (err) {
        return;
      }
      if (amount > 0n) {
        group.funded = true;
        group.active = true;
      } else if (row.active === true) {
        group.active = true;
      }
    });
    var withBalance = 0;
    var activeChains = 0;
    var checked = 0;
    Object.keys(groups).forEach(function (key) {
      var group = groups[key];
      if (group.funded) withBalance += 1;
      if (group.active) activeChains += 1;
      if (group.total > 0 && group.done === group.total) checked += 1;
    });
    return {
      withBalance: withBalance,
      activeChains: activeChains,
      checked: checked,
      total: typeof totalChains === 'number' && totalChains > 0 ? totalChains : CHAIN_GROUP_TOTAL
    };
  }

  /* ------------------------------------------------------------ fiat prices */
  /* Public ticker symbols for the USD total. Only these symbols leave the
   * browser; no address, balance or key is part of a price request. */
  var USD_TICKERS = {
    BTC: 'BTCUSDT',
    ETH: 'ETHUSDT',
    BNB: 'BNBUSDT',
    SOL: 'SOLUSDT',
    TRX: 'TRXUSDT',
    LTC: 'LTCUSDT',
    DOGE: 'DOGEUSDT',
    BCH: 'BCHUSDT',
    XRP: 'XRPUSDT',
    ZEC: 'ZECUSDT',
    POL: 'POLUSDT',
    AVAX: 'AVAXUSDT',
    TON: 'TONUSDT',
    SUI: 'SUIUSDT'
  };

  /* Balance summaries carry a chain slug, a ticker, or both. EVM L2s settle
   * in ETH; Polygon, BNB Chain and Avalanche keep their own coin. */
  var CHAIN_SYMBOLS = {
    btc: 'BTC',
    bitcoin: 'BTC',
    eth: 'ETH',
    ethereum: 'ETH',
    arbitrum: 'ETH',
    optimism: 'ETH',
    base: 'ETH',
    zksync: 'ETH',
    bnb: 'BNB',
    polygon: 'POL',
    avalanche: 'AVAX',
    tron: 'TRX',
    solana: 'SOL',
    ltc: 'LTC',
    litecoin: 'LTC',
    doge: 'DOGE',
    dogecoin: 'DOGE',
    bch: 'BCH',
    bitcoincash: 'BCH',
    'bitcoin-cash': 'BCH',
    xrp: 'XRP',
    zcash: 'ZEC',
    ton: 'TON',
    sui: 'SUI'
  };

  function tickerFor(chainOrSymbol) {
    var text = String(chainOrSymbol == null ? '' : chainOrSymbol).trim();
    if (!text) return '';
    var upper = text.toUpperCase();
    if (Object.prototype.hasOwnProperty.call(USD_TICKERS, upper)) return upper;
    return CHAIN_SYMBOLS[text.toLowerCase()] || '';
  }

  function tickerList() {
    var out = [];
    Object.keys(USD_TICKERS).forEach(function (base) {
      var symbol = USD_TICKERS[base];
      if (out.indexOf(symbol) < 0) out.push(symbol);
    });
    return out;
  }

  function priceRequestUrl() {
    return 'https://api.binance.com/api/v3/ticker/price?symbols=' +
      encodeURIComponent(JSON.stringify(tickerList()));
  }

  /* Accepts Binance's [{symbol, price}] array (or a {symbol: price} map in
   * tests) and keeps only supported USDT pairs with a positive price. */
  function parsePriceResponse(data) {
    var prices = {};
    var items = [];
    if (Array.isArray(data)) {
      items = data;
    } else if (data && typeof data === 'object') {
      Object.keys(data).forEach(function (symbol) {
        items.push({ symbol: symbol, price: data[symbol] });
      });
    }
    items.forEach(function (item) {
      if (!item || typeof item.symbol !== 'string') return;
      var symbol = item.symbol.trim().toUpperCase();
      if (symbol.slice(-4) !== 'USDT') return;
      var base = symbol.slice(0, -4);
      if (USD_TICKERS[base] !== symbol) return;
      if (priceScaled(item.price) === null) return;
      prices[base] = String(item.price).trim();
    });
    return prices;
  }

  /* Binance prices have at most 8 decimals; a 9th digit rounds half up. */
  function priceScaled(price) {
    if (typeof price !== 'string' && typeof price !== 'number') return null;
    var match = /^(\d+)(?:\.(\d*))?$/.exec(String(price).trim());
    if (!match) return null;
    var fraction = match[2] || '';
    var kept = fraction.slice(0, 8).padEnd(8, '0');
    var scaled = BigInt(match[1]) * 100000000n + BigInt(kept);
    if (fraction.length > 8 && fraction.charCodeAt(8) >= 53) scaled += 1n;
    return scaled > 0n ? scaled : null;
  }

  /* Atomic amount -> integer USD cents with BigInt, so 18-decimal wei and
   * 8-decimal satoshis never pass through floating point. Rounds half up. */
  function atomicToCents(amount, decimals, scaledPrice) {
    var units;
    try {
      units = typeof amount === 'bigint' ? amount : BigInt(amount);
    } catch (err) {
      return null;
    }
    if (units < 0n) units = 0n;
    var digits = Number(decimals);
    if (!Number.isInteger(digits) || digits < 0 || digits > 36) return null;
    var price;
    try {
      price = typeof scaledPrice === 'bigint' ? scaledPrice : BigInt(scaledPrice);
    } catch (err) {
      return null;
    }
    if (price <= 0n) return null;
    var denominator = 10n ** BigInt(digits + 8);
    var numerator = units * price * 100n;
    return (numerator + denominator / 2n) / denominator;
  }

  /* rows: {chain, symbol, amount, decimals}. A row with no price is excluded
   * and counted, never treated as zero, so the total cannot quietly shrink. */
  function fiatTotals(rows, prices) {
    var table = prices && typeof prices === 'object' ? prices : {};
    var cents = 0n;
    var included = 0;
    var noPrice = 0;
    var noBalance = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || row.amount === null || row.amount === undefined || row.amount === '') {
        noBalance += 1;
        return;
      }
      var amount;
      try {
        amount = typeof row.amount === 'bigint' ? row.amount : BigInt(row.amount);
      } catch (err) {
        noBalance += 1;
        return;
      }
      var base = tickerFor(row.symbol) || tickerFor(row.chain);
      var scaled = base && Object.prototype.hasOwnProperty.call(table, base)
        ? priceScaled(table[base])
        : null;
      if (!base || scaled === null) {
        noPrice += 1;
        return;
      }
      var value = atomicToCents(amount, row.decimals, scaled);
      if (value === null) {
        noPrice += 1;
        return;
      }
      cents += value;
      included += 1;
    });
    return { cents: cents, included: included, noPrice: noPrice, noBalance: noBalance };
  }

  function formatUsd(cents) {
    var value;
    try {
      value = typeof cents === 'bigint' ? cents : BigInt(cents);
    } catch (err) {
      return '$0.00';
    }
    var negative = value < 0n;
    if (negative) value = -value;
    var dollars = value / 100n;
    var rest = value % 100n;
    var grouped = dollars.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return (negative ? '-' : '') + '$' + grouped + '.' + rest.toString().padStart(2, '0');
  }

  /* 'fresh' inside the TTL, 'stale' beyond it, 'missing' when there is no
   * usable cache. A negative age (clock skew) stays fresh. */
  function priceCacheState(entry, now, ttlMs) {
    if (!entry || typeof entry !== 'object') return 'missing';
    var prices = entry.prices;
    if (!prices || typeof prices !== 'object' || !Object.keys(prices).length) return 'missing';
    var fetchedAt = Number(entry.fetchedAt);
    var ttl = Number(ttlMs);
    var at = Number(now);
    if (!isFinite(fetchedAt) || fetchedAt <= 0 || !isFinite(ttl) || ttl <= 0 || !isFinite(at)) {
      return 'missing';
    }
    return at - fetchedAt < ttl ? 'fresh' : 'stale';
  }

  function formatPriceTime(ms) {
    var at = Number(ms);
    if (!isFinite(at) || at <= 0) return '';
    return new Date(at).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';
  }

  var api = {
    LIMIT: LIMIT,
    parseInteger: parseInteger,
    formatInteger: formatInteger,
    integerBytes: integerBytes,
    hexToBytes: hexToBytes,
    bytesToHex: bytesToHex,
    assembleKey: assembleKey,
    loadWasm: loadWasm,
    wasmText: wasmText,
    upload: upload,
    wasmResultJson: wasmResultJson,
    wasmError: wasmError,
    scrollBehavior: scrollBehavior,
    base58Encode: base58Encode,
    base58Decode: base58Decode,
    wifEncode: wifEncode,
    wifDecode: wifDecode,
    rippleBase58Encode: rippleBase58Encode,
    solanaKeypair: solanaKeypair,
    xrpSecret: xrpSecret,
    xrpSecretDecode: xrpSecretDecode,
    xrpFamilySeedKey: xrpFamilySeedKey,
    looksLikeXrpSecret: looksLikeXrpSecret,
    isMnemonicPhrase: isMnemonicPhrase,
    jsonKeypair: jsonKeypair,
    base58Keypair: base58Keypair,
    routeKeyInput: routeKeyInput,
    resolveKeyInput: resolveKeyInput,
    privateKeyPage: privateKeyPage,
    buildKeyFacts: buildKeyFacts,
    rowFamily: rowFamily,
    rowGroup: rowGroup,
    chainSlug: chainSlug,
    chainUnit: chainUnit,
    chainMeta: chainMeta,
    orderAddressRows: orderAddressRows,
    mergeCurveAddresses: mergeCurveAddresses,
    expandEvmAddresses: expandEvmAddresses,
    groupAddressRows: groupAddressRows,
    addressTypeLabel: addressTypeLabel,
    counterChainKey: counterChainKey,
    balanceCounters: balanceCounters,
    explorerFor: explorerFor,
    parseSochainBalance: parseSochainBalance,
    formatAtomic: formatAtomic,
    balanceLine: balanceLine,
    tickerFor: tickerFor,
    tickerList: tickerList,
    priceRequestUrl: priceRequestUrl,
    parsePriceResponse: parsePriceResponse,
    priceScaled: priceScaled,
    atomicToCents: atomicToCents,
    fiatTotals: fiatTotals,
    formatUsd: formatUsd,
    priceCacheState: priceCacheState,
    formatPriceTime: formatPriceTime,
    CHAIN_GROUP_TOTAL: CHAIN_GROUP_TOTAL
  };

  global.RotorKeyTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
