/* Transaction decoders: raw Bitcoin and EIP-2718 Ethereum bytes to a report.
 *
 * Pure functions only: no DOM, no network, no storage. The page script
 * (tx-page.js) owns rendering; this file is the testable codec.
 *
 * Bitcoin: legacy and BIP144 segwit serialization, varints, P2PKH/P2SH/
 * P2WPKH/P2WSH/P2TR/P2PK/OP_RETURN script detection, base58check and bech32/
 * bech32m addresses, size/weight/vsize. A fee is reported only when the caller
 * supplies every prevout value; otherwise the report says it is unavailable.
 *
 * Ethereum: legacy, EIP-2930 (type 1) and EIP-1559 (type 2) transactions with
 * canonical RLP decoding. Signature recovery and verification are out of
 * scope; the signature fields are reported as they appear in the payload.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorTxDecoders = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var BECH32 = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';
  var MAX_ITEMS = 100000;
  var MAX_RLP_DEPTH = 64;

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* ----------------------------------------------------------------- hex */

  function normalizeHex(text, what) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) throw new Error('Paste a raw ' + what + ' transaction in hex.');
    var value = raw.replace(/\s+/g, '').replace(/^0x/i, '');
    if (!value) throw new Error('Paste a raw ' + what + ' transaction in hex.');
    var bad = value.search(/[^0-9a-fA-F]/);
    if (bad >= 0) {
      throw new Error('Invalid hex character "' + value.charAt(bad) + '" at position ' + bad + ' after the optional 0x prefix.');
    }
    if (value.length % 2 !== 0) {
      throw new Error('Hex has an odd number of digits (' + value.length + '); each byte needs two hex digits.');
    }
    return value.toLowerCase();
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

  function reversedHex(bytes) {
    var out = '';
    for (var index = bytes.length - 1; index >= 0; index -= 1) {
      out += bytes[index].toString(16).padStart(2, '0');
    }
    return out;
  }

  function hexQuantity(value) {
    return '0x' + value.toString(16);
  }

  function formatUnits(value, decimals) {
    var unit = 10n ** BigInt(decimals);
    var whole = value / unit;
    var fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  function readUIntLE(bytes) {
    var value = 0;
    for (var index = bytes.length - 1; index >= 0; index -= 1) {
      value = value * 256 + bytes[index];
    }
    return value;
  }

  function readIntLE(bytes) {
    var value = readUIntLE(bytes);
    var limit = 2 ** (bytes.length * 8);
    return value >= limit / 2 ? value - limit : value;
  }

  function readBigUIntLE(bytes) {
    var value = 0n;
    for (var index = bytes.length - 1; index >= 0; index -= 1) {
      value = (value << 8n) | BigInt(bytes[index]);
    }
    return value;
  }

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
    var state = new Uint32Array([
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
      var a = state[0], b = state[1], c = state[2], d = state[3];
      var e = state[4], f = state[5], g = state[6], h = state[7];
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
      state[0] = (state[0] + a) >>> 0;
      state[1] = (state[1] + b) >>> 0;
      state[2] = (state[2] + c) >>> 0;
      state[3] = (state[3] + d) >>> 0;
      state[4] = (state[4] + e) >>> 0;
      state[5] = (state[5] + f) >>> 0;
      state[6] = (state[6] + g) >>> 0;
      state[7] = (state[7] + h) >>> 0;
    }

    var out = new Uint8Array(32);
    var outView = new DataView(out.buffer);
    for (i = 0; i < 8; i += 1) outView.setUint32(i * 4, state[i]);
    return out;
  }

  function sha256d(bytes) {
    return sha256(sha256(bytes));
  }

  /* ----------------------------------------------------------- base58/bech32 */

  function base58Encode(bytes) {
    if (!bytes.length) return '';
    var zeros = 0;
    while (zeros < bytes.length && bytes[zeros] === 0) zeros += 1;
    var digits = [];
    for (var index = zeros; index < bytes.length; index += 1) {
      var carry = bytes[index];
      for (var digit = 0; digit < digits.length; digit += 1) {
        carry += digits[digit] << 8;
        digits[digit] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    var out = '1'.repeat(zeros);
    for (var position = digits.length - 1; position >= 0; position -= 1) {
      out += BASE58.charAt(digits[position]);
    }
    return out;
  }

  function base58check(version, payload) {
    var data = new Uint8Array(1 + payload.length);
    data[0] = version;
    data.set(payload, 1);
    var checksum = sha256d(data);
    var full = new Uint8Array(data.length + 4);
    full.set(data, 0);
    full.set(checksum.subarray(0, 4), data.length);
    return base58Encode(full);
  }

  function bech32Polymod(values) {
    var generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var checksum = 1;
    for (var index = 0; index < values.length; index += 1) {
      var top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ values[index];
      for (var bit = 0; bit < 5; bit += 1) {
        if ((top >>> bit) & 1) checksum ^= generators[bit];
      }
    }
    return checksum >>> 0;
  }

  function bech32HrpExpand(hrp) {
    var out = [];
    var index;
    for (index = 0; index < hrp.length; index += 1) out.push(hrp.charCodeAt(index) >>> 5);
    out.push(0);
    for (index = 0; index < hrp.length; index += 1) out.push(hrp.charCodeAt(index) & 31);
    return out;
  }

  function convertBits(data, from, to, pad) {
    var acc = 0;
    var bits = 0;
    var out = [];
    var maxv = (1 << to) - 1;
    for (var index = 0; index < data.length; index += 1) {
      var value = data[index];
      if (value < 0 || value >>> from) throw new Error('invalid bech32 data');
      acc = (acc << from) | value;
      bits += from;
      while (bits >= to) {
        bits -= to;
        out.push((acc >>> bits) & maxv);
      }
    }
    if (pad) {
      if (bits > 0) out.push((acc << (to - bits)) & maxv);
    } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
      throw new Error('invalid bech32 padding');
    }
    return out;
  }

  /* Witness v0 uses bech32 (constant 1); v1+ uses bech32m (0x2bc830a3). */
  function bech32Encode(hrp, version, program) {
    var data = [version].concat(convertBits(program, 8, 5, true));
    var constant = version === 0 ? 1 : 0x2bc830a3;
    var values = bech32HrpExpand(hrp).concat(data).concat([0, 0, 0, 0, 0, 0]);
    var mod = (bech32Polymod(values) ^ constant) >>> 0;
    var checksum = [];
    for (var index = 0; index < 6; index += 1) {
      checksum.push((mod >>> (5 * (5 - index))) & 31);
    }
    return hrp + '1' + data.concat(checksum).map(function (value) {
      return BECH32.charAt(value);
    }).join('');
  }

  /* -------------------------------------------------------- BTC scripts */

  function scriptInfo(bytes) {
    var length = bytes.length;
    if (length === 25 && bytes[0] === 0x76 && bytes[1] === 0xa9 && bytes[2] === 0x14 &&
        bytes[23] === 0x88 && bytes[24] === 0xac) {
      return {
        type: 'p2pkh',
        label: 'P2PKH',
        address: base58check(0x00, bytes.subarray(3, 23))
      };
    }
    if (length === 23 && bytes[0] === 0xa9 && bytes[1] === 0x14 && bytes[22] === 0x87) {
      return {
        type: 'p2sh',
        label: 'P2SH',
        address: base58check(0x05, bytes.subarray(2, 22))
      };
    }
    if (length === 22 && bytes[0] === 0x00 && bytes[1] === 0x14) {
      return {
        type: 'p2wpkh',
        label: 'P2WPKH',
        address: bech32Encode('bc', 0, bytes.subarray(2))
      };
    }
    if (length === 34 && bytes[0] === 0x00 && bytes[1] === 0x20) {
      return {
        type: 'p2wsh',
        label: 'P2WSH',
        address: bech32Encode('bc', 0, bytes.subarray(2))
      };
    }
    if (length === 34 && bytes[0] === 0x51 && bytes[1] === 0x20) {
      return {
        type: 'p2tr',
        label: 'P2TR',
        address: bech32Encode('bc', 1, bytes.subarray(2))
      };
    }
    if (length === 35 && bytes[0] === 0x21 && bytes[34] === 0xac) {
      return { type: 'p2pk', label: 'P2PK', address: null, pubkey: bytesToHex(bytes.subarray(1, 34)) };
    }
    if (length === 67 && bytes[0] === 0x41 && bytes[66] === 0xac) {
      return { type: 'p2pk', label: 'P2PK', address: null, pubkey: bytesToHex(bytes.subarray(1, 66)) };
    }
    if (length >= 1 && bytes[0] === 0x6a) {
      return { type: 'op_return', label: 'OP_RETURN', address: null };
    }
    if (length >= 4 && length <= 42 && bytes[0] >= 0x51 && bytes[0] <= 0x60 &&
        bytes[1] === length - 2 && bytes[1] >= 2 && bytes[1] <= 40) {
      var version = bytes[0] - 0x50;
      return {
        type: 'witness_v' + version,
        label: 'Witness v' + version,
        address: bech32Encode('bc', version, bytes.subarray(2))
      };
    }
    if (length === 0) return { type: 'empty', label: 'Empty', address: null };
    return { type: 'unknown', label: 'Unknown', address: null };
  }

  function scriptInfoHex(hex) {
    var text = String(hex == null ? '' : hex).replace(/^0x/i, '');
    if (!/^[0-9a-fA-F]*$/.test(text) || text.length % 2 !== 0) {
      throw new Error('A script must be an even number of hex digits.');
    }
    return scriptInfo(hexToBytes(text));
  }

  /* ------------------------------------------------------- BTC decoding */

  function varintSize(value) {
    if (value < 0xfd) return 1;
    if (value <= 0xffff) return 3;
    if (value <= 0xffffffff) return 5;
    return 9;
  }

  function makeReader(bytes) {
    var offset = 0;
    return {
      position: function () { return offset; },
      remaining: function () { return bytes.length - offset; },
      peek: function () { return offset < bytes.length ? bytes[offset] : null; },
      read: function (length, what) {
        if (offset + length > bytes.length) {
          throw new Error('Transaction is truncated at byte ' + offset + ': expected ' + length +
            ' byte(s) for ' + what + ', only ' + Math.max(0, bytes.length - offset) + ' remain.');
        }
        var out = bytes.subarray(offset, offset + length);
        offset += length;
        return out;
      },
      byte: function (what) {
        return this.read(1, what)[0];
      },
      varint: function (what) {
        var first = this.byte(what);
        if (first < 0xfd) return first;
        if (first === 0xfd) return readUIntLE(this.read(2, what));
        if (first === 0xfe) return readUIntLE(this.read(4, what));
        var value = readBigUIntLE(this.read(8, what));
        if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
          throw new Error(what + ' is too large to decode (varint ' + value + ').');
        }
        return Number(value);
      },
      count: function (what) {
        var value = this.varint(what);
        if (value > MAX_ITEMS) {
          throw new Error(what + ' is implausibly large (' + value + '); refusing to decode.');
        }
        return value;
      }
    };
  }

  function parsePrevouts(text, inputCount) {
    var raw = String(text == null ? '' : text).trim();
    if (!raw) return null;
    var parts = raw.split(/[\s,]+/).filter(Boolean);
    if (parts.length !== inputCount) {
      throw new Error('Prevout values: got ' + parts.length + ' value(s) for ' + inputCount +
        ' input(s); supply one satoshi amount per input, or leave the field empty.');
    }
    return parts.map(function (part, index) {
      if (!/^\d+$/.test(part)) {
        throw new Error('Prevout ' + (index + 1) + ' ("' + part + '") must be a whole number of satoshis.');
      }
      return BigInt(part);
    });
  }

  function decodeBitcoin(text, prevoutText) {
    var hex = normalizeHex(text, 'Bitcoin');
    var bytes = hexToBytes(hex);
    var reader = makeReader(bytes);

    var version = readIntLE(reader.read(4, 'version'));
    var segwit = false;
    var marker = null;
    var flag = null;
    if (reader.peek() === 0x00) {
      marker = reader.byte('marker');
      flag = reader.byte('flag');
      if (flag !== 0x01) {
        throw new Error('Unsupported segwit flag 0x' + flag.toString(16).padStart(2, '0') +
          ' at byte 5; only 0x01 is defined.');
      }
      segwit = true;
    }

    var inputCount = reader.count('input count');
    if (inputCount === 0) throw new Error('Transaction declares zero inputs.');
    var inputs = [];
    for (var inputIndex = 0; inputIndex < inputCount; inputIndex += 1) {
      var txidBytes = reader.read(32, 'input ' + inputIndex + ' txid');
      var vout = readUIntLE(reader.read(4, 'input ' + inputIndex + ' vout'));
      var scriptLength = reader.count('input ' + inputIndex + ' scriptSig length');
      var script = reader.read(scriptLength, 'input ' + inputIndex + ' scriptSig');
      var sequence = readUIntLE(reader.read(4, 'input ' + inputIndex + ' sequence'));
      inputs.push({
        index: inputIndex,
        txid: reversedHex(txidBytes),
        vout: vout,
        sequence: sequence,
        scriptSig: bytesToHex(script),
        scriptSigLength: script.length,
        witness: []
      });
    }

    var outputCount = reader.count('output count');
    if (outputCount === 0) throw new Error('Transaction declares zero outputs.');
    var outputs = [];
    var totalOut = 0n;
    for (var outputIndex = 0; outputIndex < outputCount; outputIndex += 1) {
      var value = readBigUIntLE(reader.read(8, 'output ' + outputIndex + ' value'));
      var pubkeyLength = reader.count('output ' + outputIndex + ' scriptPubKey length');
      var pubkey = reader.read(pubkeyLength, 'output ' + outputIndex + ' scriptPubKey');
      var info = scriptInfo(pubkey);
      totalOut += value;
      outputs.push({
        index: outputIndex,
        valueSats: value.toString(10),
        valueBtc: formatUnits(value, 8),
        scriptType: info.type,
        scriptTypeLabel: info.label,
        address: info.address || null,
        pubkey: info.pubkey || null,
        scriptPubKey: bytesToHex(pubkey)
      });
    }

    if (segwit) {
      for (var witnessIndex = 0; witnessIndex < inputCount; witnessIndex += 1) {
        var itemCount = reader.count('input ' + witnessIndex + ' witness item count');
        for (var itemIndex = 0; itemIndex < itemCount; itemIndex += 1) {
          var itemLength = reader.count('input ' + witnessIndex + ' witness item ' + itemIndex + ' length');
          inputs[witnessIndex].witness.push(
            bytesToHex(reader.read(itemLength, 'input ' + witnessIndex + ' witness item ' + itemIndex))
          );
        }
      }
    }

    var locktime = readUIntLE(reader.read(4, 'locktime'));
    if (reader.remaining() > 0) {
      throw new Error('Transaction has ' + reader.remaining() + ' trailing byte(s) after locktime at byte ' +
        reader.position() + '; a raw transaction ends after the 4-byte locktime (and witness data).');
    }

    var baseSize = 4 + varintSize(inputCount) +
      inputs.reduce(function (sum, input) {
        return sum + 36 + varintSize(input.scriptSigLength) + input.scriptSigLength + 4;
      }, 0) +
      varintSize(outputCount) +
      outputs.reduce(function (sum, output) {
        return sum + 8 + varintSize(output.scriptPubKey.length / 2) + output.scriptPubKey.length / 2;
      }, 0) +
      4;
    var size = bytes.length;
    var weight = segwit ? baseSize * 3 + size : size * 4;
    var vsize = Math.ceil(weight / 4);

    var prevouts = parsePrevouts(prevoutText, inputCount);
    var fee = null;
    var feeNote = 'fee unavailable without prevouts';
    if (prevouts) {
      var prevoutSum = prevouts.reduce(function (sum, value) { return sum + value; }, 0n);
      if (prevoutSum < totalOut) {
        throw new Error('Prevout total ' + prevoutSum + ' sats is below the output total ' +
          totalOut + ' sats; check the supplied values.');
      }
      fee = prevoutSum - totalOut;
      feeNote = null;
    }

    return {
      chain: 'bitcoin',
      encoding: segwit ? 'segwit' : 'legacy',
      version: version,
      marker: marker,
      flag: flag,
      locktime: locktime,
      inputCount: inputCount,
      outputCount: outputCount,
      size: size,
      weight: weight,
      vsize: vsize,
      totalOutSats: totalOut.toString(10),
      totalOutBtc: formatUnits(totalOut, 8),
      feeSats: fee === null ? null : fee.toString(10),
      feeBtc: fee === null ? null : formatUnits(fee, 8),
      feeNote: feeNote,
      rawHex: hex,
      inputs: inputs,
      outputs: outputs
    };
  }

  /* ----------------------------------------------------------- EVM RLP */

  function rlpTake(bytes, state, length, what) {
    var end = state.offset + length;
    if (end > bytes.length) {
      throw new Error('RLP is truncated at byte ' + state.offset + ': expected ' + length +
        ' byte(s) for ' + what + ', only ' + Math.max(0, bytes.length - state.offset) + ' remain.');
    }
    var out = bytes.subarray(state.offset, end);
    state.offset = end;
    return out;
  }

  function rlpLength(bytes, state, lengthOfLength, what, start) {
    var raw = rlpTake(bytes, state, lengthOfLength, 'length of an RLP ' + what);
    if (raw[0] === 0) {
      throw new Error('RLP ' + what + ' length at byte ' + start + ' has a leading zero byte.');
    }
    var length = 0;
    for (var index = 0; index < raw.length; index += 1) {
      length = length * 256 + raw[index];
      if (length > 0xffffffff) {
        throw new Error('RLP ' + what + ' length at byte ' + start + ' is too large.');
      }
    }
    if (length < 56) {
      throw new Error('RLP ' + what + ' at byte ' + start + ' uses the long length form for ' +
        length + ' bytes; the long form requires at least 56.');
    }
    return length;
  }

  function rlpItem(bytes, state, depth) {
    if (depth > MAX_RLP_DEPTH) throw new Error('RLP nesting is deeper than ' + MAX_RLP_DEPTH + ' levels.');
    if (state.offset >= bytes.length) {
      throw new Error('RLP is truncated at byte ' + state.offset + ': expected an item, reached the end.');
    }
    var start = state.offset;
    var prefix = bytes[state.offset];
    state.offset += 1;
    if (prefix <= 0x7f) {
      return { type: 'bytes', bytes: Uint8Array.of(prefix) };
    }
    if (prefix <= 0xb7) {
      var shortLength = prefix - 0x80;
      if (shortLength === 1 && state.offset < bytes.length && bytes[state.offset] < 0x80) {
        throw new Error('RLP string at byte ' + start + ' is not canonical: a single byte below 0x80 must encode itself.');
      }
      return { type: 'bytes', bytes: rlpTake(bytes, state, shortLength, 'RLP string') };
    }
    if (prefix <= 0xbf) {
      var stringLength = rlpLength(bytes, state, prefix - 0xb7, 'string', start);
      return { type: 'bytes', bytes: rlpTake(bytes, state, stringLength, 'RLP string') };
    }
    var listLength;
    if (prefix <= 0xf7) {
      listLength = prefix - 0xc0;
    } else {
      listLength = rlpLength(bytes, state, prefix - 0xf7, 'list', start);
    }
    var end = state.offset + listLength;
    if (end > bytes.length) {
      throw new Error('RLP list at byte ' + start + ' declares ' + listLength + ' bytes, but only ' +
        Math.max(0, bytes.length - state.offset) + ' remain.');
    }
    var items = [];
    while (state.offset < end) {
      items.push(rlpItem(bytes, state, depth + 1));
      if (state.offset > end) {
        throw new Error('RLP list at byte ' + start + ' overruns its declared ' + listLength + '-byte length.');
      }
    }
    return { type: 'list', items: items };
  }

  function decodeRlp(bytes) {
    var state = { offset: 0 };
    var item = rlpItem(bytes, state, 0);
    if (state.offset !== bytes.length) {
      throw new Error('RLP payload has ' + (bytes.length - state.offset) +
        ' trailing byte(s) at byte ' + state.offset + ' after the root item.');
    }
    return item;
  }

  function rlpBytes(item, name) {
    if (item.type !== 'bytes') throw new Error(name + ' must be an RLP byte string, got a list.');
    return item.bytes;
  }

  function rlpInteger(item, name) {
    var raw = rlpBytes(item, name);
    if (raw.length && raw[0] === 0) {
      throw new Error(name + ' has a non-canonical leading zero byte.');
    }
    return raw.length ? BigInt('0x' + bytesToHex(raw)) : 0n;
  }

  function rlpAddress(item, name) {
    var raw = rlpBytes(item, name);
    if (raw.length !== 0 && raw.length !== 20) {
      throw new Error(name + ' must be empty (contract creation) or 20 bytes, got ' + raw.length + ' bytes.');
    }
    return raw.length ? '0x' + bytesToHex(raw) : null;
  }

  function rlpAccessList(item, name) {
    if (item.type !== 'list') throw new Error(name + ' must be an RLP list.');
    return item.items.map(function (entry, index) {
      var where = name + ' entry ' + index;
      if (entry.type !== 'list') throw new Error(where + ' must be an RLP list.');
      if (entry.items.length !== 2) {
        throw new Error(where + ' has ' + entry.items.length + ' fields, expected an address and a storage-key list.');
      }
      var address = rlpAddress(entry.items[0], where + ' address');
      if (!address) throw new Error(where + ' address must be 20 bytes, got 0.');
      var keysItem = entry.items[1];
      if (keysItem.type !== 'list') throw new Error(where + ' storage keys must be an RLP list.');
      var storageKeys = keysItem.items.map(function (key, keyIndex) {
        var raw = rlpBytes(key, where + ' storage key ' + keyIndex);
        if (raw.length !== 32) {
          throw new Error(where + ' storage key ' + keyIndex + ' must be 32 bytes, got ' + raw.length + '.');
        }
        return '0x' + bytesToHex(raw);
      });
      return { address: address, storageKeys: storageKeys };
    });
  }

  function fieldCount(root, expected, label) {
    if (root.items.length !== expected) {
      throw new Error(label + ' payload has ' + root.items.length + ' RLP fields, expected ' + expected + '.');
    }
  }

  function quantityPair(value) {
    return {
      decimal: value.toString(10),
      hex: hexQuantity(value)
    };
  }

  function signatureReport(yParity, v, rItem, sItem) {
    return {
      yParity: yParity,
      v: v === null ? null : v.toString(10),
      r: '0x' + bytesToHex(rlpBytes(rItem, 'r')),
      s: '0x' + bytesToHex(rlpBytes(sItem, 's'))
    };
  }

  function dataReport(raw) {
    var hex = bytesToHex(raw);
    return {
      length: raw.length,
      selector: raw.length >= 4 ? '0x' + hex.slice(0, 8) : null,
      firstBytes: '0x' + hex.slice(0, Math.min(64, hex.length)),
      hex: '0x' + hex
    };
  }

  function decodeEthereum(text) {
    var hex = normalizeHex(text, 'Ethereum');
    var bytes = hexToBytes(hex);
    if (!bytes.length) throw new Error('Paste a raw Ethereum transaction in hex.');
    var first = bytes[0];
    var type;
    var typeLabel;
    var payload;
    if (first >= 0xc0) {
      type = 'legacy';
      typeLabel = 'Legacy (type 0)';
      payload = bytes;
    } else if (first === 0x01) {
      type = 'access-list';
      typeLabel = 'EIP-2930 (type 1, access list)';
      payload = bytes.subarray(1);
    } else if (first === 0x02) {
      type = 'eip1559';
      typeLabel = 'EIP-1559 (type 2)';
      payload = bytes.subarray(1);
    } else if (first === 0x03) {
      throw new Error('EIP-4844 blob transactions (type 3) are not supported by this decoder.');
    } else {
      throw new Error('Unsupported EIP-2718 transaction type 0x' + first.toString(16).padStart(2, '0') +
        '; this decoder handles legacy, type 1 and type 2 transactions.');
    }
    var root = decodeRlp(payload);
    if (root.type !== 'list') {
      throw new Error(typeLabel + ' payload must be an RLP list, got a byte string.');
    }

    var report = {
      chain: 'ethereum',
      type: type,
      typeLabel: typeLabel,
      size: bytes.length,
      chainId: null,
      chainIdHex: null,
      nonce: null,
      nonceHex: null,
      gasLimit: null,
      gasLimitHex: null,
      gasPrice: null,
      gasPriceHex: null,
      maxPriorityFeePerGas: null,
      maxPriorityFeePerGasHex: null,
      maxFeePerGas: null,
      maxFeePerGasHex: null,
      to: null,
      contractCreation: false,
      valueWei: null,
      valueWeiHex: null,
      valueEth: null,
      dataLength: 0,
      selector: null,
      firstBytes: '0x',
      dataHex: '0x',
      accessList: [],
      signature: { yParity: null, v: null, r: '0x', s: '0x' }
    };

    if (type === 'legacy') {
      fieldCount(root, 9, typeLabel);
      var nonce = rlpInteger(root.items[0], 'nonce');
      var gasPrice = rlpInteger(root.items[1], 'gas price');
      var gasLimit = rlpInteger(root.items[2], 'gas limit');
      var to = rlpAddress(root.items[3], 'to');
      var value = rlpInteger(root.items[4], 'value');
      var data = dataReport(rlpBytes(root.items[5], 'data'));
      var v = rlpInteger(root.items[6], 'v');
      var r = root.items[7];
      var s = root.items[8];
      var yParity = null;
      var chainId = null;
      if (v >= 35n) {
        chainId = (v - 35n) / 2n;
        yParity = Number((v - 35n) % 2n);
      } else if (v === 27n || v === 28n) {
        yParity = Number(v - 27n);
      }
      report.nonce = nonce.toString(10);
      report.nonceHex = hexQuantity(nonce);
      report.gasPrice = gasPrice.toString(10);
      report.gasPriceHex = hexQuantity(gasPrice);
      report.gasLimit = gasLimit.toString(10);
      report.gasLimitHex = hexQuantity(gasLimit);
      report.to = to;
      report.contractCreation = to === null;
      report.valueWei = value.toString(10);
      report.valueWeiHex = hexQuantity(value);
      report.valueEth = formatUnits(value, 18);
      report.dataLength = data.length;
      report.selector = data.selector;
      report.firstBytes = data.firstBytes;
      report.dataHex = data.hex;
      report.chainId = chainId === null ? null : chainId.toString(10);
      report.chainIdHex = chainId === null ? null : hexQuantity(chainId);
      report.signature = signatureReport(yParity, v, r, s);
      return report;
    }

    if (type === 'access-list') {
      fieldCount(root, 11, typeLabel);
      var chain = quantityPair(rlpInteger(root.items[0], 'chain id'));
      var nonce1 = quantityPair(rlpInteger(root.items[1], 'nonce'));
      var gasPrice1 = quantityPair(rlpInteger(root.items[2], 'gas price'));
      var gasLimit1 = quantityPair(rlpInteger(root.items[3], 'gas limit'));
      report.chainId = chain.decimal;
      report.chainIdHex = chain.hex;
      report.nonce = nonce1.decimal;
      report.nonceHex = nonce1.hex;
      report.gasPrice = gasPrice1.decimal;
      report.gasPriceHex = gasPrice1.hex;
      report.gasLimit = gasLimit1.decimal;
      report.gasLimitHex = gasLimit1.hex;
      var to1 = rlpAddress(root.items[4], 'to');
      report.to = to1;
      report.contractCreation = to1 === null;
      var value1 = rlpInteger(root.items[5], 'value');
      report.valueWei = value1.toString(10);
      report.valueWeiHex = hexQuantity(value1);
      report.valueEth = formatUnits(value1, 18);
      var data1 = dataReport(rlpBytes(root.items[6], 'data'));
      report.dataLength = data1.length;
      report.selector = data1.selector;
      report.firstBytes = data1.firstBytes;
      report.dataHex = data1.hex;
      report.accessList = rlpAccessList(root.items[7], 'access list');
      var yParity1 = rlpInteger(root.items[8], 'y parity');
      if (yParity1 > 1n) throw new Error('y parity must be 0 or 1, got ' + yParity1 + '.');
      report.signature = signatureReport(Number(yParity1), null, root.items[9], root.items[10]);
      return report;
    }

    fieldCount(root, 12, typeLabel);
    var chain2 = quantityPair(rlpInteger(root.items[0], 'chain id'));
    var nonce2 = quantityPair(rlpInteger(root.items[1], 'nonce'));
    var priority = quantityPair(rlpInteger(root.items[2], 'max priority fee per gas'));
    var maxFee = quantityPair(rlpInteger(root.items[3], 'max fee per gas'));
    var gasLimit2 = quantityPair(rlpInteger(root.items[4], 'gas limit'));
    report.chainId = chain2.decimal;
    report.chainIdHex = chain2.hex;
    report.nonce = nonce2.decimal;
    report.nonceHex = nonce2.hex;
    report.maxPriorityFeePerGas = priority.decimal;
    report.maxPriorityFeePerGasHex = priority.hex;
    report.maxFeePerGas = maxFee.decimal;
    report.maxFeePerGasHex = maxFee.hex;
    report.gasLimit = gasLimit2.decimal;
    report.gasLimitHex = gasLimit2.hex;
    var to2 = rlpAddress(root.items[5], 'to');
    report.to = to2;
    report.contractCreation = to2 === null;
    var value2 = rlpInteger(root.items[6], 'value');
    report.valueWei = value2.toString(10);
    report.valueWeiHex = hexQuantity(value2);
    report.valueEth = formatUnits(value2, 18);
    var data2 = dataReport(rlpBytes(root.items[7], 'data'));
    report.dataLength = data2.length;
    report.selector = data2.selector;
    report.firstBytes = data2.firstBytes;
    report.dataHex = data2.hex;
    report.accessList = rlpAccessList(root.items[8], 'access list');
    var yParity2 = rlpInteger(root.items[9], 'y parity');
    if (yParity2 > 1n) throw new Error('y parity must be 0 or 1, got ' + yParity2 + '.');
    report.signature = signatureReport(Number(yParity2), null, root.items[10], root.items[11]);
    return report;
  }

  return {
    decodeBitcoin: decodeBitcoin,
    decodeEthereum: decodeEthereum,
    scriptInfo: scriptInfoHex,
    _errorText: errorText
  };
});
