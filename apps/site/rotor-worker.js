/* Rotor browser worker.
 *
 * Leases coordinator chunks over the JSON API and scans them with the Rust
 * wasm artifact at /rotor_wasm.wasm. Classic worker script: no imports, no
 * build step, no framework. The page owns localStorage and passes the token
 * in the start message; this worker keeps it in a variable only.
 */
(function () {
  'use strict';

  /* The worker is started from `/a/<build>/rotor-worker.js`; derive the build
   * from its own URL so the wasm fetch stays immutable too. */
  function assetUrl(path) {
    var match = self.location && /^\/a\/([^/]+)\//.exec(self.location.pathname);
    return match ? '/a/' + match[1] + path : path;
  }

  var WASM_URL = assetUrl('/rotor_wasm.wasm');
  // One slice is sized for roughly SLICE_TARGET_SECONDS of work so a progress
  // heartbeat is not delayed by a long scan on a slow phone. The next size is
  // re-derived from the measured per-slice rate after every call.
  var SLICE_START_KEYS = 65536;
  var SLICE_MIN_KEYS = 16384;
  var SLICE_MAX_KEYS = 262144;
  var SLICE_STEP_KEYS = 2048;
  var SLICE_TARGET_SECONDS = 2;
  var PROGRESS_MS = 2000;
  var MAX_TARGETS = 50000;
  var LEASE_RETRY_MS = 3000;
  var NO_JOB_RETRY_MS = 10000;
  var RATE_LIMIT_MS = 5000;
  var NETWORK_RETRY_MS = 2000;
  var MAX_NETWORK_RETRIES = 4;

  var token = '';
  var clientId = '';
  var preferredJobId = '';
  var running = false;
  var startedOnce = false;

  var wasm = null;
  var wasmPromise = null;
  var scalarStartPtr = 0;
  var scalarEndPtr = 0;
  var scalarChunkPtr = 0;
  var scalarsReady = false;

  var job = null;
  var lease = null;
  var chunk = null;
  var configKey = '';
  var matches = 0;

  var sleepers = [];
  var decoder = new TextDecoder('utf-8');

  /* ---------------------------------------------------------------- messages */

  function merge(base, extra) {
    if (extra) {
      for (var key in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, key)) base[key] = extra[key];
      }
    }
    return base;
  }

  function post(type, payload) {
    self.postMessage(merge({ type: type }, payload));
  }

  function postState(phase, extra) {
    post('state', merge({ phase: phase }, extra));
  }

  function log(message) {
    post('log', { message: String(message) });
  }

  function fail(message) {
    running = false;
    post('error', { message: String(message) });
    postState('error');
  }

  /* ------------------------------------------------------------ small helpers */

  function nowMs() {
    if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  function nowSec() {
    return Math.floor(Date.now() / 1000);
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

  function stopError() {
    var err = new Error('stopped');
    err.stop = true;
    return err;
  }

  function ensureRunning() {
    if (!running) throw stopError();
  }

  function fallbackClientId() {
    var out = 'web-';
    for (var i = 0; i < 16; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }

  function authMessage(status) {
    if (status === 401) {
      return 'The coordinator rejected this token. Open the cabinet and paste a valid client token.';
    }
    return 'This token is not allowed to lease work. Use a client token created in the cabinet.';
  }

  function describe(response) {
    if (response && response.data && typeof response.data.error === 'string' && response.data.error) {
      return response.data.error;
    }
    if (response && typeof response.status === 'number') return 'HTTP ' + response.status;
    return 'unknown error';
  }

  /* ------------------------------------------------------------------- wasm */

  function loadWasm() {
    if (wasmPromise) return wasmPromise;
    wasmPromise = (async function () {
      postState('loading-wasm');
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
      var required = ['alloc', 'dealloc', 'set_job', 'scan', 'samples', 'result_ptr', 'result_len', 'error_ptr', 'error_len'];
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
    // A zero pointer means the wasm allocator failed; address 0 holds statics.
    if (!ptr) throw new Error('wasm memory exhausted (requested ' + length + ' bytes)');
    return ptr;
  }

  function writeBytes(ptr, bytes) {
    new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
  }

  function readString(ptr, length) {
    if (!length) return '';
    return decoder.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function wasmErrorText() {
    try {
      var ptr = wasm.error_ptr() >>> 0;
      var len = wasm.error_len() >>> 0;
      return readString(ptr, len);
    } catch (err) {
      return '';
    }
  }

  function checkStatus(status, what) {
    if (status === 0) return;
    var detail = wasmErrorText();
    throw new Error(what + ' failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
  }

  function normalizeScalar(hex) {
    var text = String(hex === undefined || hex === null ? '' : hex).trim().toLowerCase();
    if (text.slice(0, 2) === '0x') text = text.slice(2);
    if (!text || !/^[0-9a-f]+$/.test(text)) throw new Error('invalid hex scalar');
    if (text.length > 64) throw new Error('hex scalar is wider than 32 bytes');
    while (text.length < 64) text = '0' + text;
    return text;
  }

  function bigFromHex(hex) {
    return BigInt('0x' + normalizeScalar(hex));
  }

  function hexFromBig(value) {
    var text = value.toString(16);
    while (text.length < 64) text = '0' + text;
    return text;
  }

  function writeScalar(ptr, hex) {
    var text = normalizeScalar(hex);
    var bytes = new Uint8Array(wasm.memory.buffer);
    for (var i = 0; i < 32; i++) {
      bytes[ptr + i] = parseInt(text.substr(i * 2, 2), 16);
    }
  }

  function ensureScalarBuffers() {
    if (scalarsReady) return;
    scalarStartPtr = wasmAlloc(32);
    scalarEndPtr = wasmAlloc(32);
    scalarChunkPtr = wasmAlloc(32);
    scalarsReady = true;
  }

  /* -------------------------------------------------------------- job helpers */

  function jobTargets(entry) {
    var targets = [];
    if (entry && typeof entry.target === 'string' && entry.target.trim()) {
      targets.push(entry.target.trim());
    }
    if (entry && Array.isArray(entry.targets)) {
      for (var i = 0; i < entry.targets.length; i++) {
        var value = entry.targets[i];
        if (typeof value === 'string' && value.trim()) targets.push(value.trim());
      }
    }
    return targets;
  }

  function supportReason(entry) {
    if (!entry || typeof entry.id !== 'string' || !entry.id) return 'invalid job';
    if (entry.found) return 'found';
    if (entry.done) return 'done';
    var coin = String(entry.coin || 'btc').toLowerCase();
    var mode = String(entry.mode || '').toLowerCase();
    var supported = coin === 'btc'
      ? (mode === 'address' || mode === 'addresses' || mode === 'xpoint' || mode === 'xpoints')
      : coin === 'eth' && (mode === 'address' || mode === 'addresses');
    if (!supported) return 'mode ' + mode + '/' + coin + ' is not supported in the browser';
    var targets = jobTargets(entry);
    if (!targets.length) return 'no targets';
    if (targets.length > MAX_TARGETS) {
      return targets.length + ' targets (the browser limit is ' + MAX_TARGETS + ')';
    }
    var width = entry.chunk_width === undefined || entry.chunk_width === null
      ? NaN
      : Number(entry.chunk_width);
    if (!isFinite(width) || width <= 0) return 'job has no usable chunk width';
    // A single lease wider than 2^32 keys cannot be scanned before it expires.
    if (width > 4294967296) return 'chunk width ' + width + ' is too wide for a browser';
    return '';
  }

  function jobSummary(entry) {
    return {
      id: entry.id,
      mode: entry.mode,
      coin: entry.coin,
      comp_mode: entry.comp_mode,
      done: !!entry.done,
      found: !!entry.found,
      chunks_total: Number(entry.chunks_total || 0),
      chunks_done: Number(entry.chunks_done || 0),
      chunks_leased: Number(entry.chunks_leased || 0),
      scanned: Number(entry.scanned || 0),
      reason: supportReason(entry)
    };
  }

  function compModeId(value) {
    var text = String(value || 'compressed').trim().toLowerCase();
    if (text === 'uncompressed') return 1;
    if (text === 'both') return 2;
    return 0;
  }

  function configureWasm(entry) {
    var coin = String(entry.coin || 'btc').toLowerCase();
    var modeName = String(entry.mode || '').toLowerCase();
    var mode;
    var comp;
    if (coin === 'eth') {
      mode = 2;
      comp = 1;
    } else if (modeName === 'xpoint' || modeName === 'xpoints') {
      mode = 1;
      comp = 0;
    } else {
      mode = 0;
      comp = compModeId(entry.comp_mode);
    }

    var targets = jobTargets(entry);
    var text = targets.join('\n');
    var key = entry.id + '|' + mode + '|' + comp + '|' + text.length;
    if (configKey === key) return;

    var bytes = new TextEncoder().encode(text);
    var ptr = wasmAlloc(bytes.length);
    writeBytes(ptr, bytes);
    try {
      checkStatus(wasm.set_job(mode, comp, ptr, bytes.length), 'wasm set_job');
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
    configKey = key;
  }

  /* ------------------------------------------------------------------- HTTP */

  /* `Retry-After` is either delta-seconds or an HTTP date. The coordinator
   * sends seconds; anything unparsable falls back to the normal rate-limit
   * wait, and zero is raised to one second so a retry loop cannot spin. */
  function retryAfterMs(response) {
    var value = null;
    try {
      if (response && response.headers && typeof response.headers.get === 'function') {
        value = response.headers.get('Retry-After');
      }
    } catch (err) {
      value = null;
    }
    if (value !== null && value !== undefined && String(value).trim() !== '') {
      var seconds = Number(value);
      if (isFinite(seconds) && seconds >= 0) return Math.max(1000, Math.round(seconds * 1000));
    }
    return RATE_LIMIT_MS;
  }

  async function api(path, options) {
    var settings = options || {};
    var attempts = 0;

    for (;;) {
      if (settings.abortable !== false && !running) throw stopError();

      var headers = { Authorization: 'Bearer ' + token };
      var hasBody = settings.bodyText !== undefined || settings.body !== undefined;
      if (hasBody) headers['Content-Type'] = 'application/json';

      var response;
      try {
        response = await fetch(path, {
          method: settings.method || 'GET',
          headers: headers,
          body: hasBody
            ? (settings.bodyText !== undefined ? settings.bodyText : JSON.stringify(settings.body))
            : undefined
        });
      } catch (err) {
        attempts += 1;
        if (attempts > MAX_NETWORK_RETRIES) {
          throw new Error('network error: ' + (err && err.message ? err.message : String(err)));
        }
        postState('retrying', { message: 'network error, retrying (' + attempts + '/' + MAX_NETWORK_RETRIES + ')' });
        await sleep(NETWORK_RETRY_MS * attempts);
        continue;
      }

      if (response.status === 429 && settings.retry429) {
        var delayMs = retryAfterMs(response);
        postState('retrying', {
          message: 'rate limited; retrying in ' + Math.round(delayMs / 1000) + ' s'
        });
        await sleep(delayMs);
        continue;
      }

      if (response.status >= 500) {
        attempts += 1;
        if (attempts > MAX_NETWORK_RETRIES) {
          throw new Error('coordinator error: HTTP ' + response.status);
        }
        postState('retrying', { message: 'coordinator error, retrying (' + attempts + '/' + MAX_NETWORK_RETRIES + ')' });
        await sleep(NETWORK_RETRY_MS * attempts);
        continue;
      }

      var text = await response.text();
      var data = null;
      if (text) {
        try {
          data = JSON.parse(text);
        } catch (err) {
          data = null;
        }
      }
      return { status: response.status, data: data, text: text };
    }
  }

  function jsonBody(parts) {
    var pieces = [];
    for (var i = 0; i < parts.length; i++) {
      var name = parts[i][0];
      var value = parts[i][1];
      var encoded;
      if (value && typeof value === 'object' && value.raw !== undefined) encoded = String(value.raw);
      else encoded = JSON.stringify(value);
      pieces.push(JSON.stringify(name) + ':' + encoded);
    }
    return '{' + pieces.join(',') + '}';
  }

  /* The server sends lease_id as a JSON number, but it is a random u64 and
   * JSON.parse would round it above 2^53. Keep the exact digits from the raw
   * body and echo them unquoted in heartbeat/result bodies. */
  function extractLeaseId(text) {
    var match = /"lease_id"\s*:\s*(\d+)/.exec(text || '');
    return match ? match[1] : '';
  }

  /* ------------------------------------------------------------- coordinator */

  async function pickJob() {
    postState('loading-jobs');
    var res = await api('/api/v1/jobs', { method: 'GET', retry429: true });
    if (res.status === 401 || res.status === 403) throw new Error(authMessage(res.status));
    if (res.status !== 200) throw new Error('cannot list jobs: ' + describe(res));

    var list = res.data && Array.isArray(res.data.jobs) ? res.data.jobs : [];
    var summaries = [];
    var chosen = null;
    var selected = '';
    var i;

    for (i = 0; i < list.length; i++) summaries.push(jobSummary(list[i]));

    if (preferredJobId) {
      for (i = 0; i < list.length; i++) {
        if (list[i].id === preferredJobId && !summaries[i].reason) {
          chosen = list[i];
          selected = list[i].id;
          break;
        }
      }
    }
    if (!chosen) {
      for (i = 0; i < list.length; i++) {
        if (!summaries[i].reason) {
          chosen = list[i];
          selected = list[i].id;
          break;
        }
      }
    }

    postState('jobs', { jobs: summaries, selected: selected });
    return chosen;
  }

  async function leaseChunk() {
    postState('leasing', { job: jobSummary(job) });
    var body = {
      client_id: clientId,
      job_id: job.id,
      mode: job.mode,
      coin: job.coin || 'btc',
      start: job.start,
      end: job.end
    };
    var targets = jobTargets(job);
    if (targets.length === 1) body.target = targets[0];

    var res = await api('/api/v1/lease', { method: 'POST', body: body });
    if (res.status === 200 && res.data) {
      var rawId = extractLeaseId(res.text);
      if (!rawId) throw new Error('lease response has no lease_id');
      return { lease: merge(merge({}, res.data), { lease_id_text: rawId }) };
    }
    if (res.status === 204) {
      return { retry: true, delay: LEASE_RETRY_MS, message: 'no chunk available; retrying' };
    }
    if (res.status === 404) {
      // No job matches this mode/coin/range. Retrying every 3 s would hammer
      // the coordinator, so back off and point at the likely operator fix.
      return {
        retry: true,
        delay: NO_JOB_RETRY_MS,
        message: 'no matching job; check the job mode/target with the operator'
      };
    }
    if (res.status === 401 || res.status === 403) throw new Error(authMessage(res.status));
    if (res.status === 429) {
      return { retry: true, delay: RATE_LIMIT_MS, message: 'rate limited; backing off' };
    }
    throw new Error('lease failed: ' + describe(res));
  }

  /* ---------------------------------------------------------------- scanning */

  function startChunk(granted) {
    ensureScalarBuffers();
    var startBig = bigFromHex(granted.start);
    var endExclusive = bigFromHex(granted.end) + BigInt(1);
    if (endExclusive <= startBig) throw new Error('lease returned an empty range');

    var spanBig = endExclusive - startBig;
    if (spanBig > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('lease range is too wide for this client');
    }

    var offsets = Array.isArray(granted.challenge_offsets) ? granted.challenge_offsets.slice(0) : [];
    if (!offsets.length) throw new Error('lease has no challenge offsets');

    lease = {
      job_id: String(granted.job_id),
      chunk_index: Number(granted.chunk_index),
      lease_id: String(granted.lease_id_text),
      start: String(granted.start),
      end: String(granted.end),
      expires_at: Number(granted.expires_at),
      challenge_offsets: offsets
    };

    writeScalar(scalarChunkPtr, lease.start);
    chunk = {
      startBig: startBig,
      span: Number(spanBig),
      scanned: 0,
      sliceKeys: SLICE_START_KEYS,
      lastHeartbeat: nowMs(),
      activeMs: 0,
      segmentStart: nowMs()
    };
  }

  function pauseTiming() {
    if (chunk && chunk.segmentStart) {
      chunk.activeMs += nowMs() - chunk.segmentStart;
      chunk.segmentStart = 0;
    }
  }

  function resumeTiming() {
    if (chunk && !chunk.segmentStart) chunk.segmentStart = nowMs();
  }

  function currentRate() {
    if (!chunk) return 0;
    var elapsed = chunk.activeMs + (chunk.segmentStart ? nowMs() - chunk.segmentStart : 0);
    if (!(elapsed > 0)) return 0;
    var rate = chunk.scanned / (elapsed / 1000);
    return isFinite(rate) ? rate : 0;
  }

  function readScanResult() {
    var ptr = wasm.result_ptr() >>> 0;
    var len = wasm.result_len() >>> 0;
    var view = new DataView(wasm.memory.buffer);
    if (len < 12) throw new Error('wasm scan result is truncated');

    var low = view.getUint32(ptr, true);
    var high = view.getUint32(ptr + 4, true);
    var scanned = high * 4294967296 + low;
    var found = view.getUint32(ptr + 8, true) !== 0;
    var result = { scanned: scanned, found: found, key: '', address: '' };

    if (found) {
      var cursor = 12;
      if (cursor + 4 > len) throw new Error('wasm scan result is truncated');
      var keyLen = view.getUint32(ptr + cursor, true);
      cursor += 4;
      if (cursor + keyLen > len) throw new Error('wasm scan result is truncated');
      result.key = readString(ptr + cursor, keyLen);
      cursor += keyLen;

      if (cursor + 4 > len) throw new Error('wasm scan result is truncated');
      var addressLen = view.getUint32(ptr + cursor, true);
      cursor += 4;
      if (cursor + addressLen > len) throw new Error('wasm scan result is truncated');
      result.address = readString(ptr + cursor, addressLen);
    }
    return result;
  }

  function scanSlice() {
    var remaining = chunk.span - chunk.scanned;
    if (remaining <= 0) throw new Error('scan requested on a completed chunk');

    var size = Math.min(chunk.sliceKeys, remaining);
    var sliceStart = chunk.startBig + BigInt(chunk.scanned);
    var sliceEnd = sliceStart + BigInt(size);
    writeScalar(scalarStartPtr, hexFromBig(sliceStart));
    writeScalar(scalarEndPtr, hexFromBig(sliceEnd));

    var sliceStarted = nowMs();
    checkStatus(wasm.scan(scalarStartPtr, scalarEndPtr), 'wasm scan');
    var sliceMs = nowMs() - sliceStarted;
    var result = readScanResult();
    if (result.scanned < 0 || result.scanned > size) {
      throw new Error('wasm scan reported ' + result.scanned + ' keys for a ' + size + '-key slice');
    }
    if (result.scanned === 0 && !result.found) throw new Error('wasm scan made no progress');

    chunk.scanned += result.scanned;
    if (chunk.scanned > chunk.span) throw new Error('wasm scan advanced past the lease end');
    chunk.sliceKeys = nextSliceKeys(result.scanned, sliceMs);
    return result;
  }

  /* Size the next slice for roughly SLICE_TARGET_SECONDS of measured work,
   * rounded down to a multiple of SLICE_STEP_KEYS, and clamped for both a slow
   * phone and a fast desktop. */
  function sliceKeysForRate(rate) {
    if (!isFinite(rate) || rate <= 0) return SLICE_START_KEYS;
    var keys = Math.floor((rate * SLICE_TARGET_SECONDS) / SLICE_STEP_KEYS) * SLICE_STEP_KEYS;
    if (keys < SLICE_MIN_KEYS) return SLICE_MIN_KEYS;
    if (keys > SLICE_MAX_KEYS) return SLICE_MAX_KEYS;
    return keys;
  }

  function nextSliceKeys(keys, elapsedMs) {
    if (keys > 0 && elapsedMs > 0) return sliceKeysForRate(keys / (elapsedMs / 1000));
    // A coarse clock may report no time for a short slice; fall back to the
    // chunk-wide measured rate, and keep the current size if even that is 0.
    var rate = currentRate();
    if (rate > 0) return sliceKeysForRate(rate);
    return SLICE_START_KEYS;
  }

  function buildSamples() {
    var offsets = lease.challenge_offsets;
    if (offsets.length > 4096) throw new Error('lease returned too many challenge offsets');

    var ptr = wasmAlloc(offsets.length * 4);
    var view = new DataView(wasm.memory.buffer);
    for (var i = 0; i < offsets.length; i++) {
      view.setUint32(ptr + i * 4, offsets[i] >>> 0, true);
    }

    try {
      checkStatus(wasm.samples(scalarChunkPtr, ptr, offsets.length), 'wasm samples');
    } finally {
      wasm.dealloc(ptr, offsets.length * 4);
    }
    var resultPtr = wasm.result_ptr() >>> 0;
    var resultLen = wasm.result_len() >>> 0;
    var rview = new DataView(wasm.memory.buffer);
    if (resultLen < 4) throw new Error('wasm samples result is truncated');

    var count = rview.getUint32(resultPtr, true);
    if (count !== offsets.length) {
      throw new Error('wasm returned ' + count + ' samples for ' + offsets.length + ' offsets');
    }

    var cursor = 4;
    var samples = [];
    for (var j = 0; j < count; j++) {
      if (cursor + 4 > resultLen) throw new Error('wasm samples result is truncated');
      var length = rview.getUint32(resultPtr + cursor, true);
      cursor += 4;
      if (cursor + length > resultLen) throw new Error('wasm samples result is truncated');
      var bytes = new Uint8Array(wasm.memory.buffer, resultPtr + cursor, length);
      var sample = new Array(length);
      for (var k = 0; k < length; k++) sample[k] = bytes[k];
      samples.push(sample);
      cursor += length;
    }
    return samples;
  }

  /* --------------------------------------------------------------- progress */

  function postStats() {
    post('stats', {
      jobId: job ? job.id : '',
      chunkIndex: lease ? lease.chunk_index : null,
      chunkStart: lease ? lease.start : null,
      chunkEnd: lease ? lease.end : null,
      scanned: chunk ? chunk.scanned : 0,
      span: chunk ? chunk.span : 0,
      rate: currentRate(),
      matches: matches
    });
  }

  async function sendHeartbeat(done, samples, options) {
    if (!lease || !chunk) return 'lost';
    var bodyText = jsonBody([
      ['client_id', clientId],
      ['job_id', lease.job_id],
      ['chunk_index', lease.chunk_index],
      ['lease_id', { raw: lease.lease_id }],
      ['scanned', chunk.scanned],
      ['rate', currentRate()],
      ['done', !!done],
      ['samples', samples || []]
    ]);
    var res = await api('/api/v1/heartbeat', {
      method: 'POST',
      bodyText: bodyText,
      abortable: !(options && options.abortable === false)
    });

    if (res.status === 200) {
      if (res.data && typeof res.data.expires_at === 'number') lease.expires_at = res.data.expires_at;
      chunk.lastHeartbeat = nowMs();
      return 'ok';
    }
    if (res.status === 401 || res.status === 403) throw new Error(authMessage(res.status));
    if (res.status === 409) return 'lost';
    if (res.status === 429) return 'busy';
    if (res.status === 400) {
      throw new Error((done ? 'completion heartbeat rejected: ' : 'heartbeat rejected: ') + describe(res));
    }
    throw new Error('heartbeat failed: ' + describe(res));
  }

  async function sendDone() {
    if (!chunk || chunk.scanned < chunk.span) {
      throw new Error('refusing to mark a partially scanned chunk done');
    }
    pauseTiming();
    var samples = buildSamples();
    for (var attempt = 0; attempt < 3; attempt++) {
      var outcome = await sendHeartbeat(true, samples, { abortable: false });
      if (outcome === 'ok') return true;
      if (outcome === 'busy') {
        await sleep(RATE_LIMIT_MS);
        continue;
      }
      if (outcome === 'lost') {
        log('lease lost before completion');
        dropLease();
        return false;
      }
    }
    log('completion heartbeat kept hitting the rate limit; re-leasing');
    dropLease();
    return false;
  }

  async function handleFound(result) {
    matches += 1;
    var found = {
      jobId: job ? job.id : '',
      chunkIndex: lease ? lease.chunk_index : null,
      key: result.key,
      address: result.address
    };
    postState('found', { found: found });
    postStats();
    log('match in job ' + found.jobId + ' chunk ' + found.chunkIndex);

    var bodyText = jsonBody([
      ['client_id', clientId],
      ['job_id', lease.job_id],
      ['lease_id', { raw: lease.lease_id }],
      ['key', result.key]
    ]);

    for (var attempt = 0; attempt < 3; attempt++) {
      var res = await api('/api/v1/result', { method: 'POST', bodyText: bodyText, abortable: false });
      if (res.status === 200) {
        log('result accepted');
        dropLease();
        job = null;
        return;
      }
      if (res.status === 401 || res.status === 403) throw new Error(authMessage(res.status));
      if (res.status === 409) {
        log('lease lost before the result was accepted; re-leasing');
        dropLease();
        return;
      }
      if (res.status === 404) {
        log('job disappeared before the result was accepted');
        dropLease();
        job = null;
        return;
      }
      if (res.status === 429) {
        await sleep(RATE_LIMIT_MS);
        continue;
      }
      throw new Error('result rejected: ' + describe(res));
    }
    log('result submission kept hitting the rate limit; dropping the lease');
    dropLease();
  }

  function dropLease() {
    pauseTiming();
    lease = null;
    chunk = null;
    postStats();
  }

  /* ------------------------------------------------------------- main loop */

  async function runLoop() {
    while (running) {
      // Yield between slices so stop/visibility messages are delivered even
      // while a scan loop is running.
      await sleep(0);
      if (!running) break;
      if (!token) {
        running = false;
        postState('token-required');
        return;
      }

      if (!job) {
        var picked = await pickJob();
        ensureRunning();
        if (!picked) {
          postState('no-jobs');
          postStats();
          await sleep(LEASE_RETRY_MS);
          continue;
        }
        job = picked;
        configureWasm(job);
        postState('job', { job: jobSummary(job) });
        postStats();
      }

      if (!lease) {
        var granted = await leaseChunk();
        ensureRunning();
        if (granted.retry) {
          job = null;
          postState('retrying', { message: granted.message });
          await sleep(granted.delay || LEASE_RETRY_MS);
          continue;
        }
        startChunk(granted.lease);
        postState('scanning', {
          job: jobSummary(job),
          chunkIndex: lease.chunk_index,
          chunkStart: lease.start,
          chunkEnd: lease.end
        });
        postStats();
      }

      var now = nowSec();
      if (now >= lease.expires_at) {
        log('lease expired before the next slice; re-leasing');
        dropLease();
        continue;
      }
      if (lease.expires_at - now <= 5) {
        var refreshed = await sendHeartbeat(false, [], { abortable: false });
        ensureRunning();
        // A 429 means the coordinator is busy, not that the lease is gone;
        // keep retrying the same lease until it actually expires.
        while (refreshed === 'busy' && nowSec() < lease.expires_at) {
          await sleep(RATE_LIMIT_MS);
          ensureRunning();
          refreshed = await sendHeartbeat(false, [], { abortable: false });
          ensureRunning();
        }
        if (refreshed !== 'ok') {
          log('lease lost while refreshing; re-leasing');
          dropLease();
          continue;
        }
      }

      resumeTiming();
      var outcome = scanSlice();
      postStats();

      if (outcome.found) {
        await handleFound(outcome);
        ensureRunning();
        continue;
      }
      if (chunk.scanned >= chunk.span) {
        var marked = await sendDone();
        if (marked) {
          postState('chunk-done', { jobId: job.id, chunkIndex: lease.chunk_index });
          dropLease();
          job = null;
        }
        ensureRunning();
        continue;
      }
      if (!running) break;

      if (nowMs() - chunk.lastHeartbeat >= PROGRESS_MS) {
        var progress = await sendHeartbeat(false, []);
        ensureRunning();
        // Same as the refresh path: a 429 backs off, it does not end the lease.
        while (progress === 'busy' && nowSec() < lease.expires_at) {
          await sleep(RATE_LIMIT_MS);
          ensureRunning();
          progress = await sendHeartbeat(false, []);
          ensureRunning();
        }
        if (progress !== 'ok') {
          log('lease lost; re-leasing');
          dropLease();
          continue;
        }
      }
    }
  }

  async function pauseAndWait() {
    if (!token) {
      postState(startedOnce ? 'token-required' : 'idle');
    } else {
      if (lease && chunk) {
        pauseTiming();
        try {
          var outcome = await sendHeartbeat(false, [], { abortable: false });
          if (outcome === 'lost' || outcome === 'busy') dropLease();
        } catch (err) {
          log('pause heartbeat failed: ' + (err && err.message ? err.message : String(err)));
          dropLease();
        }
      }
      postState(lease ? 'paused' : 'idle', {
        jobId: job ? job.id : '',
        chunkIndex: lease ? lease.chunk_index : null
      });
    }
    postStats();

    while (!running) {
      await sleep(60000);
    }

    if (lease && nowSec() >= lease.expires_at) {
      log('lease expired while paused; re-leasing');
      dropLease();
    }
    resumeTiming();
  }

  async function mainLoop() {
    for (;;) {
      try {
        await loadWasm();
        postState('ready');
        await runLoop();
      } catch (err) {
        if (err && err.stop) {
          // Stop/hide while a request was in flight: keep a lease for resume.
        } else {
          fail(err && err.message ? err.message : String(err));
          dropLease();
        }
      }
      await pauseAndWait();
    }
  }

  /* ---------------------------------------------------------------- control */

  self.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === 'start') {
      startedOnce = true;
      if (typeof message.token === 'string' && message.token) {
        if (/[\r\n\0]/.test(message.token)) {
          running = false;
          post('error', { message: 'The token contains an invalid control character. Paste it again in the cabinet.' });
          postState('token-required');
          return;
        }
        token = message.token;
      }
      if (typeof message.clientId === 'string' && message.clientId) clientId = message.clientId;
      if (typeof message.jobId === 'string' && message.jobId) preferredJobId = message.jobId;
      if (!clientId) clientId = fallbackClientId();
      if (!running) {
        running = true;
        wake();
      }
    } else if (message.type === 'stop') {
      running = false;
      wake();
    }
  };

  mainLoop();
})();
