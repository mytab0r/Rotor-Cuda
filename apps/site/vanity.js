/* Vanity search: random keys are generated and derived in this tab only. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var BATCH = 120;
  var DECODER = new TextDecoder('utf-8');

  var CHAINS = {
    'bitcoin-legacy': { field: 'btc_p2pkh', curve: 0, wif: true },
    'bitcoin-segwit': { field: 'btc_p2wpkh', curve: 0, wif: true },
    'bitcoin-taproot': { field: 'btc_p2tr', curve: 0, wif: true },
    ethereum: { field: 'evm', curve: 0, wif: false, lower: true },
    tron: { field: 'tron', curve: 0, wif: false },
    solana: { field: 'solana', curve: 1, wif: false }
  };

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('vanity-form');
  if (!form) return;

  var chainSelect = byId('vanity-chain');
  var prefixInput = byId('vanity-prefix');
  var suffixInput = byId('vanity-suffix');
  var startBtn = byId('vanity-start');
  var stopBtn = byId('vanity-stop');
  var errorBox = byId('vanity-error');
  var attemptsEl = byId('vanity-attempts');
  var rateEl = byId('vanity-rate');
  var elapsedEl = byId('vanity-elapsed');
  var resultBox = byId('vanity-result');
  var addressEl = byId('vanity-address');
  var keyEl = byId('vanity-key');
  var wifRow = byId('vanity-wif-row');
  var wifEl = byId('vanity-wif');

  var state = {
    wasm: null,
    wasmPromise: null,
    running: false,
    attempts: 0,
    startedAt: 0,
    timer: null,
    raf: null,
    lastCount: 0,
    lastAt: 0,
    rate: 0
  };

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function loadWasm() {
    if (state.wasmPromise) return state.wasmPromise;
    state.wasmPromise = (async function () {
      var response = await fetch(WASM_URL);
      if (!response.ok) throw new Error('Cannot load the derivation core: HTTP ' + response.status);
      var module;
      try {
        module = await WebAssembly.instantiateStreaming(response.clone(), {});
      } catch (err) {
        module = await WebAssembly.instantiate(await response.arrayBuffer(), {});
      }
      var wasm = module.instance ? module.instance.exports : module.exports;
      var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len', 'memory'];
      for (var i = 0; i < required.length; i += 1) {
        if (!wasm[required[i]]) throw new Error('The derivation core is missing ' + required[i] + '.');
      }
      state.wasm = wasm;
      return wasm;
    })();
    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function derive(wasm, bytes, curve) {
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) return null;
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
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

  function formatNumber(value) {
    return Number(value || 0).toLocaleString('en-US');
  }

  function tick() {
    if (!state.running) return;
    var config = CHAINS[chainSelect.value];
    var prefix = prefixInput.value.trim();
    var suffix = suffixInput.value.trim();
    if (config.field === 'evm' && prefix && !/^0x/i.test(prefix)) prefix = '0x' + prefix;
    var comparePrefix = config.lower ? prefix.toLowerCase() : prefix;
    var compareSuffix = config.lower ? suffix.toLowerCase() : suffix;
    var bytes = new Uint8Array(32);

    for (var i = 0; i < BATCH; i += 1) {
      window.crypto.getRandomValues(bytes);
      if (state.wasm) {
        var report = derive(state.wasm, bytes, config.curve);
        if (!report) continue;
        var address = addressFrom(report, config.field);
        if (!address) continue;
        var target = config.lower ? address.toLowerCase() : address;
        if ((!comparePrefix || target.indexOf(comparePrefix) === 0) &&
            (!compareSuffix || target.lastIndexOf(compareSuffix) === target.length - compareSuffix.length)) {
          finish(report, address);
          return;
        }
      }
      state.attempts += 1;
    }
    updateStats();
    state.raf = window.requestAnimationFrame(tick);
  }

  function updateStats() {
    attemptsEl.textContent = formatNumber(state.attempts);
    var seconds = Math.max(0.001, (performance.now() - state.startedAt) / 1000);
    elapsedEl.textContent = seconds < 60 ? seconds.toFixed(1) + ' s' : Math.floor(seconds / 60) + ' m ' + Math.floor(seconds % 60) + ' s';
    if (performance.now() - state.lastAt > 400) {
      state.rate = (state.attempts - state.lastCount) / ((performance.now() - state.lastAt) / 1000);
      state.lastCount = state.attempts;
      state.lastAt = performance.now();
    }
    rateEl.textContent = formatNumber(Math.round(state.rate)) + ' / s';
  }

  function finish(report, address) {
    state.running = false;
    if (state.raf) window.cancelAnimationFrame(state.raf);
    updateStats();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    resultBox.hidden = false;
    addressEl.textContent = address;
    keyEl.textContent = report.priv_hex || '';
    if (report.wif_compressed) {
      wifRow.hidden = false;
      wifEl.textContent = report.wif_compressed;
    } else {
      wifRow.hidden = true;
    }
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function stop() {
    state.running = false;
    if (state.raf) window.cancelAnimationFrame(state.raf);
    startBtn.disabled = false;
    stopBtn.disabled = true;
    updateStats();
  }

  function copyText(text, button) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () {
        button.textContent = 'Copied';
        window.setTimeout(function () { button.textContent = 'Copy'; }, 1200);
      });
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    if (state.running) return;
    fail('');
    var prefix = prefixInput.value.trim();
    var suffix = suffixInput.value.trim();
    if (!prefix && !suffix) {
      fail('Enter a prefix or a suffix first.');
      prefixInput.focus();
      return;
    }
    resultBox.hidden = true;
    state.attempts = 0;
    state.startedAt = performance.now();
    state.lastAt = state.startedAt;
    state.lastCount = 0;
    state.rate = 0;
    startBtn.disabled = true;
    stopBtn.disabled = false;
    setStatus('Loading the derivation core…');
    loadWasm().then(function () {
      setStatus('');
      state.running = true;
      tick();
    }).catch(function (err) {
      fail(err && err.message ? err.message : 'The derivation core did not load.');
      startBtn.disabled = false;
      stopBtn.disabled = true;
    });
  });

  function setStatus(message) {
    if (!message) {
      fail('');
      return;
    }
    fail(message);
  }

  stopBtn.addEventListener('click', stop);
  window.addEventListener('pagehide', stop);

  byId('vanity-copy-address').addEventListener('click', function () { copyText(addressEl.textContent, this); });
  byId('vanity-copy-key').addEventListener('click', function () { copyText(keyEl.textContent, this); });
  byId('vanity-copy-wif').addEventListener('click', function () { copyText(wifEl.textContent, this); });
})();
