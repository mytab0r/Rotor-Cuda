/* Rotor Bitcoin puzzle scan worker.
 *
 * Classic Web Worker (no imports, no build step). It loads the committed
 * /rotor_wasm.wasm artifact, configures one Bitcoin P2PKH target with the
 * compressed flag, and scans slices of the puzzle range.
 *
 * Modes:
 *   random - each slice starts at a uniformly random position in the range.
 *   seq    - scan the assigned [start, end] window linearly from start.
 *
 * Message contract (page -> worker):
 *   { type: 'start', target, mode, start, end, sliceKeys? }
 *   { type: 'stop' }
 * `start` and `end` are inclusive hex scalars (the puzzle range is inclusive).
 *
 * Worker -> page:
 *   { type: 'state', wasm: 'ready' }
 *   { type: 'stats', generated, rate, wasm }
 *   { type: 'match', key, address, generated, rate }
 *   { type: 'done', generated, rate }
 *   { type: 'error', message }
 *
 * Nothing is sent over the network from here; the page owns the public target
 * address and the wasm artifact is served from its own origin.
 */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var SLICE_START_KEYS = 32768;
  var SLICE_MIN_KEYS = 8192;
  var SLICE_MAX_KEYS = 262144;
  var SLICE_STEP_KEYS = 4096;
  var SLICE_TARGET_MS = 180;
  var STATS_MS = 400;

  var decoder = new TextDecoder('utf-8');
  var running = false;
  var wasm = null;
  var wasmPromise = null;
  var scalarStartPtr = 0;
  var scalarEndPtr = 0;
  var scalarsReady = false;
  var configKey = '';

  var mode = 'random';
  var targetAddress = '';
  var rangeStart = 0n;
  var rangeEnd = 0n;
  var baseSliceKeys = SLICE_START_KEYS;

  var totalScanned = 0;
  var activeMs = 0;
  var lastStatsAt = 0;
  var sleepers = [];

  /* ------------------------------------------------------------- utilities */

  function now() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function sleep(ms) {
    return new Promise(function (resolve) {
      var finished = false;
      var entry = function () {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        var index = sleepers.indexOf(entry);
        if (index >= 0) sleepers.splice(index, 1);
        resolve();
      };
      var timer = setTimeout(entry, ms);
      sleepers.push(entry);
    });
  }

  function wake() {
    var pending = sleepers.slice();
    sleepers.length = 0;
    for (var i = 0; i < pending.length; i++) pending[i]();
  }

  function post(type, payload) {
    var message = { type: type };
    if (payload) {
      for (var key in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, key)) message[key] = payload[key];
      }
    }
    self.postMessage(message);
  }

  function fail(err) {
    running = false;
    post('error', { message: err && err.message ? err.message : String(err) });
  }

  function parseHex(value) {
    var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (text.slice(0, 2) === '0x') text = text.slice(2);
    if (!/^[0-9a-f]{1,64}$/.test(text)) throw new Error('invalid hex scalar');
    return BigInt('0x' + text);
  }

  function padHex(value) {
    var text = value.toString(16);
    while (text.length < 64) text = '0' + text;
    return text;
  }

  /* ------------------------------------------------------------------ wasm */

  function loadWasm() {
    if (wasmPromise) return wasmPromise;
    wasmPromise = (async function () {
      var response;
      try {
        response = await fetch(WASM_URL);
      } catch (err) {
        throw new Error('cannot load ' + WASM_URL + ': ' + (err && err.message ? err.message : String(err)));
      }
      if (!response.ok) throw new Error('cannot load ' + WASM_URL + ': HTTP ' + response.status);

      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        var bytes = await response.arrayBuffer();
        module = await WebAssembly.instantiate(bytes, {});
      }
      var exports = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'set_job', 'scan', 'result_ptr', 'result_len', 'error_ptr', 'error_len'];
      for (var i = 0; i < required.length; i++) {
        if (typeof exports[required[i]] !== 'function') {
          throw new Error('wasm artifact is missing the "' + required[i] + '" export');
        }
      }
      if (!exports.memory) throw new Error('wasm artifact does not export memory');
      wasm = exports;
      return wasm;
    })();
    wasmPromise.catch(function () { wasmPromise = null; });
    return wasmPromise;
  }

  function wasmAlloc(length) {
    var ptr = wasm.alloc(length) >>> 0;
    if (!ptr) throw new Error('wasm memory exhausted (requested ' + length + ' bytes)');
    return ptr;
  }

  function wasmErrorText() {
    try {
      var ptr = wasm.error_ptr() >>> 0;
      var len = wasm.error_len() >>> 0;
      if (!len) return '';
      return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, len));
    } catch (err) {
      return '';
    }
  }

  function checkStatus(status, what) {
    if (status === 0) return;
    var detail = wasmErrorText();
    throw new Error(what + ' failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
  }

  function configureTarget(address) {
    if (!address) throw new Error('missing puzzle target address');
    if (configKey === address) return;
    var bytes = new TextEncoder().encode(address);
    var ptr = wasmAlloc(bytes.length);
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
    try {
      // mode 0 = BTC address, comp 0 = compressed (puzzle targets use
      // compressed public keys, verified with puzzle #1 and #71 targets).
      checkStatus(wasm.set_job(0, 0, ptr, bytes.length), 'wasm set_job');
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
    configKey = address;
  }

  function writeScalar(ptr, value) {
    var text = padHex(value);
    var bytes = new Uint8Array(wasm.memory.buffer);
    for (var i = 0; i < 32; i++) {
      bytes[ptr + i] = parseInt(text.substr(i * 2, 2), 16);
    }
  }

  function ensureScalars() {
    if (scalarsReady) return;
    scalarStartPtr = wasmAlloc(32);
    scalarEndPtr = wasmAlloc(32);
    scalarsReady = true;
  }

  function readResult() {
    var ptr = wasm.result_ptr() >>> 0;
    var len = wasm.result_len() >>> 0;
    var view = new DataView(wasm.memory.buffer);
    if (len < 12) throw new Error('wasm scan result is truncated');

    var low = view.getUint32(ptr, true);
    var high = view.getUint32(ptr + 4, true);
    var scanned = high * 4294967296 + low;
    var found = view.getUint32(ptr + 8, true) !== 0;
    var result = { scanned: scanned, found: found, key: '', address: '' };
    if (!found) return result;

    var cursor = 12;
    if (cursor + 4 > len) throw new Error('wasm scan result is truncated');
    var keyLen = view.getUint32(ptr + cursor, true);
    cursor += 4;
    if (cursor + keyLen > len) throw new Error('wasm scan result is truncated');
    result.key = decoder.decode(new Uint8Array(wasm.memory.buffer, ptr + cursor, keyLen));
    cursor += keyLen;
    if (cursor + 4 > len) throw new Error('wasm scan result is truncated');
    var addressLen = view.getUint32(ptr + cursor, true);
    cursor += 4;
    if (cursor + addressLen > len) throw new Error('wasm scan result is truncated');
    result.address = decoder.decode(new Uint8Array(wasm.memory.buffer, ptr + cursor, addressLen));
    return result;
  }

  /* ---------------------------------------------------------------- scanning */

  function scanSlice(startInclusive, size) {
    ensureScalars();
    var endExclusive = startInclusive + BigInt(size);
    writeScalar(scalarStartPtr, startInclusive);
    writeScalar(scalarEndPtr, endExclusive);

    var started = now();
    checkStatus(wasm.scan(scalarStartPtr, scalarEndPtr), 'wasm scan');
    activeMs += Math.max(0, now() - started);

    var result = readResult();
    if (result.scanned < 0 || result.scanned > size) {
      throw new Error('wasm scan reported ' + result.scanned + ' keys for a ' + size + '-key slice');
    }
    return result;
  }

  function sliceForRate(rate) {
    if (!isFinite(rate) || rate <= 0) return SLICE_START_KEYS;
    var keys = Math.floor((rate * SLICE_TARGET_MS) / SLICE_STEP_KEYS) * SLICE_STEP_KEYS;
    if (keys < SLICE_MIN_KEYS) return SLICE_MIN_KEYS;
    if (keys > SLICE_MAX_KEYS) return SLICE_MAX_KEYS;
    return keys;
  }

  function nextSlice(keys, scanned, elapsedMs) {
    if (scanned > 0 && elapsedMs > 0) return sliceForRate(scanned / (elapsedMs / 1000));
    var rate = currentRate();
    return rate > 0 ? sliceForRate(rate) : SLICE_START_KEYS;
  }

  function currentRate() {
    return activeMs > 0 ? totalScanned / (activeMs / 1000) : 0;
  }

  /* Uniform BigInt in [0, maxExclusive) via rejection sampling on 32-bit words. */
  function randomOffset(maxExclusive) {
    if (maxExclusive <= 0n) return 0n;
    var bits = (maxExclusive - 1n).toString(2).length;
    var words = Math.max(1, Math.ceil(bits / 32));
    var excess = BigInt(words * 32 - bits);
    var buffer = new Uint32Array(words);
    for (;;) {
      if (self.crypto && typeof self.crypto.getRandomValues === 'function') {
        self.crypto.getRandomValues(buffer);
      } else {
        for (var i = 0; i < words; i++) buffer[i] = Math.floor(Math.random() * 4294967296);
      }
      var value = 0n;
      for (var j = 0; j < words; j++) value = (value << 32n) | BigInt(buffer[j]);
      if (excess > 0n) value >>= excess;
      if (value < maxExclusive) return value;
    }
  }

  function postStats(force) {
    var at = now();
    if (!force && at - lastStatsAt < STATS_MS) return;
    lastStatsAt = at;
    post('stats', {
      generated: totalScanned,
      rate: currentRate(),
      wasm: 'ready'
    });
  }

  function postMatch(result) {
    running = false;
    post('stats', { generated: totalScanned, rate: 0, wasm: 'ready' });
    post('match', {
      key: result.key,
      address: result.address,
      generated: totalScanned,
      rate: 0
    });
  }

  async function runRandom() {
    var span = rangeEnd - rangeStart + 1n;
    var sliceKeys = baseSliceKeys;
    while (running) {
      var sliceStart = rangeStart + randomOffset(span);
      var available = rangeEnd - sliceStart + 1n;
      var size = available < BigInt(sliceKeys) ? Number(available) : sliceKeys;
      var started = now();
      var result = scanSlice(sliceStart, size);
      var elapsed = now() - started;
      totalScanned += result.scanned;
      if (result.found) {
        postMatch(result);
        return;
      }
      if (result.scanned === 0) throw new Error('wasm scan made no progress');
      sliceKeys = nextSlice(sliceKeys, result.scanned, elapsed);
      postStats(false);
      await sleep(0);
    }
  }

  async function runSequential() {
    var cursor = rangeStart;
    var endExclusive = rangeEnd + 1n;
    var sliceKeys = baseSliceKeys;
    while (running && cursor < endExclusive) {
      var remaining = endExclusive - cursor;
      var size = remaining < BigInt(sliceKeys) ? Number(remaining) : sliceKeys;
      var started = now();
      var result = scanSlice(cursor, size);
      var elapsed = now() - started;
      totalScanned += result.scanned;
      cursor += BigInt(result.scanned);
      if (result.found) {
        postMatch(result);
        return;
      }
      if (result.scanned === 0) throw new Error('wasm scan made no progress');
      sliceKeys = nextSlice(sliceKeys, result.scanned, elapsed);
      postStats(false);
      await sleep(0);
    }
    if (!running) return;
    running = false;
    postStats(true);
    post('done', { generated: totalScanned, rate: 0 });
  }

  async function run() {
    try {
      await loadWasm();
      post('state', { wasm: 'ready' });
      if (!running) return;
      configureTarget(targetAddress);
      if (mode === 'seq') await runSequential();
      else await runRandom();
    } catch (err) {
      if (!running) return;
      fail(err);
    }
  }

  /* --------------------------------------------------------------- control */

  self.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === 'stop') {
      running = false;
      wake();
      return;
    }
    if (message.type !== 'start') return;
    if (running) return;

    try {
      targetAddress = String(message.target || '');
      mode = message.mode === 'seq' ? 'seq' : 'random';
      rangeStart = parseHex(message.start);
      rangeEnd = parseHex(message.end);
      if (rangeEnd < rangeStart) throw new Error('empty puzzle range');
      var wanted = Number(message.sliceKeys);
      baseSliceKeys = isFinite(wanted) && wanted > 0
        ? Math.max(SLICE_MIN_KEYS, Math.min(SLICE_MAX_KEYS, Math.floor(wanted)))
        : SLICE_START_KEYS;

      totalScanned = 0;
      activeMs = 0;
      lastStatsAt = 0;
      running = true;
      run();
    } catch (err) {
      fail(err);
    }
  };
})();
