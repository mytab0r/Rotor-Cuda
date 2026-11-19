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
    scrollBehavior: scrollBehavior
  };

  global.RotorKeyTools = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
