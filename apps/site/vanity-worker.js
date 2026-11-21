/* Vanity search worker: random keys are generated and derived here only.
 *
 * Classic Web Worker (no imports, no build step). It loads the committed
 * /rotor_wasm.wasm artifact and searches for a prefix/suffix on the requested
 * address field.
 *
 * Message contract (page -> worker):
 *   { type: 'start', field, curve, lower, prefix, suffix }
 *   { type: 'stop' }
 *
 * Worker -> page:
 *   { type: 'progress', attempts }
 *   { type: 'match', address, report, attempts }
 *   { type: 'error', message }
 *
 * Nothing is sent over the network from here; the wasm artifact is served
 * from its own origin.
 */
(function () {
  'use strict';

  /* The worker is started from `/a/<build>/vanity-worker.js`; derive the build
   * from its own URL so the wasm fetch stays immutable too. */
  function assetUrl(path) {
    var match = self.location && /^\/a\/([^/]+)\//.exec(self.location.pathname);
    return match ? '/a/' + match[1] + path : path;
  }

  var WASM_URL = assetUrl('/rotor_wasm.wasm');
  var BATCH = 200;
  var PROGRESS_MS = 250;
  var DECODER = new TextDecoder('utf-8');

  var wasm = null;
  var wasmPromise = null;
  var running = false;
  var attempts = 0;
  var lastPost = 0;
  var job = null;

  function now() {
    return typeof performance !== 'undefined' && performance && typeof performance.now === 'function'
      ? performance.now()
      : Date.now();
  }

  function post(message) {
    self.postMessage(message);
  }

  function fail(err) {
    running = false;
    post({ type: 'error', message: err && err.message ? err.message : String(err) });
  }

  function loadWasm() {
    if (wasmPromise) return wasmPromise;
    wasmPromise = (async function () {
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var exports = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len', 'memory'];
      for (var i = 0; i < required.length; i += 1) {
        if (!exports[required[i]]) throw new Error('The derivation core is missing ' + required[i] + '.');
      }
      wasm = exports;
      return wasm;
    })();
    wasmPromise.catch(function () { wasmPromise = null; });
    return wasmPromise;
  }

  function readString(ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function derive(bytes, curve) {
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) return null;
      return JSON.parse(readString(wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
  }

  function addressFrom(report, field) {
    if (!report || !Array.isArray(report.addresses)) return '';
    for (var i = 0; i < report.addresses.length; i += 1) {
      if (report.addresses[i].id === field) return report.addresses[i].address || '';
    }
    return '';
  }

  /* keep in sync with addressMatches() in vanity.js */
  function matches(address, prefix, suffix, lower) {
    var target = lower ? address.toLowerCase() : address;
    if (prefix && target.indexOf(prefix) !== 0) return false;
    if (!suffix) return true;
    return target.lastIndexOf(suffix) === target.length - suffix.length;
  }

  function loop() {
    if (!running) return;
    var bytes = new Uint8Array(32);
    for (var i = 0; i < BATCH && running; i += 1) {
      self.crypto.getRandomValues(bytes);
      var report = derive(bytes, job.curve);
      if (!report) continue;
      var address = addressFrom(report, job.field);
      if (!address) continue;
      attempts += 1;
      if (matches(address, job.prefix, job.suffix, job.lower)) {
        running = false;
        post({ type: 'progress', attempts: attempts });
        post({ type: 'match', address: address, report: report, attempts: attempts });
        return;
      }
    }
    if (!running) return;
    var at = now();
    if (at - lastPost >= PROGRESS_MS) {
      lastPost = at;
      post({ type: 'progress', attempts: attempts });
    }
    setTimeout(loop, 0);
  }

  function start(message) {
    job = {
      field: String(message.field || ''),
      curve: Number(message.curve) || 0,
      lower: !!message.lower,
      prefix: String(message.prefix || ''),
      suffix: String(message.suffix || '')
    };
    if (!job.field) {
      fail(new Error('missing address field'));
      return;
    }
    attempts = 0;
    lastPost = now();
    running = true;
    loadWasm().then(function () {
      if (!running) return;
      loop();
    }).catch(function (err) {
      if (!running) return;
      fail(err);
    });
  }

  self.onmessage = function (event) {
    var message = event.data || {};
    if (message.type === 'stop') {
      running = false;
      return;
    }
    if (message.type !== 'start' || running) return;
    start(message);
  };
})();
