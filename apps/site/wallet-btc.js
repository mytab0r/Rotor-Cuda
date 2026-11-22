/* Bitcoin testnet send flow (pure browser/Node codec, no DOM).
 *
 * This module owns the parts that can be tested without a browser:
 *  - exact decimal parsing of BTC into satoshis (BigInt, no float);
 *  - P2WPKH bech32 validation for the destination and the signing address;
 *  - deterministic largest-first coin selection with a P2WPKH dust rule;
 *  - the review preparation over injected public GET/POST callbacks and the
 *    explicit confirm step that signs and broadcasts.
 *
 * It never holds a private key: `confirmTransaction` calls an injected `sign`
 * callback bound to the unlocked vault entry. The only network payloads are
 * public UTXO/fee reads and the signed raw transaction. mempool.space testnet
 * is called directly by the browser with its real Origin; there is no proxy
 * and no spoofing here.
 *
 * The transaction format is fixed by crates/rotor-wasm/src/btc.rs: network
 * "testnet", P2WPKH inputs with an explicit value, P2WPKH outputs (tb1q) and
 * change back to the signing key's address. The WASM core signs exactly the
 * inputs and outputs it is given; fee policy lives here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorBtcSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  /* Chain identity and public providers come from data/*.json through the
   * generated globals in chains.generated.js (loaded before this script). */
  var SSOT_ROOT = typeof globalThis !== 'undefined' ? globalThis : this;
  var SSOT_CHAINS = SSOT_ROOT.RotorChains;
  var SSOT_PROVIDERS = SSOT_ROOT.RotorProviders;

  var CHAIN_SLUG = 'bitcoin-testnet';
  var NETWORK = 'testnet';
  var API_BASE = SSOT_PROVIDERS.find('bitcoin-testnet', 'mempool').url;
  var EXPLORER_ADDRESS = SSOT_CHAINS.bySlug['bitcoin-testnet'].explorerPrefix;
  var EXPLORER_TX = SSOT_CHAINS.bySlug['bitcoin-testnet'].explorerTxPrefix;
  var SATS_DECIMALS = 8;
  var MAX_MONEY = 21000000n * 100000000n;
  /* P2WPKH dust threshold at the default 3 sat/vB relay rate. Change below it
   * is not created; the remainder is added to the fee. */
  var DUST_LIMIT = 294n;
  var SEQUENCE = '4294967295';
  var MAX_FEE_RATE_HUNDREDTHS = 10000000n; // 100,000 sat/vB
  var MAX_INPUTS = 500;

  var BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l';

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* Exact decimal -> integer conversion. No Number, no exponent, no rounding. */
  function parseUnits(text, decimals) {
    if (typeof text !== 'string') throw new Error('use a plain decimal number');
    var value = text.trim();
    if (!value) throw new Error('a number is required');
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('use a plain decimal number like 0.001 (no exponent, sign or comma)');
    }
    var fraction = match[2] || '';
    if (fraction.length > decimals) {
      throw new Error('at most ' + decimals + ' decimal places');
    }
    return BigInt(match[1]) * (10n ** BigInt(decimals)) +
      BigInt(fraction.padEnd(decimals, '0') || '0');
  }

  function formatUnits(value, decimals) {
    var unit = 10n ** BigInt(decimals);
    var whole = value / unit;
    var fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  function parseBtcToSats(text) {
    return parseUnits(text, SATS_DECIMALS);
  }

  function formatBtc(sats) {
    return formatUnits(sats, SATS_DECIMALS);
  }

  /* Fee rate in sat/vB. Stored as hundredths of a sat/vB so a fractional rate
   * (as some estimators return) stays exact; the fee itself is rounded up. */
  function parseFeeRate(text) {
    if (typeof text !== 'string') throw new Error('use a plain decimal number');
    var value = text.trim();
    if (!value) throw new Error('a fee rate is required');
    var match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value);
    if (!match) {
      throw new Error('use sat/vB like 2 or 1.5 (at most two decimal places)');
    }
    var hundredths = BigInt(match[1]) * 100n + BigInt((match[2] || '').padEnd(2, '0') || '0');
    if (hundredths <= 0n) throw new Error('the fee rate must be greater than zero');
    if (hundredths > MAX_FEE_RATE_HUNDREDTHS) throw new Error('the fee rate is too large');
    return hundredths;
  }

  function formatFeeRate(hundredths) {
    var whole = hundredths / 100n;
    var fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  /* ------------------------------------------------------------ bech32 */

  function bech32Polymod(values) {
    var generators = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3];
    var checksum = 1;
    for (var i = 0; i < values.length; i += 1) {
      var top = checksum >>> 25;
      checksum = ((checksum & 0x1ffffff) << 5) ^ values[i];
      for (var j = 0; j < 5; j += 1) {
        if ((top >>> j) & 1) checksum ^= generators[j];
      }
    }
    return checksum >>> 0;
  }

  function bech32HrpExpand(hrp) {
    var out = [];
    for (var i = 0; i < hrp.length; i += 1) out.push(hrp.charCodeAt(i) >>> 5);
    out.push(0);
    for (var j = 0; j < hrp.length; j += 1) out.push(hrp.charCodeAt(j) & 31);
    return out;
  }

  function convertBits(data, from, to, pad) {
    var acc = 0;
    var bits = 0;
    var out = [];
    var maxv = (1 << to) - 1;
    for (var i = 0; i < data.length; i += 1) {
      var value = data[i];
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

  /* Decode and validate a testnet v0 P2WPKH address. Returns the normalized
   * lower-case address and its 20-byte program. The WASM core rejects every
   * other output type, so the UI refuses them before review. */
  function decodeP2wpkh(text) {
    if (typeof text !== 'string') throw new Error('enter a tb1q address');
    var value = text.trim();
    if (!value) throw new Error('a destination address is required');
    if (value !== value.toLowerCase() && value !== value.toUpperCase()) {
      throw new Error('bech32 addresses cannot mix upper and lower case');
    }
    value = value.toLowerCase();
    var separator = value.lastIndexOf('1');
    if (separator < 1 || separator + 7 > value.length) {
      throw new Error('not a bech32 address');
    }
    var hrp = value.slice(0, separator);
    if (hrp !== 'tb') {
      throw new Error('only Bitcoin testnet tb1 addresses are supported (got "' + hrp + '1")');
    }
    var data = [];
    for (var i = separator + 1; i < value.length; i += 1) {
      var index = BECH32_CHARSET.indexOf(value.charAt(i));
      if (index < 0) throw new Error('invalid bech32 character');
      data.push(index);
    }
    if (data.length < 7) throw new Error('not a bech32 address');
    var expanded = bech32HrpExpand(hrp).concat(data);
    var check = bech32Polymod(expanded);
    if (check === 0x2bc830a3) {
      throw new Error('only witness v0 P2WPKH (tb1q) addresses are supported; ' +
        'this is a bech32m (v1+) address');
    }
    if (check !== 1) throw new Error('bech32 checksum mismatch');
    var payload = data.slice(0, data.length - 6);
    if (!payload.length) throw new Error('not a bech32 address');
    var version = payload[0];
    if (version !== 0) {
      throw new Error('only witness v0 P2WPKH (tb1q) addresses are supported');
    }
    var program;
    try {
      program = convertBits(payload.slice(1), 5, 8, false);
    } catch (err) {
      throw new Error('invalid witness program: ' + errorText(err));
    }
    if (program.length !== 20) {
      throw new Error('only P2WPKH addresses (20-byte program) are supported');
    }
    return {
      address: value,
      hrp: hrp,
      version: version,
      program: Uint8Array.from(program)
    };
  }

  function assertP2wpkhAddress(text, field) {
    try {
      return decodeP2wpkh(text).address;
    } catch (err) {
      throw new Error((field || 'Address') + ': ' + errorText(err));
    }
  }

  /* ------------------------------------------------------------- fees */

  /* P2WPKH virtual size:
   *   base  = 4 version + varint(in) + in*41 + varint(out) + out*31 + 4 locktime
   *   weight = base*4 + 2 marker/flag + in*(1 count + 1 len + 72 sig + 1 len + 33 pubkey)
   * The 72-byte signature is the conservative DER + sighash size. */
  function estimateVsize(inputCount, outputCount) {
    if (!Number.isInteger(inputCount) || inputCount < 1 || inputCount > MAX_INPUTS) {
      throw new Error('input count is out of range');
    }
    if (!Number.isInteger(outputCount) || outputCount < 1 || outputCount > 3) {
      throw new Error('output count is out of range');
    }
    var varint = function (n) { return n < 0xfd ? 1 : n <= 0xffff ? 3 : 5; };
    var base = 4 + varint(inputCount) + inputCount * 41 +
      varint(outputCount) + outputCount * 31 + 4;
    var weight = base * 4 + 2 + inputCount * 108;
    return Math.ceil(weight / 4);
  }

  function feeForVsize(vsize, rateHundredths) {
    return (BigInt(vsize) * rateHundredths + 99n) / 100n;
  }

  /* Deterministic largest-first selection. Ties break on txid then vout so the
   * same UTXO set always produces the same transaction. Change below the
   * P2WPKH dust limit is dropped into the fee. */
  function selectCoins(utxos, amountSats, rateHundredths) {
    if (!Array.isArray(utxos) || !utxos.length) {
      throw new Error('the address has no unspent outputs');
    }
    if (typeof amountSats !== 'bigint' || amountSats <= 0n) {
      throw new Error('the amount must be greater than zero');
    }
    if (typeof rateHundredths !== 'bigint' || rateHundredths <= 0n) {
      throw new Error('the fee rate must be greater than zero');
    }
    var sorted = utxos.map(function (utxo) {
      if (!utxo || typeof utxo !== 'object') throw new Error('invalid unspent output');
      var value = utxo.value;
      if (typeof value === 'number' && Number.isSafeInteger(value)) value = BigInt(value);
      if (typeof value !== 'bigint' || value <= 0n || value > MAX_MONEY) {
        throw new Error('an unspent output has an invalid value');
      }
      return { txid: utxo.txid, vout: utxo.vout, value: value, confirmed: !!utxo.confirmed };
    }).sort(function (a, b) {
      if (a.value !== b.value) return a.value > b.value ? -1 : 1;
      if (a.txid !== b.txid) return a.txid < b.txid ? -1 : 1;
      return a.vout - b.vout;
    });
    if (sorted.length > MAX_INPUTS) {
      throw new Error('too many unspent outputs (more than ' + MAX_INPUTS + ')');
    }

    var selected = [];
    var total = 0n;
    var lastNeed = 0n;
    for (var i = 0; i < sorted.length; i += 1) {
      selected.push(sorted[i]);
      total += sorted[i].value;
      var withChangeVsize = estimateVsize(selected.length, 2);
      var withChangeFee = feeForVsize(withChangeVsize, rateHundredths);
      lastNeed = amountSats + withChangeFee;
      if (total < lastNeed) continue;
      var change = total - amountSats - withChangeFee;
      if (change >= DUST_LIMIT) {
        return {
          selected: selected,
          total: total,
          fee: withChangeFee,
          change: change,
          vsize: withChangeVsize,
          dustToFee: 0n
        };
      }
      /* No non-dust change output: the remainder becomes the fee. */
      var noChangeVsize = estimateVsize(selected.length, 1);
      var minFee = feeForVsize(noChangeVsize, rateHundredths);
      var fee = total - amountSats;
      if (fee < minFee) continue;
      return {
        selected: selected,
        total: total,
        fee: fee,
        change: 0n,
        vsize: noChangeVsize,
        dustToFee: change
      };
    }

    var shortfall = lastNeed - total;
    throw new Error('insufficient funds: the address holds ' + total.toString() +
      ' sats, but this send needs ' + lastNeed.toString() +
      ' sats (' + shortfall.toString() + ' sats short, with ' +
      selected.length + ' inputs).');
  }

  /* ------------------------------------------------------- public reads */

  function normalizeUtxo(raw, index) {
    if (!raw || typeof raw !== 'object') {
      throw new Error('UTXO ' + index + ' is not an object');
    }
    if (typeof raw.txid !== 'string' || !/^[0-9a-fA-F]{64}$/.test(raw.txid)) {
      throw new Error('UTXO ' + index + ' has an invalid txid');
    }
    if (!Number.isInteger(raw.vout) || raw.vout < 0 || raw.vout > 0xffffffff) {
      throw new Error('UTXO ' + index + ' has an invalid vout');
    }
    var value;
    if (typeof raw.value === 'number') {
      if (!Number.isSafeInteger(raw.value) || raw.value <= 0) {
        throw new Error('UTXO ' + index + ' has an invalid value');
      }
      value = BigInt(raw.value);
    } else if (typeof raw.value === 'string' && /^\d+$/.test(raw.value)) {
      value = BigInt(raw.value);
    } else {
      throw new Error('UTXO ' + index + ' has an invalid value');
    }
    if (value > MAX_MONEY) throw new Error('UTXO ' + index + ' value is out of range');
    return {
      txid: raw.txid.toLowerCase(),
      vout: raw.vout,
      value: value,
      confirmed: !!(raw.status && raw.status.confirmed)
    };
  }

  function fetchUtxos(getJson, address) {
    if (typeof getJson !== 'function') throw new Error('the HTTP reader is unavailable');
    var url = API_BASE + '/address/' + encodeURIComponent(address) + '/utxo';
    return Promise.resolve(getJson(url)).then(function (body) {
      if (!Array.isArray(body)) throw new Error('the UTXO provider returned unexpected JSON');
      var seen = {};
      var utxos = body.map(function (raw, index) {
        var utxo = normalizeUtxo(raw, index);
        var key = utxo.txid + ':' + utxo.vout;
        if (seen[key]) throw new Error('the UTXO provider returned a duplicate outpoint');
        seen[key] = true;
        return utxo;
      });
      return utxos;
    });
  }

  function recommendedFeeRate(getJson) {
    if (typeof getJson !== 'function') throw new Error('the HTTP reader is unavailable');
    var url = API_BASE + '/v1/fees/recommended';
    return Promise.resolve(getJson(url)).then(function (body) {
      if (!body || typeof body !== 'object') {
        throw new Error('the fee estimator returned unexpected JSON');
      }
      var sources = [
        ['halfHourFee', 'half-hour'],
        ['fastestFee', 'fastest'],
        ['economyFee', 'economy'],
        ['minimumFee', 'minimum']
      ];
      for (var i = 0; i < sources.length; i += 1) {
        var value = body[sources[i][0]];
        if (value === undefined || value === null) continue;
        if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
          throw new Error('the fee estimator returned an invalid ' + sources[i][0]);
        }
        return {
          hundredths: BigInt(value) * 100n,
          satPerVb: value,
          source: 'mempool.space ' + sources[i][1] + ' (' + sources[i][0] + ' ' +
            value + ' sat/vB)'
        };
      }
      throw new Error('the fee estimator returned no usable rate');
    });
  }

  /* --------------------------------------------------------- validation */

  function validateForm(raw) {
    var input = raw || {};
    var errors = {};
    var values = { to: null, amountSats: null, feeRateHundredths: null };

    try {
      values.to = decodeP2wpkh(input.to).address;
    } catch (err) {
      errors.to = errorText(err);
    }

    try {
      var amountText = typeof input.amount === 'string' ? input.amount.trim() : '';
      var sats = parseBtcToSats(amountText);
      if (sats <= 0n) throw new Error('the amount must be greater than zero');
      if (sats > MAX_MONEY) throw new Error('the amount is too large');
      values.amountSats = sats;
    } catch (err) {
      errors.amount = errorText(err);
    }

    try {
      var rateText = typeof input.feeRate === 'string' ? input.feeRate.trim() : '';
      if (rateText) values.feeRateHundredths = parseFeeRate(rateText);
    } catch (err) {
      errors.feeRate = errorText(err);
    }

    return { errors: errors, values: values };
  }

  function assertChain(chain) {
    if (chain === 'bitcoin') {
      throw new Error('Bitcoin mainnet sending is disabled in this phase; use a Bitcoin testnet entry.');
    }
    if (chain !== CHAIN_SLUG) {
      throw new Error('only Bitcoin testnet entries can send in this phase');
    }
  }

  function assertHex(text, what) {
    if (typeof text !== 'string' || !text || text.length % 2 || !/^[0-9a-f]+$/.test(text)) {
      throw new Error('The local core returned an unexpected ' + what + '.');
    }
    return text;
  }

  function wasmText(wasm, pointer, length) {
    if (!pointer || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, pointer, length));
  }

  /* Call a wasm string entry point and erase the request afterwards.
   *
   * btc_sign_tx carries the private key as text. Parsing happens in wasm, but
   * the raw bytes stay in linear memory until the allocation is reused, so the
   * finally block zeroes the wasm copy and the JS `bytes` before deallocating.
   * It runs on success, rejection and traps; clear_result wipes the result. */
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

  /* --------------------------------------------------------------- prepare */

  /* options: { form, from, chain, getJson, unsigned(fields) -> hex } */
  async function prepareTransaction(options) {
    var settings = options || {};
    var validated = validateForm(settings.form);
    if (Object.keys(validated.errors).length) {
      var invalid = new Error('Fix the highlighted fields before review.');
      invalid.fieldErrors = validated.errors;
      throw invalid;
    }
    if (typeof settings.unsigned !== 'function') {
      throw new Error('The local unsigned-transaction builder is unavailable.');
    }
    assertChain(settings.chain);
    var from = assertP2wpkhAddress(settings.from, 'The vault address');

    var utxos = await fetchUtxos(settings.getJson, from);
    if (!utxos.length) {
      throw new Error('No unspent outputs at ' + from + ' on Bitcoin testnet; there is nothing to spend.');
    }

    var rateHundredths = validated.values.feeRateHundredths;
    var rateSource = 'manual';
    if (rateHundredths === null) {
      var recommended = await recommendedFeeRate(settings.getJson);
      rateHundredths = recommended.hundredths;
      rateSource = recommended.source;
    }

    var values = validated.values;
    var selection = selectCoins(utxos, values.amountSats, rateHundredths);
    var outputs = [{ address: values.to, value: values.amountSats.toString() }];
    if (selection.change > 0n) {
      outputs.push({ address: from, value: selection.change.toString() });
    }
    var request = {
      network: NETWORK,
      inputs: selection.selected.map(function (utxo) {
        return {
          txid: utxo.txid,
          vout: utxo.vout,
          value: utxo.value.toString(),
          sequence: SEQUENCE
        };
      }),
      outputs: outputs
    };

    var unsignedHex = assertHex(await Promise.resolve(settings.unsigned(request)),
      'unsigned transaction');

    var warnings = [];
    var unconfirmed = selection.selected.filter(function (utxo) { return !utxo.confirmed; });
    if (unconfirmed.length) {
      warnings.push(unconfirmed.length + ' selected input(s) are unconfirmed; the ' +
        'provider may reject a transaction that spends them.');
    }
    if (selection.dustToFee > 0n) {
      warnings.push('Change of ' + selection.dustToFee.toString() +
        ' sats is below the P2WPKH dust limit (' + DUST_LIMIT.toString() +
        ' sats) and was added to the fee.');
    }
    if (selection.selected.length > 1) {
      warnings.push('The send spends ' + selection.selected.length +
        ' inputs; all are signed with the same key.');
    }

    return {
      chain: CHAIN_SLUG,
      network: NETWORK,
      networkName: 'Bitcoin testnet',
      apiBase: API_BASE,
      from: from,
      to: values.to,
      amountSats: values.amountSats,
      feeSats: selection.fee,
      feeRateHundredths: rateHundredths,
      feeRateSource: rateSource,
      changeSats: selection.change,
      dustToFeeSats: selection.dustToFee,
      totalInputSats: selection.total,
      totalSpentSats: values.amountSats + selection.fee,
      vsize: selection.vsize,
      inputCount: selection.selected.length,
      outputCount: outputs.length,
      inputs: request.inputs,
      outputs: request.outputs,
      request: request,
      unsignedHex: unsignedHex,
      warnings: warnings
    };
  }

  /* --------------------------------------------------------------- confirm */

  /* options: { review, sign(request) -> signed hex, onSigned?(hex),
   *            broadcast(url, hex) -> txid } */
  async function confirmTransaction(options) {
    var settings = options || {};
    var review = settings.review;
    if (!review || typeof review !== 'object' || !review.request) {
      throw new Error('Prepare and review the transaction first.');
    }
    if (typeof settings.sign !== 'function') {
      throw new Error('Local signing is unavailable.');
    }
    if (typeof settings.broadcast !== 'function') {
      throw new Error('The broadcast transport is unavailable.');
    }
    if (review.network !== NETWORK) {
      throw new Error('Only Bitcoin testnet transactions can be signed in this phase.');
    }
    assertHex(review.unsignedHex, 'unsigned transaction');

    /* Rebuild the exact reviewed request; nothing outside the review can
     * change the destination, amount, inputs or outputs after review. */
    var request = {
      network: NETWORK,
      inputs: review.request.inputs.map(function (input) {
        return {
          txid: input.txid,
          vout: input.vout,
          value: input.value,
          sequence: input.sequence
        };
      }),
      outputs: review.request.outputs.map(function (output) {
        return { address: output.address, value: output.value };
      })
    };
    var signedHex = assertHex(await Promise.resolve(settings.sign(request)),
      'signed transaction');
    /* Show the signed bytes before they leave the tab, when the UI asks. */
    if (typeof settings.onSigned === 'function') {
      await Promise.resolve(settings.onSigned(signedHex));
    }
    var txid;
    try {
      txid = await Promise.resolve(settings.broadcast(API_BASE + '/tx', signedHex));
    } catch (err) {
      throw new Error('Broadcasting to mempool.space testnet failed: ' + errorText(err));
    }
    txid = typeof txid === 'string' ? txid.trim().toLowerCase() : '';
    if (!/^[0-9a-f]{64}$/.test(txid)) {
      throw new Error('mempool.space returned an unexpected transaction id.');
    }
    return {
      signedHex: signedHex,
      txid: txid,
      apiBase: API_BASE,
      explorerUrl: EXPLORER_TX + txid
    };
  }

  return {
    CHAIN_SLUG: CHAIN_SLUG,
    NETWORK: NETWORK,
    API_BASE: API_BASE,
    EXPLORER_ADDRESS: EXPLORER_ADDRESS,
    EXPLORER_TX: EXPLORER_TX,
    DUST_LIMIT: DUST_LIMIT,
    SATS_DECIMALS: SATS_DECIMALS,
    parseUnits: parseUnits,
    formatUnits: formatUnits,
    parseBtcToSats: parseBtcToSats,
    formatBtc: formatBtc,
    parseFeeRate: parseFeeRate,
    formatFeeRate: formatFeeRate,
    decodeP2wpkh: decodeP2wpkh,
    assertP2wpkhAddress: assertP2wpkhAddress,
    estimateVsize: estimateVsize,
    feeForVsize: feeForVsize,
    selectCoins: selectCoins,
    fetchUtxos: fetchUtxos,
    recommendedFeeRate: recommendedFeeRate,
    validateForm: validateForm,
    assertChain: assertChain,
    callWasmString: callWasmString,
    prepareTransaction: prepareTransaction,
    confirmTransaction: confirmTransaction
  };
});
