/* Rotor Bitcoin puzzle browser.
 *
 * Client-side only: the page spawns puzzle-worker.js instances that load
 * /rotor_wasm.wasm, generate keys inside the selected range and test them
 * against one public puzzle target. No key or scan result is uploaded. The
 * only network request is an optional read of the public mempool.space balance
 * for the target address.
 *
 * Host contracts:
 *   [data-puzzle-picker][data-puzzle-tab]  puzzle <select>; change navigates
 *   [data-puzzle-app]                      random-scan root with
 *                                          data-puzzle-{number,target,start,end}
 *   [data-puzzle-target]                   element carrying data-puzzle-target
 *   [data-puzzle-balance]                  balance text (may appear twice)
 *   [data-puzzle-check]                    refresh balance button
 *   counters: data-puzzle-{generated,speed,worker-count,wasm,match-count,eta}
 *   data-puzzle-progress / data-puzzle-progress-bar / data-puzzle-progress-text
 *   controls: data-puzzle-{mode,workers,start-input,end-input,start-btn,stop-btn,
 *                          reset-btn,team-note,state,match,match-key,copy}
 *   [data-range-preset]
 */
(function () {
  'use strict';

  var MEMPOOL_ADDRESS = 'https://mempool.space/api/address/';
  var MAX_WORKERS = 8;
  var PROGRESS_REFRESH_MS = 200;

  function num(value) {
    var parsed = typeof value === 'number' ? value : Number(value);
    return isFinite(parsed) && parsed > 0 ? parsed : 0;
  }

  function padHex(value) {
    var text = value.toString(16);
    while (text.length < 64) text = '0' + text;
    return text;
  }

  function parseHex(value) {
    var text = String(value === undefined || value === null ? '' : value).trim().toLowerCase();
    if (text.slice(0, 2) === '0x') text = text.slice(2);
    if (!/^[0-9a-f]{1,64}$/.test(text)) return null;
    return BigInt('0x' + text);
  }

  function formatCount(value) {
    return Math.round(num(value)).toLocaleString('en-US');
  }

  function formatSpeed(value) {
    if (!isFinite(value) || value <= 0) return '0';
    if (value >= 1e9) return (value / 1e9).toFixed(2) + ' G';
    if (value >= 1e6) return (value / 1e6).toFixed(2) + ' M';
    if (value >= 1e3) return (value / 1e3).toFixed(1) + ' k';
    return String(Math.round(value));
  }

  function formatDuration(seconds) {
    if (!isFinite(seconds) || seconds < 0) return '—';
    if (seconds < 1) return '<1s';
    if (seconds < 60) return Math.round(seconds) + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm ' + Math.round(seconds % 60) + 's';
    if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ' + Math.floor((seconds % 3600) / 60) + 'm';
    if (seconds < 31557600) return Math.floor(seconds / 86400) + 'd';
    var years = seconds / 31557600;
    return years >= 1e6 ? years.toExponential(2) + ' years' : years.toFixed(1) + ' years';
  }

  function copyText(text, button) {
    var done = function () {
      if (!button) return;
      var original = button.getAttribute('data-label') || button.textContent;
      button.setAttribute('data-label', original);
      button.textContent = 'Copied';
      window.setTimeout(function () { button.textContent = original; }, 1400);
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      navigator.clipboard.writeText(text).then(done, function () { fallbackCopy(text, done); });
    } else {
      fallbackCopy(text, done);
    }
  }

  function fallbackCopy(text, done) {
    var area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', 'readonly');
    area.style.position = 'fixed';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    try { document.execCommand('copy'); } catch (err) { /* ignore */ }
    document.body.removeChild(area);
    done();
  }

  /* --------------------------------------------------------------- picker */

  function initPicker() {
    var selects = document.querySelectorAll('[data-puzzle-picker]');
    for (var i = 0; i < selects.length; i++) {
      (function (select) {
        select.addEventListener('change', function () {
          var number = parseInt(select.value, 10);
          if (!(number >= 1 && number <= 160)) return;
          var tab = select.getAttribute('data-puzzle-tab') || 'random';
          window.location.assign('/bitcoin-puzzle/' + number + '/' + tab);
        });
      })(selects[i]);
    }
  }

  /* -------------------------------------------------------------- balance */

  function pageTarget() {
    var app = document.querySelector('[data-puzzle-app]');
    if (app && app.getAttribute('data-puzzle-target')) return app.getAttribute('data-puzzle-target');
    var node = document.querySelector('[data-puzzle-target]');
    return node ? node.getAttribute('data-puzzle-target') : '';
  }

  function initBalance() {
    var target = pageTarget();
    var values = document.querySelectorAll('[data-puzzle-balance]');
    if (!target || !values.length) return;
    var states = document.querySelectorAll('[data-puzzle-balance-state]');
    var checking = false;

    function setState(text) {
      for (var i = 0; i < states.length; i++) states[i].textContent = text;
    }

    async function refresh() {
      if (checking) return;
      checking = true;
      setState('checking mempool.space…');
      try {
        var response = await fetch(MEMPOOL_ADDRESS + encodeURIComponent(target), {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        var stats = data && data.chain_stats;
        if (!stats) throw new Error('unexpected response');
        var sats = num(stats.funded_txo_sum) - num(stats.spent_txo_sum);
        var btc = (sats / 1e8).toFixed(8);
        for (var i = 0; i < values.length; i++) values[i].textContent = btc + ' BTC';
        setState('live via mempool.space · ' + formatCount(stats.tx_count) + ' tx');
      } catch (err) {
        for (var j = 0; j < values.length; j++) values[j].textContent = 'unavailable';
        setState('balance unavailable — open Mempool');
      } finally {
        checking = false;
      }
    }

    var buttons = document.querySelectorAll('[data-puzzle-check]');
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', refresh);
    refresh();
  }

  /* ------------------------------------------------------------------ app */

  function initApp() {
    var root = document.querySelector('[data-puzzle-app]');
    if (!root) return;

    var number = parseInt(root.getAttribute('data-puzzle-number'), 10) || 0;
    var target = root.getAttribute('data-puzzle-target') || '';
    var puzzleStart = parseHex(root.getAttribute('data-puzzle-start'));
    var puzzleEnd = parseHex(root.getAttribute('data-puzzle-end'));
    var supports = typeof BigInt === 'function' && typeof Worker === 'function';

    var els = {
      mode: root.querySelector('[data-puzzle-mode]'),
      workerCount: root.querySelector('[data-puzzle-workers]'),
      startInput: root.querySelector('[data-puzzle-start-input]'),
      endInput: root.querySelector('[data-puzzle-end-input]'),
      startBtn: root.querySelector('[data-puzzle-start-btn]'),
      stopBtn: root.querySelector('[data-puzzle-stop-btn]'),
      resetBtn: root.querySelector('[data-puzzle-reset-btn]'),
      teamNote: root.querySelector('[data-puzzle-team-note]'),
      state: root.querySelector('[data-puzzle-state]'),
      match: root.querySelector('[data-puzzle-match]'),
      matchKey: root.querySelector('[data-puzzle-match-key]'),
      copy: root.querySelector('[data-puzzle-copy]'),
      generated: root.querySelector('[data-puzzle-generated]'),
      speed: root.querySelector('[data-puzzle-speed]'),
      workers: root.querySelector('[data-puzzle-worker-count]'),
      wasm: root.querySelector('[data-puzzle-wasm]'),
      matchCount: root.querySelector('[data-puzzle-match-count]'),
      eta: root.querySelector('[data-puzzle-eta]'),
      progress: root.querySelector('[data-puzzle-progress]'),
      progressBar: root.querySelector('[data-puzzle-progress-bar]'),
      progressText: root.querySelector('[data-puzzle-progress-text]')
    };
    var presetButtons = root.querySelectorAll('[data-range-preset]');

    var workers = [];
    var running = false;
    var found = null;
    var progressTimer = null;
    var scanAnnounced = false;

    if (puzzleStart === null || puzzleEnd === null || puzzleEnd < puzzleStart) {
      setState('The puzzle range could not be parsed; the local scan is disabled.');
      setStartEnabled(false);
      return;
    }

    function setState(text) {
      if (els.state) els.state.textContent = text;
    }

    function setStartEnabled(enabled) {
      if (!els.startBtn) return;
      els.startBtn.disabled = !enabled || modeValue() === 'team';
    }

    function setStopEnabled(enabled) {
      if (els.stopBtn) els.stopBtn.disabled = !enabled;
    }

    function setControlsEnabled(enabled) {
      if (els.mode) els.mode.disabled = !enabled;
      if (els.workerCount) els.workerCount.disabled = !enabled;
      if (els.startInput) els.startInput.disabled = !enabled;
      if (els.endInput) els.endInput.disabled = !enabled;
      for (var i = 0; i < presetButtons.length; i++) {
        if (enabled) {
          if (!presetButtons[i].getAttribute('data-too-small')) presetButtons[i].disabled = false;
        } else {
          presetButtons[i].disabled = true;
        }
      }
    }

    function modeValue() {
      return els.mode ? els.mode.value : 'random';
    }

    function readWorkerCount() {
      var value = els.workerCount ? parseInt(els.workerCount.value, 10) : 1;
      if (!isFinite(value)) value = 1;
      return Math.max(1, Math.min(MAX_WORKERS, value));
    }

    function currentRange() {
      var start = parseHex(els.startInput ? els.startInput.value : '');
      var end = parseHex(els.endInput ? els.endInput.value : '');
      if (start === null || end === null) {
        setState('Range values must be hex (0-9, a-f).');
        return null;
      }
      if (start < puzzleStart || end > puzzleEnd) {
        setState('The selected range must stay inside puzzle #' + number + '.');
        return null;
      }
      if (start > end) {
        setState('Range start must not be greater than range end.');
        return null;
      }
      return { start: start, end: end };
    }

    function presetRange(key) {
      var size = puzzleEnd - puzzleStart + 1n;
      if (key === 'full') return [puzzleStart, puzzleEnd];
      var half = size / 2n;
      if (key === 'first') return [puzzleStart, puzzleStart + half - 1n];
      if (key === 'second') return [puzzleStart + half, puzzleEnd];
      var quarter = size / 4n;
      var index = key === 'q1' ? 0n : key === 'q2' ? 1n : key === 'q3' ? 2n : 3n;
      var start = puzzleStart + quarter * index;
      if (key === 'q4') return [start, puzzleEnd];
      return [start, start + quarter - 1n];
    }

    function applyPreset(key) {
      if (running) return;
      var range = presetRange(key);
      if (!range || range[0] > range[1]) return;
      if (els.startInput) els.startInput.value = padHex(range[0]);
      if (els.endInput) els.endInput.value = padHex(range[1]);
      for (var i = 0; i < presetButtons.length; i++) {
        var active = presetButtons[i].getAttribute('data-range-preset') === key;
        presetButtons[i].classList.toggle('active', active);
      }
      setState('Range set to ' + key + '.');
    }

    function resetRange() {
      if (els.startInput) els.startInput.value = padHex(puzzleStart);
      if (els.endInput) els.endInput.value = padHex(puzzleEnd);
      for (var i = 0; i < presetButtons.length; i++) {
        presetButtons[i].classList.toggle('active', presetButtons[i].getAttribute('data-range-preset') === 'full');
      }
    }

    function sequentialWindow(range, count, index) {
      var span = range.end - range.start + 1n;
      var per = span / BigInt(count);
      var rest = span % BigInt(count);
      var extra = BigInt(index);
      var offset = per * BigInt(index) + (extra < rest ? extra : rest);
      var length = per + (extra < rest ? 1n : 0n);
      var start = range.start + offset;
      return { start: start, end: start + length - 1n };
    }

    function spawn(index, count, range, mode) {
      var window = mode === 'seq' ? sequentialWindow(range, count, index) : range;
      var worker;
      try {
        worker = new Worker('/puzzle-worker.js');
      } catch (err) {
        halt('Could not start the WASM worker: ' + (err && err.message ? err.message : String(err)));
        return null;
      }
      var entry = { worker: worker, generated: 0, rate: 0, wasm: 'loading', done: false };
      worker.onmessage = function (event) { onWorkerMessage(entry, event.data || {}); };
      worker.onerror = function (event) {
        entry.wasm = 'error';
        onWorkerMessage(entry, { type: 'error', message: event && event.message ? event.message : 'worker crashed' });
      };
      worker.postMessage({
        type: 'start',
        target: target,
        mode: mode,
        start: padHex(window.start),
        end: padHex(window.end),
        sliceKeys: 32768
      });
      return entry;
    }

    function onWorkerMessage(entry, message) {
      if (message.type === 'state') {
        if (message.wasm) entry.wasm = message.wasm;
        renderStats();
        return;
      }
      if (message.type === 'stats') {
        entry.generated = num(message.generated);
        entry.rate = num(message.rate);
        entry.wasm = message.wasm || 'ready';
        if (!scanAnnounced && entry.generated > 0) {
          scanAnnounced = true;
          setState('Scanning with ' + workers.length + ' WASM worker' + (workers.length === 1 ? '' : 's') + '…');
        }
        renderStats();
        updateProgress();
        return;
      }
      if (message.type === 'match') {
        entry.generated = num(message.generated) || entry.generated;
        entry.done = true;
        found = {
          key: String(message.key || ''),
          address: String(message.address || '')
        };
        showMatch(found);
        halt('MATCH FOUND for puzzle #' + number + '. The scan stopped.');
        renderStats();
        updateProgress();
        return;
      }
      if (message.type === 'done') {
        entry.generated = num(message.generated) || entry.generated;
        entry.rate = 0;
        entry.done = true;
        var allDone = true;
        for (var i = 0; i < workers.length; i++) {
          if (!workers[i].done) allDone = false;
        }
        renderStats();
        updateProgress();
        if (allDone) finish('Range complete. No match in the selected window.');
        return;
      }
      if (message.type === 'error') {
        entry.wasm = 'error';
        entry.done = true;
        halt('Worker error: ' + (message.message || 'unknown'));
      }
    }

    function totals() {
      var generated = 0;
      var rate = 0;
      var ready = 0;
      var loading = 0;
      var errored = 0;
      var active = 0;
      for (var i = 0; i < workers.length; i++) {
        generated += workers[i].generated;
        rate += workers[i].rate;
        if (workers[i].wasm === 'ready') ready += 1;
        else if (workers[i].wasm === 'error') errored += 1;
        else loading += 1;
        if (!workers[i].done) active += 1;
      }
      return { generated: generated, rate: rate, ready: ready, loading: loading, errored: errored, active: active };
    }

    function renderStats() {
      var sums = totals();
      if (els.generated) els.generated.textContent = formatCount(sums.generated);
      if (els.speed) els.speed.textContent = formatSpeed(sums.rate);
      if (els.workers) els.workers.textContent = running ? String(workers.length) : '0';
      if (els.wasm) {
        els.wasm.textContent = sums.errored ? 'error' : sums.ready ? 'ready' : workers.length ? 'loading' : 'idle';
      }
      if (els.matchCount) els.matchCount.textContent = found ? '1' : '0';
      if (els.eta) {
        if (!running || sums.rate <= 0) {
          els.eta.textContent = '—';
        } else {
          var selected = currentSize();
          var left = modeValue() === 'seq'
            ? Math.max(0, Number(selected) - sums.generated)
            : Number(selected);
          els.eta.textContent = formatDuration(left / sums.rate);
        }
      }
    }

    function currentSize() {
      var start = parseHex(els.startInput ? els.startInput.value : '');
      var end = parseHex(els.endInput ? els.endInput.value : '');
      if (start === null || end === null || end < start) return 1n;
      return end - start + 1n;
    }

    function updateProgress() {
      if (!els.progress) return;
      var sums = totals();
      var size = currentSize();
      var ratio = size > 0n ? sums.generated / Number(size) : 0;
      var fraction = modeValue() === 'seq' ? ratio : 1 - Math.exp(-ratio);
      if (ratio >= 1) fraction = 1;
      if (!isFinite(fraction)) fraction = 0;
      fraction = Math.max(0, Math.min(1, fraction));
      els.progress.style.width = (fraction * 100).toFixed(1) + '%';
      if (els.progressBar) els.progressBar.setAttribute('aria-valuenow', String(Math.round(fraction * 100)));
      if (els.progressText) {
        if (!sums.generated) {
          els.progressText.textContent = 'No keys scanned yet.';
        } else {
          var label = modeValue() === 'seq' ? 'scanned' : 'estimated coverage';
          els.progressText.textContent = formatCount(sums.generated) + (sums.generated === 1 ? ' key tested · ' : ' keys tested · ') + label + ' ' + (fraction * 100).toFixed(fraction < 0.0001 ? 6 : 2) + '%';
        }
      }
    }

    function showMatch(match) {
      if (!els.match) return;
      els.match.hidden = false;
      if (els.matchKey) els.matchKey.textContent = match.key;
      if (els.copy) {
        els.copy.onclick = function () { copyText(match.key, els.copy); };
      }
    }

    function hideMatch() {
      if (els.match) els.match.hidden = true;
      if (els.matchKey) els.matchKey.textContent = '';
    }

    function halt(message) {
      running = false;
      if (progressTimer !== null) {
        window.clearInterval(progressTimer);
        progressTimer = null;
      }
      for (var i = 0; i < workers.length; i++) {
        try { workers[i].worker.terminate(); } catch (err) { /* already gone */ }
        workers[i].rate = 0;
        workers[i].done = true;
      }
      setStartEnabled(true);
      setStopEnabled(false);
      setControlsEnabled(true);
      if (message) setState(message);
      renderStats();
      updateProgress();
    }

    function finish(message) {
      halt(message);
    }

    function startScan() {
      if (running) return;
      if (!supports) {
        setState('This browser lacks BigInt or Web Worker support; the local scan cannot run.');
        return;
      }
      if (modeValue() === 'team') {
        setState('Team mode uses the coordinator pool. Open the pooled job board instead of a local scan.');
        return;
      }
      var range = currentRange();
      if (!range) return;

      var mode = modeValue() === 'seq' ? 'seq' : 'random';
      var count = readWorkerCount();
      if (mode === 'seq') {
        var span = range.end - range.start + 1n;
        if (BigInt(count) > span) count = Math.max(1, Number(span));
      }

      workers = [];
      found = null;
      scanAnnounced = false;
      hideMatch();
      running = true;
      setStartEnabled(false);
      setStopEnabled(true);
      setControlsEnabled(false);
      setState('Starting ' + count + ' WASM worker' + (count === 1 ? '' : 's') + '…');
      if (els.eta) els.eta.textContent = '—';

      for (var i = 0; i < count && running; i++) {
        var entry = spawn(i, count, range, mode);
        if (entry) workers.push(entry);
      }
      if (!workers.length) {
        running = false;
        setStartEnabled(true);
        setStopEnabled(false);
        setControlsEnabled(true);
        return;
      }
      renderStats();
      updateProgress();
      progressTimer = window.setInterval(function () {
        renderStats();
        updateProgress();
      }, PROGRESS_REFRESH_MS);
    }

    function stopScan() {
      if (!running) return;
      var sums = totals();
      halt('Stopped after ' + formatCount(sums.generated) + ' keys.');
    }

    function resetScan() {
      halt();
      workers = [];
      found = null;
      scanAnnounced = false;
      hideMatch();
      resetRange();
      setState('Reset. Ready to start a fresh scan.');
      renderStats();
      updateProgress();
    }

    /* --------------------------------------------------------------- wiring */

    if (els.startBtn) els.startBtn.addEventListener('click', startScan);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopScan);
    if (els.resetBtn) els.resetBtn.addEventListener('click', resetScan);

    if (els.mode) {
      els.mode.addEventListener('change', function () {
        var team = modeValue() === 'team';
        if (els.teamNote) els.teamNote.hidden = !team;
        setStartEnabled(!team);
        if (team) setState('Team mode selected. Local scanning is off; use the pooled job board for leased chunks.');
        else setState('Ready. Press Start or Space.');
      });
    }

    for (var b = 0; b < presetButtons.length; b++) {
      (function (button) {
        var key = button.getAttribute('data-range-preset');
        var computed = presetRange(key);
        if (!computed || computed[0] > computed[1]) {
          button.disabled = true;
          button.setAttribute('data-too-small', '1');
          button.title = 'This split is empty for a range this small.';
        }
        button.addEventListener('click', function () { applyPreset(key); });
      })(presetButtons[b]);
    }

    if (els.startInput) els.startInput.addEventListener('change', function () {
      for (var i = 0; i < presetButtons.length; i++) presetButtons[i].classList.remove('active');
    });
    if (els.endInput) els.endInput.addEventListener('change', function () {
      for (var i = 0; i < presetButtons.length; i++) presetButtons[i].classList.remove('active');
    });

    document.addEventListener('keydown', function (event) {
      if (event.code !== 'Space' && event.key !== ' ') return;
      var node = event.target;
      var tag = node && node.tagName ? node.tagName : '';
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || tag === 'BUTTON' || tag === 'A' || (node && node.isContentEditable)) return;
      event.preventDefault();
      if (running) stopScan();
      else startScan();
    });

    if (els.teamNote) els.teamNote.hidden = modeValue() !== 'team';
    setStartEnabled(!running && modeValue() !== 'team');
    setStopEnabled(false);
    renderStats();
    updateProgress();
  }

  function boot() {
    initPicker();
    initBalance();
    initApp();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
