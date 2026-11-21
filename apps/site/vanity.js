/* Vanity search: random keys are generated and derived in this tab only. */
(function () {
  'use strict';

  var WASM_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/rotor_wasm.wasm')
    : '/rotor_wasm.wasm';
  var WORKER_URL = typeof window !== 'undefined' && window.RotorAssets
    ? window.RotorAssets.url('/vanity-worker.js')
    : '/vanity-worker.js';
  var BATCH = 120;
  var DECODER = new TextDecoder('utf-8');
  var RECENT_KEY = 'rotor-vanity-recent';
  var RECENT_LIMIT = 5;
  var MAX_WORKERS = 4;
  var STATS_MS = 250;

  /* Alphabet = number of equally likely symbols in the matched address part.
     EVM hex is matched case-insensitively; base58 and bech32 stay case-sensitive. */
  var CHAINS = {
    'bitcoin-legacy': { field: 'btc_p2pkh', curve: 0, wif: true, alphabet: 58 },
    'bitcoin-segwit': { field: 'btc_p2wpkh', curve: 0, wif: true, alphabet: 32 },
    'bitcoin-taproot': { field: 'btc_p2tr', curve: 0, wif: true, alphabet: 32 },
    ethereum: { field: 'evm', curve: 0, wif: false, lower: true, alphabet: 16 },
    tron: { field: 'tron', curve: 0, wif: false, alphabet: 58 },
    solana: { field: 'solana', curve: 1, wif: false, alphabet: 58 }
  };

  function alphabetFor(chain) {
    var config = CHAINS[chain];
    return config && config.alphabet ? config.alphabet : 58;
  }

  function patternLength(prefix, suffix) {
    return String(prefix || '').length + String(suffix || '').length;
  }

  function expectedAttempts(alphabetSize, length) {
    var size = Number(alphabetSize);
    var count = Math.floor(Number(length));
    if (!isFinite(size) || size < 2 || !isFinite(count) || count < 1) return 1;
    return Math.pow(size, count);
  }

  function expectedSeconds(attempts, rate) {
    var expected = Number(attempts);
    var speed = Number(rate);
    if (!isFinite(expected) || expected <= 0) return null;
    if (!isFinite(speed) || speed <= 0) return null;
    return expected / speed;
  }

  /* One worker per core beyond the UI thread, clamped to 1..4. */
  function threadCount(cores) {
    var value = Math.floor(Number(cores));
    if (!isFinite(value) || value < 2) return 1;
    return Math.min(MAX_WORKERS, value - 1);
  }

  /* Normalize the page pattern once per run, before the search loop. */
  function patternFor(config, prefix, suffix) {
    var start = String(prefix || '').trim();
    var end = String(suffix || '').trim();
    if (config && config.field === 'evm' && start && !/^0x/i.test(start)) start = '0x' + start;
    var lower = !!(config && config.lower);
    return { prefix: lower ? start.toLowerCase() : start, suffix: lower ? end.toLowerCase() : end, lower: lower };
  }

  /* keep in sync with matches() in vanity-worker.js */
  function addressMatches(address, pattern) {
    var target = pattern.lower ? String(address).toLowerCase() : String(address);
    if (pattern.prefix && target.indexOf(pattern.prefix) !== 0) return false;
    if (!pattern.suffix) return true;
    return target.lastIndexOf(pattern.suffix) === target.length - pattern.suffix.length;
  }

  /* Workers are untrusted input too: whitelist the message fields we render. */
  function sanitizeWorkerMessage(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.type === 'progress') {
      var attempts = Number(data.attempts);
      if (!isFinite(attempts) || attempts < 0) return null;
      return { type: 'progress', attempts: Math.floor(attempts) };
    }
    if (data.type === 'match') {
      var address = typeof data.address === 'string' ? data.address.slice(0, 128) : '';
      var report = data.report && typeof data.report === 'object' ? data.report : null;
      if (!address || !report) return null;
      var privHex = typeof report.priv_hex === 'string' ? report.priv_hex : '';
      if (!privHex) return null;
      var attemptsAtMatch = Number(data.attempts);
      return {
        type: 'match',
        address: address,
        report: {
          priv_hex: privHex,
          wif_compressed: typeof report.wif_compressed === 'string' ? report.wif_compressed : ''
        },
        attempts: isFinite(attemptsAtMatch) && attemptsAtMatch >= 0 ? Math.floor(attemptsAtMatch) : 0
      };
    }
    if (data.type === 'error') {
      return {
        type: 'error',
        message: typeof data.message === 'string' ? data.message.slice(0, 200) : 'worker error'
      };
    }
    return null;
  }

  /* Whitelist only the public fields: a stored match must never carry a key. */
  function sanitizeRecentEntry(entry) {
    if (!entry || typeof entry !== 'object') return null;
    var chain = typeof entry.chain === 'string' ? entry.chain.slice(0, 40) : '';
    var address = typeof entry.address === 'string' ? entry.address.slice(0, 128) : '';
    if (!chain || !address) return null;
    var pattern = typeof entry.pattern === 'string' ? entry.pattern.slice(0, 96) : '';
    var foundAt = typeof entry.foundAt === 'number' && isFinite(entry.foundAt) ? entry.foundAt : 0;
    return { chain: chain, pattern: pattern, address: address, foundAt: foundAt };
  }

  (typeof globalThis !== 'undefined' ? globalThis : window).RotorVanityMath = {
    expectedAttempts: expectedAttempts,
    alphabetFor: alphabetFor,
    expectedSeconds: expectedSeconds,
    patternLength: patternLength,
    threadCount: threadCount,
    patternFor: patternFor,
    addressMatches: addressMatches,
    sanitizeWorkerMessage: sanitizeWorkerMessage,
    sanitizeRecentEntry: sanitizeRecentEntry
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
  var etaEl = byId('vanity-eta');
  var difficultyEl = byId('vanity-difficulty');
  var elapsedEl = byId('vanity-elapsed');
  var helpEl = byId('vanity-help');
  var helpBase = helpEl ? helpEl.textContent : '';
  var resultBox = byId('vanity-result');
  var addressEl = byId('vanity-address');
  var keyEl = byId('vanity-key');
  var wifRow = byId('vanity-wif-row');
  var wifEl = byId('vanity-wif');
  var qrRow = byId('vanity-qr-row');
  var qrCanvas = byId('vanity-qr');
  var recentBox = byId('vanity-recent');
  var recentListEl = byId('vanity-recent-list');

  var state = {
    wasm: null,
    wasmPromise: null,
    running: false,
    matched: false,
    mode: 'idle',
    workers: [],
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

  function exactAttemptsText(alphabet, length) {
    if (length < 1) return '1';
    try {
      var total = BigInt(1);
      var base = BigInt(alphabet);
      for (var i = 0; i < length; i += 1) total = total * base;
      return total.toString();
    } catch (err) {
      return String(expectedAttempts(alphabet, length));
    }
  }

  function difficultyLabel(alphabet, length) {
    if (length < 1) return '—';
    var attempts = expectedAttempts(alphabet, length);
    var human = attempts >= 1e9 ? attempts.toExponential(2) : formatNumber(Math.round(attempts));
    return '1 in ' + human;
  }

  function formatEta(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return '< 1 s';
    if (seconds < 60) return Math.round(seconds) + ' s';
    if (seconds < 3600) return Math.floor(seconds / 60) + ' m ' + Math.round(seconds % 60) + ' s';
    if (seconds < 86400) return Math.floor(seconds / 3600) + ' h ' + Math.floor((seconds % 3600) / 60) + ' m';
    var days = seconds / 86400;
    if (days < 365) return Math.round(days) + ' d';
    var years = days / 365;
    if (years < 1e6) return formatNumber(Math.round(years)) + ' y';
    return years.toExponential(2) + ' y';
  }

  function currentDifficulty() {
    var alphabet = alphabetFor(chainSelect.value);
    var length = patternLength(prefixInput.value.trim(), suffixInput.value.trim());
    return { alphabet: alphabet, length: length, attempts: expectedAttempts(alphabet, length) };
  }

  function refreshDifficulty() {
    var info = currentDifficulty();
    if (difficultyEl) {
      difficultyEl.textContent = 'Expected work: ' + difficultyLabel(info.alphabet, info.length);
      difficultyEl.title = 'Exact expected attempts: ' + exactAttemptsText(info.alphabet, info.length);
    }
    if (etaEl) {
      var eta = expectedSeconds(info.attempts, state.rate);
      etaEl.textContent = eta === null ? '—' : formatEta(eta);
    }
  }

  function chainTitle(chain) {
    if (chainSelect && chainSelect.options) {
      for (var i = 0; i < chainSelect.options.length; i += 1) {
        if (chainSelect.options[i].value === chain) {
          return String(chainSelect.options[i].textContent).replace(/\s*\(.*\)\s*$/, '');
        }
      }
    }
    return chain;
  }

  function readRecent() {
    try {
      if (!window.localStorage) return [];
      var raw = window.localStorage.getItem(RECENT_KEY);
      if (!raw) return [];
      var parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) return [];
      var list = [];
      for (var i = 0; i < parsed.length && list.length < RECENT_LIMIT; i += 1) {
        var clean = sanitizeRecentEntry(parsed[i]);
        if (clean) list.push(clean);
      }
      return list;
    } catch (err) {
      return [];
    }
  }

  function saveRecent(list) {
    try {
      if (!window.localStorage) return;
      window.localStorage.setItem(RECENT_KEY, JSON.stringify(list));
    } catch (err) {
      /* Storage unavailable or full: the search itself still works. */
    }
  }

  function copyButton(text, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'key-copy';
    button.textContent = 'Copy';
    button.setAttribute('aria-label', label);
    button.addEventListener('click', function () { copyText(text, button); });
    return button;
  }

  function renderRecent() {
    if (!recentBox || !recentListEl) return;
    var list = readRecent();
    recentListEl.textContent = '';
    if (!list.length) {
      recentBox.hidden = true;
      return;
    }
    recentBox.hidden = false;
    for (var i = 0; i < list.length; i += 1) {
      var entry = list[i];
      var name = chainTitle(entry.chain);
      var row = document.createElement('div');
      row.className = 'key-form-row';
      row.setAttribute('role', 'listitem');
      var label = document.createElement('span');
      label.className = 'key-field-label';
      label.textContent = entry.pattern ? name + ' · ' + entry.pattern : name;
      var address = document.createElement('code');
      address.className = 'mono key-addr';
      address.textContent = entry.address;
      row.appendChild(label);
      row.appendChild(address);
      row.appendChild(copyButton(entry.address, 'Copy ' + name + ' address'));
      recentListEl.appendChild(row);
    }
  }

  function addRecent(chain, pattern, address) {
    var entry = sanitizeRecentEntry({ chain: chain, pattern: pattern, address: address, foundAt: Date.now() });
    if (!entry) return;
    var list = readRecent();
    list.unshift(entry);
    saveRecent(list.slice(0, RECENT_LIMIT));
    renderRecent();
  }

  function totalAttempts() {
    var total = state.attempts;
    for (var i = 0; i < state.workers.length; i += 1) total += state.workers[i].attempts || 0;
    return total;
  }

  function setHelp(threads) {
    if (!helpEl) return;
    if (!threads) {
      helpEl.textContent = helpBase;
      return;
    }
    helpEl.textContent = helpBase.replace(
      'The search runs in this tab',
      'The search runs on ' + threads + ' thread' + (threads === 1 ? '' : 's')
    );
  }

  function startTimer() {
    clearTimer();
    state.timer = window.setInterval(updateStats, STATS_MS);
  }

  function clearTimer() {
    if (state.timer) {
      window.clearInterval(state.timer);
      state.timer = null;
    }
  }

  function clearRaf() {
    if (state.raf) {
      window.cancelAnimationFrame(state.raf);
      state.raf = null;
    }
  }

  function terminateWorkers() {
    for (var i = 0; i < state.workers.length; i += 1) {
      try {
        state.workers[i].worker.terminate();
      } catch (err) {
        /* already gone */
      }
    }
    state.workers = [];
    state.mode = 'idle';
  }

  /* Stops every source of attempts and folds their counters into one total. */
  function haltSearch() {
    state.running = false;
    clearRaf();
    clearTimer();
    var total = totalAttempts();
    terminateWorkers();
    state.attempts = total;
    setHelp(0);
  }

  function tick() {
    if (!state.running || state.mode !== 'fallback') return;
    var config = CHAINS[chainSelect.value];
    var pattern = patternFor(config, prefixInput.value, suffixInput.value);
    var bytes = new Uint8Array(32);

    for (var i = 0; i < BATCH; i += 1) {
      window.crypto.getRandomValues(bytes);
      if (state.wasm) {
        var report = derive(state.wasm, bytes, config.curve);
        if (!report) continue;
        var address = addressFrom(report, config.field);
        if (!address) continue;
        if (addressMatches(address, pattern)) {
          finish(report, address);
          return;
        }
      }
      state.attempts += 1;
    }
    updateStats();
    state.raf = window.requestAnimationFrame(tick);
  }

  function workerJob(config) {
    var pattern = patternFor(config, prefixInput.value, suffixInput.value);
    return {
      type: 'start',
      field: config.field,
      curve: config.curve,
      lower: pattern.lower,
      prefix: pattern.prefix,
      suffix: pattern.suffix
    };
  }

  function onWorkerMessage(entry, raw) {
    if (!state.running) return;
    var message = sanitizeWorkerMessage(raw);
    if (!message) return;
    if (message.type === 'progress') {
      entry.attempts = message.attempts;
      return;
    }
    if (message.type === 'match') {
      if (state.matched) return;
      entry.attempts = message.attempts;
      finish(message.report, message.address);
      return;
    }
    if (message.type === 'error' && !state.matched) fallbackToTab();
  }

  /* One worker per thread; any failure before a match drops to the in-tab loop. */
  function startWorkers() {
    var config = CHAINS[chainSelect.value];
    var count = threadCount(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency : 1);
    var started = [];
    try {
      for (var i = 0; i < count; i += 1) {
        started.push({ worker: new Worker(WORKER_URL), attempts: 0 });
      }
    } catch (err) {
      for (var j = 0; j < started.length; j += 1) {
        try { started[j].worker.terminate(); } catch (e) { /* already gone */ }
      }
      return false;
    }
    var job = workerJob(config);
    state.workers = started;
    state.mode = 'workers';
    for (var k = 0; k < started.length; k += 1) {
      (function (entry) {
        entry.worker.onmessage = function (event) { onWorkerMessage(entry, event.data); };
        entry.worker.onerror = function (event) {
          onWorkerMessage(entry, { type: 'error', message: event && event.message ? event.message : 'worker crashed' });
        };
        entry.worker.postMessage(job);
      })(started[k]);
    }
    setHelp(started.length);
    return true;
  }

  function fallbackToTab() {
    var total = totalAttempts();
    terminateWorkers();
    clearRaf();
    state.attempts = total;
    state.mode = 'fallback';
    state.lastCount = total;
    state.lastAt = performance.now();
    if (helpEl) {
      helpEl.textContent = helpBase.replace(
        'The search runs in this tab',
        'Multi-thread search is unavailable, so the search runs in this tab'
      );
    }
    state.raf = window.requestAnimationFrame(tick);
  }

  function updateStats() {
    var total = totalAttempts();
    attemptsEl.textContent = formatNumber(total);
    var now = performance.now();
    var seconds = Math.max(0.001, (now - state.startedAt) / 1000);
    elapsedEl.textContent = seconds < 60 ? seconds.toFixed(1) + ' s' : Math.floor(seconds / 60) + ' m ' + Math.floor(seconds % 60) + ' s';
    if (state.running) {
      if (now - state.lastAt > 400) {
        state.rate = (total - state.lastCount) / ((now - state.lastAt) / 1000);
        state.lastCount = total;
        state.lastAt = now;
      }
    } else {
      state.rate = 0;
    }
    rateEl.textContent = formatNumber(Math.round(state.rate)) + ' / s';
    refreshDifficulty();
  }

  /* Address-only QR: the key and WIF are never encoded or drawn. */
  function paintQr(address) {
    if (!qrRow || !qrCanvas) return;
    try {
      var root = typeof globalThis !== 'undefined' ? globalThis : window;
      var encoder = root.RotorQR;
      if (!encoder || typeof encoder.encode !== 'function') throw new Error('QR encoder unavailable');
      var code = encoder.encode(address);
      var quiet = 4;
      var total = code.size + quiet * 2;
      var scale = Math.max(1, Math.floor(200 / total));
      var pixelSize = total * scale;
      qrCanvas.width = pixelSize;
      qrCanvas.height = pixelSize;
      var context = qrCanvas.getContext('2d');
      if (!context) throw new Error('Canvas unavailable');
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, pixelSize, pixelSize);
      context.fillStyle = '#000000';
      for (var r = 0; r < code.size; r += 1) {
        for (var c = 0; c < code.size; c += 1) {
          if (code.modules[r][c]) {
            context.fillRect((quiet + c) * scale, (quiet + r) * scale, scale, scale);
          }
        }
      }
      qrRow.hidden = false;
    } catch (err) {
      qrRow.hidden = true;
    }
  }

  function finish(report, address) {
    if (!state.running) return;
    state.matched = true;
    haltSearch();
    updateStats();
    startBtn.disabled = false;
    stopBtn.disabled = true;
    resultBox.hidden = false;
    addressEl.textContent = address;
    paintQr(address);
    keyEl.textContent = report.priv_hex || '';
    if (report.wif_compressed) {
      wifRow.hidden = false;
      wifEl.textContent = report.wif_compressed;
    } else {
      wifRow.hidden = true;
    }
    var prefix = prefixInput.value.trim();
    var suffix = suffixInput.value.trim();
    addRecent(chainSelect.value, prefix && suffix ? prefix + '…' + suffix : (prefix || suffix), address);
    resultBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  function stop() {
    if (!state.running) {
      clearRaf();
      clearTimer();
      return;
    }
    haltSearch();
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
    state.matched = false;
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
      if (startWorkers()) {
        startTimer();
      } else {
        fallbackToTab();
      }
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

  chainSelect.addEventListener('change', refreshDifficulty);
  prefixInput.addEventListener('input', refreshDifficulty);
  suffixInput.addEventListener('input', refreshDifficulty);
  refreshDifficulty();
  renderRecent();

  byId('vanity-copy-address').addEventListener('click', function () { copyText(addressEl.textContent, this); });
  byId('vanity-copy-key').addEventListener('click', function () { copyText(keyEl.textContent, this); });
  byId('vanity-copy-wif').addEventListener('click', function () { copyText(wifEl.textContent, this); });
})();
