/* Rotor Bitcoin puzzle browser.
 *
 * Client-side only: the page spawns puzzle-worker.js instances that load
 * /rotor_wasm.wasm, generate keys inside the selected range and test them
 * against one public puzzle target. No key or scan result is uploaded. The
 * only network requests are an optional read of the public mempool.space
 * balance for each visible puzzle address and the public /api/v1/summary
 * counter feed.
 *
 * Host contracts:
 *   [data-puzzle-picker][data-puzzle-tab]  puzzle <select>; change navigates
 *   [data-puzzle-row]                      one table row (data-solved,
 *                                          data-search)
 *   [data-puzzle-filter]                   All/Solved/Unsolved segmented tabs
 *   [data-puzzle-search]                   table search input
 *   [data-balance-address]                 balance cell; loaded when visible
 *   [data-tx-address]                      transaction-count link for an address
 *   [data-copy]                            copy-to-clipboard icon button
 *   [data-puzzle-app]                      random-scan root with
 *                                          data-puzzle-{number,target,start,end}
 *   [data-puzzle-target]                   element carrying data-puzzle-target
 *   [data-puzzle-balance]                  balance text (may appear twice)
 *   [data-puzzle-check]                    refresh balance button
 *   counters: data-puzzle-{generated,speed,worker-count,wasm,match-count,eta}
 *   data-puzzle-progress / data-puzzle-progress-bar / data-puzzle-progress-text
 *   controls: data-puzzle-{mode,workers,start-input,end-input,start-btn,stop-btn,
 *                          reset-btn,resume-btn,team-note,state,match,match-key,copy}
 *   results: data-puzzle-results (tbody), data-puzzle-results-empty,
 *            data-puzzle-results-count
 *   community: data-puzzle-community, data-puzzle-community-state,
 *              data-puzzle-community-stats
 *   [data-range-preset]
 */
(function () {
  'use strict';

  var MEMPOOL_ADDRESS = 'https://mempool.space/api/address/';
  var SUMMARY_ENDPOINT = '/api/v1/summary';
  var MAX_WORKERS = 8;
  var PROGRESS_REFRESH_MS = 200;
  var BALANCE_CONCURRENCY = 3;
  var SAMPLE_INTERVAL_MS = 1200;
  var MAX_RESULT_ROWS = 25;
  var SUMMARY_REFRESH_MS = 20000;

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

  function randomInRange(min, max) {
    var span = max - min + 1n;
    if (span <= 0n) return min;
    var bits = (span - 1n).toString(2).length;
    var words = Math.max(1, Math.ceil(bits / 32));
    var excess = BigInt(words * 32 - bits);
    var buffer = new Uint32Array(words);
    for (;;) {
      if (window.crypto && typeof window.crypto.getRandomValues === 'function') {
        window.crypto.getRandomValues(buffer);
      } else {
        for (var i = 0; i < words; i++) buffer[i] = Math.floor(Math.random() * 4294967296);
      }
      var value = 0n;
      for (var j = 0; j < words; j++) value = (value << 32n) | BigInt(buffer[j]);
      if (excess > 0n) value >>= excess;
      if (value < span) return min + value;
    }
  }

  function copyText(text, button) {
    var isIcon = button && button.hasAttribute('data-copy');
    var done = function () {
      if (!button) return;
      if (isIcon) {
        button.classList.add('is-copied');
        var hadLabel = button.getAttribute('aria-label');
        button.setAttribute('aria-label', 'Copied');
        window.setTimeout(function () {
          button.classList.remove('is-copied');
          if (hadLabel) button.setAttribute('aria-label', hadLabel);
        }, 1400);
      } else {
        var original = button.getAttribute('data-label') || button.textContent;
        button.setAttribute('data-label', original);
        button.textContent = 'Copied';
        window.setTimeout(function () { button.textContent = original; }, 1400);
      }
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

  function each(list, callback) {
    for (var i = 0; i < list.length; i++) callback(list[i], i);
  }

  /* --------------------------------------------------------------- copy */

  function initCopy() {
    document.addEventListener('click', function (event) {
      var target = event.target;
      if (!target || typeof target.closest !== 'function') return;
      var button = target.closest('[data-copy]');
      if (!button) return;
      event.preventDefault();
      copyText(button.getAttribute('data-copy') || '', button);
    });
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
        var links = document.querySelectorAll('[data-tx-address]');
        for (var j = 0; j < links.length; j++) {
          if (links[j].getAttribute('data-tx-address') === target) {
            links[j].textContent = formatCount(stats.tx_count) + ' tx';
          }
        }
      } catch (err) {
        for (var k = 0; k < values.length; k++) values[k].textContent = 'unavailable';
        setState('balance unavailable — open Mempool');
      } finally {
        checking = false;
      }
    }

    var buttons = document.querySelectorAll('[data-puzzle-check]');
    for (var i = 0; i < buttons.length; i++) buttons[i].addEventListener('click', refresh);
    refresh();
  }

  /* --------------------------------------------------------- table filter */

  function initFilter() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-puzzle-row]'));
    if (!rows.length) return;
    var buttons = Array.prototype.slice.call(document.querySelectorAll('[data-puzzle-filter]'));
    var search = document.querySelector('[data-puzzle-search]');
    var empty = document.querySelector('[data-puzzle-empty]');
    var filter = 'all';

    function apply() {
      var query = (search && search.value ? search.value : '').trim().toLowerCase();
      if (query.charAt(0) === '#') query = query.slice(1);
      var visible = 0;
      each(rows, function (row) {
        var solved = row.getAttribute('data-solved') === 'true';
        var passFilter = filter === 'all' ||
          (filter === 'solved' && solved) ||
          (filter === 'unsolved' && !solved);
        var haystack = (row.getAttribute('data-search') || '').toLowerCase();
        var passSearch = !query || haystack.indexOf(query) !== -1;
        var show = passFilter && passSearch;
        row.hidden = !show;
        if (show) visible += 1;
      });
      if (empty) empty.hidden = visible > 0;
    }

    each(buttons, function (button) {
      button.addEventListener('click', function () {
        filter = button.getAttribute('data-puzzle-filter') || 'all';
        each(buttons, function (item) {
          var active = item === button;
          item.classList.toggle('active', active);
          item.setAttribute('aria-pressed', active ? 'true' : 'false');
        });
        apply();
      });
    });
    if (search) search.addEventListener('input', apply);
    apply();
  }

  /* ------------------------------------------------- table balances (lazy) */

  function initTableBalances() {
    var cells = Array.prototype.slice.call(document.querySelectorAll('[data-balance-address]'));
    if (!cells.length) return;
    var txLinks = {};
    each(document.querySelectorAll('[data-tx-address]'), function (link) {
      txLinks[link.getAttribute('data-tx-address')] = link;
    });

    var queue = [];
    var queued = {};
    var active = 0;
    var cache = {};

    function paint(address, value) {
      each(document.querySelectorAll('[data-balance-address]'), function (cell) {
        if (cell.getAttribute('data-balance-address') !== address) return;
        cell.textContent = value.balance;
        cell.title = value.error ? value.error : 'live via mempool.space';
      });
      var link = txLinks[address];
      if (link && value.tx) link.textContent = value.tx;
    }

    async function fetchOne(address) {
      if (cache[address]) {
        paint(address, cache[address]);
        return;
      }
      active += 1;
      try {
        var response = await fetch(MEMPOOL_ADDRESS + encodeURIComponent(address), {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        var data = await response.json();
        var stats = data && data.chain_stats;
        if (!stats) throw new Error('unexpected response');
        var sats = num(stats.funded_txo_sum) - num(stats.spent_txo_sum);
        var value = {
          balance: (sats / 1e8).toFixed(8) + ' BTC',
          tx: formatCount(stats.tx_count) + ' tx'
        };
        cache[address] = value;
        paint(address, value);
      } catch (err) {
        cache[address] = { balance: 'n/a', tx: '—', error: 'balance unavailable' };
        paint(address, cache[address]);
      } finally {
        active -= 1;
        pump();
      }
    }

    function pump() {
      while (active < BALANCE_CONCURRENCY && queue.length) {
        fetchOne(queue.shift());
      }
    }

    function enqueue(address) {
      if (!address || queued[address]) return;
      queued[address] = true;
      queue.push(address);
      pump();
    }

    if ('IntersectionObserver' in window) {
      var observer = new IntersectionObserver(function (entries) {
        each(entries, function (entry) {
          if (!entry.isIntersecting) return;
          observer.unobserve(entry.target);
          enqueue(entry.target.getAttribute('data-balance-address'));
        });
      }, { rootMargin: '240px' });
      each(cells, function (cell) { observer.observe(cell); });
    } else {
      each(cells.slice(0, 24), function (cell) {
        enqueue(cell.getAttribute('data-balance-address'));
      });
    }
  }

  /* ------------------------------------------------------------ community */

  function initCommunity(root, getStats) {
    var box = root.querySelector('[data-puzzle-community]');
    if (!box) return;
    var state = box.querySelector('[data-puzzle-community-state]');
    var statsBox = box.querySelector('[data-puzzle-community-stats]');
    var sessionMode = false;
    var timer = null;
    var sessionTimer = null;

    function clearStats() {
      if (!statsBox) return;
      while (statsBox.firstChild) statsBox.removeChild(statsBox.firstChild);
    }

    function addStat(label, value, note) {
      var stat = document.createElement('div');
      stat.className = 'pz-stat';
      var name = document.createElement('span');
      name.className = 'pz-stat-label';
      name.textContent = label;
      var amount = document.createElement('span');
      amount.className = 'pz-stat-value';
      amount.textContent = value;
      stat.appendChild(name);
      stat.appendChild(amount);
      if (note) {
        var small = document.createElement('span');
        small.className = 'pz-stat-note';
        small.textContent = note;
        stat.appendChild(small);
      }
      if (statsBox) statsBox.appendChild(stat);
    }

    function renderSession(note) {
      sessionMode = true;
      var stats = getStats();
      if (state) state.textContent = note;
      clearStats();
      if (statsBox) statsBox.hidden = false;
      addStat('Session keys', formatCount(stats.generated), 'this tab only');
      addStat('Session matches', stats.match ? '1' : '0', 'this tab only');
      addStat('Workers', String(stats.workers), 'local WASM');
      addStat('Network', '0', 'nothing uploaded');
    }

    function renderSummary(data) {
      var totals = data && data.totals ? data.totals : {};
      sessionMode = false;
      if (state) state.textContent = 'Coordinator pool totals, refreshed every 20 s.';
      clearStats();
      if (statsBox) statsBox.hidden = false;
      addStat('Keys scanned', formatCount(totals.scanned), 'pool-wide');
      addStat('Active clients', formatCount(totals.clients_active), 'holding leases');
      addStat('Results found', formatCount(totals.results), 'all jobs');
      addStat('Public jobs', formatCount(totals.jobs), 'in the pool');
    }

    async function load() {
      try {
        var response = await fetch(SUMMARY_ENDPOINT, {
          headers: { Accept: 'application/json' },
          cache: 'no-store',
          credentials: 'omit'
        });
        if (!response.ok) throw new Error('HTTP ' + response.status);
        renderSummary(await response.json());
      } catch (err) {
        renderSession('Coordinator summary unavailable — showing session-only counters.');
      }
    }

    function tickSession() {
      if (!sessionMode) return;
      renderSession('Coordinator summary unavailable — showing session-only counters.');
    }

    load();
    timer = window.setInterval(load, SUMMARY_REFRESH_MS);
    sessionTimer = window.setInterval(tickSession, 3000);
    window.addEventListener('pagehide', function () {
      if (timer !== null) window.clearInterval(timer);
      if (sessionTimer !== null) window.clearInterval(sessionTimer);
    });
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
    var storageKey = 'rotor.puzzle.' + number + '.range';

    var els = {
      workerCount: root.querySelector('[data-puzzle-workers]'),
      startInput: root.querySelector('[data-puzzle-start-input]'),
      endInput: root.querySelector('[data-puzzle-end-input]'),
      startBtn: root.querySelector('[data-puzzle-start-btn]'),
      stopBtn: root.querySelector('[data-puzzle-stop-btn]'),
      resetBtn: root.querySelector('[data-puzzle-reset-btn]'),
      resumeBtn: root.querySelector('[data-puzzle-resume-btn]'),
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
      progressText: root.querySelector('[data-puzzle-progress-text]'),
      results: root.querySelector('[data-puzzle-results]'),
      resultsEmpty: root.querySelector('[data-puzzle-results-empty]'),
      resultsCount: root.querySelector('[data-puzzle-results-count]')
    };
    var modeButtons = Array.prototype.slice.call(root.querySelectorAll('[data-puzzle-mode]'));
    var presetButtons = root.querySelectorAll('[data-range-preset]');

    var workers = [];
    var running = false;
    var found = null;
    var progressTimer = null;
    var sampleTimer = null;
    var sampleCursor = 0;
    var resultSeq = 0;
    var scanAnnounced = false;

    if (puzzleStart === null || puzzleEnd === null || puzzleEnd < puzzleStart) {
      setState('The puzzle range could not be parsed; the local scan is disabled.');
      setStartEnabled(false);
      return;
    }

    function setState(text) {
      if (els.state) els.state.textContent = text;
    }

    function modeValue() {
      for (var i = 0; i < modeButtons.length; i++) {
        if (modeButtons[i].classList.contains('active')) {
          return modeButtons[i].getAttribute('data-mode-value') || 'random';
        }
      }
      return 'random';
    }

    function setMode(value) {
      each(modeButtons, function (button) {
        var active = button.getAttribute('data-mode-value') === value;
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function setStartEnabled(enabled) {
      if (!els.startBtn) return;
      els.startBtn.disabled = !enabled || modeValue() === 'team';
    }

    function setStopEnabled(enabled) {
      if (els.stopBtn) els.stopBtn.disabled = !enabled;
    }

    function updateResume() {
      if (!els.resumeBtn) return;
      els.resumeBtn.disabled = running || !savedSession();
    }

    function setControlsEnabled(enabled) {
      each(modeButtons, function (button) { button.disabled = !enabled; });
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
      updateResume();
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

    function savedSession() {
      try {
        var raw = window.localStorage.getItem(storageKey);
        if (!raw) return null;
        var saved = JSON.parse(raw);
        var start = parseHex(saved && saved.start);
        var end = parseHex(saved && saved.end);
        if (start === null || end === null || start > end) return null;
        if (start < puzzleStart || end > puzzleEnd) return null;
        return { start: start, end: end, mode: saved.mode, workers: saved.workers };
      } catch (err) {
        return null;
      }
    }

    function saveSession() {
      try {
        var range = currentRange();
        if (!range) return;
        window.localStorage.setItem(storageKey, JSON.stringify({
          start: padHex(range.start),
          end: padHex(range.end),
          mode: modeValue(),
          workers: readWorkerCount()
        }));
      } catch (err) { /* storage disabled */ }
      updateResume();
    }

    function clearSession() {
      try { window.localStorage.removeItem(storageKey); } catch (err) { /* storage disabled */ }
      updateResume();
    }

    function resumeSession() {
      if (running) return;
      var saved = savedSession();
      if (!saved) {
        setState('No saved range in this browser. Start a scan first.');
        updateResume();
        return;
      }
      if (els.startInput) els.startInput.value = padHex(saved.start);
      if (els.endInput) els.endInput.value = padHex(saved.end);
      if (saved.mode === 'team' || saved.mode === 'seq' || saved.mode === 'random') setMode(saved.mode);
      if (els.workerCount && saved.workers >= 1 && saved.workers <= MAX_WORKERS) {
        els.workerCount.value = String(saved.workers);
      }
      for (var i = 0; i < presetButtons.length; i++) presetButtons[i].classList.remove('active');
      setState('Restored the last saved range. Press Start to continue.');
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
      if (message.type === 'sample') {
        if (message.address) {
          addResult({ key: String(message.key || ''), address: String(message.address || '') });
        }
        return;
      }
      if (message.type === 'match') {
        entry.generated = num(message.generated) || entry.generated;
        entry.done = true;
        found = {
          key: String(message.key || ''),
          address: String(message.address || '')
        };
        addResult({ key: found.key, address: found.address, match: true });
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

    function updateResultCount() {
      if (!els.results) return;
      var count = els.results.children.length;
      if (els.resultsCount) {
        els.resultsCount.textContent = count === 1 ? '1 row' : count + ' rows';
      }
      if (els.resultsEmpty) els.resultsEmpty.hidden = count > 0;
    }

    function clearResults() {
      if (els.results) {
        while (els.results.firstChild) els.results.removeChild(els.results.firstChild);
      }
      resultSeq = 0;
      updateResultCount();
    }

    function addResult(entry) {
      if (!els.results) return;
      resultSeq += 1;
      var row = document.createElement('tr');
      var values = [
        ['#', '#' + resultSeq, 'pz-num'],
        ['Private key', entry.key || '—', 'pz-key-cell'],
        ['Address', entry.address || '—', 'pz-addr-cell'],
        ['Balance', entry.balance || '—', null],
        ['Received', entry.received || '—', null],
        ['Match', entry.match ? 'Yes' : 'No', entry.match ? 'is-match' : null]
      ];
      for (var i = 0; i < values.length; i++) {
        var cell = document.createElement('td');
        cell.setAttribute('data-label', values[i][0]);
        if (values[i][2]) cell.className = values[i][2];
        cell.textContent = values[i][1];
        row.appendChild(cell);
      }
      els.results.insertBefore(row, els.results.firstChild);
      while (els.results.children.length > MAX_RESULT_ROWS) {
        els.results.removeChild(els.results.lastChild);
      }
      updateResultCount();
    }

    function startSampling() {
      stopSampling();
      sampleCursor = 0;
      sampleTimer = window.setInterval(function () {
        if (!running || !workers.length) return;
        var attempts = 0;
        while (attempts < workers.length) {
          var entry = workers[sampleCursor % workers.length];
          sampleCursor += 1;
          attempts += 1;
          if (!entry || entry.done) continue;
          try {
            entry.worker.postMessage({ type: 'sample', key: padHex(randomInRange(puzzleStart, puzzleEnd)) });
          } catch (err) { /* worker already gone */ }
          return;
        }
      }, SAMPLE_INTERVAL_MS);
    }

    function stopSampling() {
      if (sampleTimer !== null) {
        window.clearInterval(sampleTimer);
        sampleTimer = null;
      }
    }

    function halt(message) {
      running = false;
      stopSampling();
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
      updateResume();
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

      saveSession();
      workers = [];
      found = null;
      scanAnnounced = false;
      hideMatch();
      clearResults();
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
      startSampling();
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
      clearResults();
      clearSession();
      resetRange();
      setMode('random');
      setState('Reset. Ready to start a fresh scan.');
      renderStats();
      updateProgress();
    }

    /* --------------------------------------------------------------- wiring */

    if (els.startBtn) els.startBtn.addEventListener('click', startScan);
    if (els.stopBtn) els.stopBtn.addEventListener('click', stopScan);
    if (els.resetBtn) els.resetBtn.addEventListener('click', resetScan);
    if (els.resumeBtn) els.resumeBtn.addEventListener('click', resumeSession);

    each(modeButtons, function (button) {
      button.addEventListener('click', function () {
        if (running) return;
        setMode(button.getAttribute('data-mode-value'));
        var team = modeValue() === 'team';
        if (els.teamNote) els.teamNote.hidden = !team;
        setStartEnabled(!team);
        if (team) setState('Team mode selected. Local scanning is off; use the pooled job board for leased chunks.');
        else setState('Ready. Press Start or Space.');
      });
    });

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
    updateResultCount();
    updateResume();
    renderStats();
    updateProgress();
    initCommunity(root, function () {
      var sums = totals();
      return {
        generated: sums.generated,
        match: Boolean(found),
        workers: running ? workers.length : 0
      };
    });
  }

  function boot() {
    initCopy();
    initPicker();
    initFilter();
    initTableBalances();
    initBalance();
    initApp();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
