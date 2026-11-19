/* Integer and byte-fragment helpers shared by the key utility pages.
 * Pure functions only: no DOM, no network, no storage. */
(function (global) {
  'use strict';

  var LIMIT = 1n << 256n;

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
    var response = await fetch(url || '/rotor_wasm.wasm');
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

  function base58Decode(text) {
    var value = 0n;
    for (var index = 0; index < text.length; index += 1) {
      var digit = BITCOIN_BASE58.indexOf(text.charAt(index));
      if (digit < 0) throw new Error('Invalid base58 character in the WIF.');
      value = value * 58n + BigInt(digit);
    }
    var leading = 0;
    while (leading < text.length && text.charAt(leading) === '1') leading += 1;
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

  /* Compressed mainnet WIF: version || 32-byte key || 0x01 || first four bytes
   * of double-SHA256. doubleSha256 is injected so the same code runs in the
   * browser (crypto.subtle) and under Node tests (node:crypto). */
  async function wifEncode(keyBytes, network, doubleSha256) {
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
    var payload = new Uint8Array(34);
    payload[0] = version;
    payload.set(keyBytes, 1);
    payload[33] = 0x01;
    var digest = await doubleSha256(payload);
    if (!digest || typeof digest.length !== 'number' || digest.length < 4) {
      throw new Error('The checksum function returned no digest.');
    }
    var data = new Uint8Array(38);
    data.set(payload, 0);
    data.set(digest.slice(0, 4), 34);
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
   * links the value. */
  async function buildKeyFacts(report, doubleSha256) {
    report = report || {};
    var curve = report.curve || 'secp256k1';
    var secp = curve !== 'ed25519';
    var facts = [];
    facts.push({ id: 'curve', label: 'Curve', value: curve });
    facts.push(report.priv_hex
      ? { id: 'hex', label: 'HEX', value: report.priv_hex, href: '/key/hex' }
      : { id: 'hex', label: 'HEX', href: '/key/hex', unavailable: 'The derivation report did not return a private key.' });
    facts.push(report.priv_dec
      ? { id: 'decimal', label: 'DECIMAL', value: report.priv_dec }
      : { id: 'decimal', label: 'DECIMAL', unavailable: 'The derivation report did not return a decimal key.' });

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
      facts.push({ id: 'wif_u', label: 'WIF (U)', value: report.wif_uncompressed, href: '/key/wif' });
    } else {
      facts.push({
        id: 'wif_u', label: 'WIF (U)', href: '/key/wif',
        unavailable: secp
          ? 'The derivation report did not return an uncompressed WIF.'
          : 'An uncompressed WIF is secp256k1-only; switch the curve.'
      });
    }

    if (!secp && report.priv_hex && report.ed_pubkey) {
      try {
        facts.push({ id: 'keypair', label: 'KEYPAIR (SOL)', value: solanaKeypair(report.priv_hex, report.ed_pubkey) });
      } catch (err) {
        facts.push({ id: 'keypair', label: 'KEYPAIR (SOL)', unavailable: err.message || String(err) });
      }
    } else {
      facts.push({
        id: 'keypair', label: 'KEYPAIR (SOL)',
        unavailable: secp
          ? 'Solana keypairs are ed25519; switch the curve to ed25519.'
          : 'The derivation report did not return an ed25519 public key.'
      });
    }

    if (secp && report.priv_hex && typeof doubleSha256 === 'function') {
      try {
        facts.push({ id: 'xrp', label: 'SECRET (XRP)', value: await xrpSecret(report.priv_hex, doubleSha256) });
      } catch (err) {
        facts.push({ id: 'xrp', label: 'SECRET (XRP)', unavailable: err && err.message ? err.message : String(err) });
      }
    } else {
      facts.push({
        id: 'xrp', label: 'SECRET (XRP)',
        unavailable: secp
          ? 'The XRP checksum needs SHA-256 (a secure context: https or localhost).'
          : 'XRP classic accounts use secp256k1; switch the curve.'
      });
    }

    var pubkey = secp ? report.pubkey_compressed : report.ed_pubkey;
    facts.push(pubkey
      ? { id: 'pubkey', label: 'PUBKEY', value: pubkey }
      : { id: 'pubkey', label: 'PUBKEY', unavailable: 'The derivation report did not return a public key.' });

    var page = privateKeyPage(report.priv_hex, curve);
    facts.push(page
      ? { id: 'page', label: 'PAGE', value: page.href, valueHref: page.href }
      : { id: 'page', label: 'PAGE', unavailable: 'Key 0 is not listed in the integer private-key directory (it starts at 1).' });
    return facts;
  }

  /* Counters over the visible address rows. `rows` entries:
   * { address, state, amount, chain, checkable, visible }. Only completed
   * lookups (ok/error) count as checked; a zero or hidden row never inflates
   * the balance counts. */
  function balanceCounters(rows) {
    var addresses = {};
    var chains = {};
    var checked = 0;
    var total = 0;
    (Array.isArray(rows) ? rows : []).forEach(function (row) {
      if (!row || !row.checkable || !row.visible) return;
      total += 1;
      if (row.state === 'ok' || row.state === 'err') checked += 1;
      if (row.state !== 'ok' || row.amount === null || row.amount === undefined) return;
      var amount;
      try { amount = BigInt(row.amount); } catch (err) { return; }
      if (amount <= 0n) return;
      if (row.address) addresses[String(row.address).toLowerCase()] = true;
      if (row.chain) chains[String(row.chain)] = true;
    });
    return {
      withBalance: Object.keys(addresses).length,
      activeChains: Object.keys(chains).length,
      checked: checked,
      total: total
    };
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
    privateKeyPage: privateKeyPage,
    buildKeyFacts: buildKeyFacts,
    balanceCounters: balanceCounters
  };

  global.RotorKeyTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
