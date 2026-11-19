/* Seed studio: BIP39, Electrum BIP39 and legacy Electrum derivation for /seed
 * and /mnemonic-converter. One engine, two pages.
 *
 * The phrase, passphrase, seed and private keys stay in this tab. Only public
 * addresses are sent, and they are sent automatically after a derivation. */
(function () {
  'use strict';

  var WASM_URL = '/rotor_wasm.wasm';
  var DECODER = new TextDecoder('utf-8');
  var BALANCE_TIMEOUT_MS = 12000;

  var CHAINS = {
    bitcoin: {
      label: 'Bitcoin',
      explorer: 'https://mempool.space/address/',
      presets: [
        { id: 'btc_p2pkh', label: 'BIP44 · Legacy', path: "m/44'/0'/0'/0/0" },
        { id: 'btc_p2sh_p2wpkh', label: 'BIP49 · Nested SegWit', path: "m/49'/0'/0'/0/0" },
        { id: 'btc_p2wpkh', label: 'BIP84 · Native SegWit', path: "m/84'/0'/0'/0/0" },
        { id: 'btc_p2tr', label: 'BIP86 · Taproot', path: "m/86'/0'/0'/0/0" }
      ]
    },
    ethereum: {
      label: 'Ethereum / EVM',
      explorer: 'https://etherscan.io/address/',
      presets: [{ id: 'evm', label: 'BIP44 · Ethereum', path: "m/44'/60'/0'/0/0" }]
    },
    tron: {
      label: 'TRON',
      explorer: 'https://tronscan.org/#/address/',
      presets: [{ id: 'tron', label: 'BIP44 · TRON', path: "m/44'/195'/0'/0/0" }]
    },
    litecoin: {
      label: 'Litecoin',
      explorer: 'https://blockchair.com/litecoin/address/',
      presets: [
        { id: 'ltc_p2pkh', label: 'BIP44 · Legacy', path: "m/44'/2'/0'/0/0" },
        { id: 'ltc_p2sh_p2wpkh', label: 'BIP49 · Nested SegWit', path: "m/49'/2'/0'/0/0" },
        { id: 'ltc_p2wpkh', label: 'BIP84 · Native SegWit', path: "m/84'/2'/0'/0/0" }
      ]
    },
    dogecoin: {
      label: 'Dogecoin',
      explorer: 'https://blockchair.com/dogecoin/address/',
      presets: [{ id: 'doge_p2pkh', label: 'BIP44 · Dogecoin', path: "m/44'/3'/0'/0/0" }]
    },
    'bitcoin-cash': {
      label: 'Bitcoin Cash',
      explorer: 'https://blockchair.com/bitcoin-cash/address/',
      presets: [{ id: 'bch_legacy', label: 'BIP44 · Bitcoin Cash', path: "m/44'/145'/0'/0/0" }]
    },
    xrp: {
      label: 'XRP',
      explorer: 'https://xrpscan.com/account/',
      presets: [{ id: 'xrp_classic', label: 'BIP44 · XRP', path: "m/44'/144'/0'/0/0" }]
    }
  };
  var CHAIN_ORDER = ['bitcoin', 'ethereum', 'tron', 'litecoin', 'dogecoin', 'bitcoin-cash', 'xrp'];
  var EVM_RPC = 'https://ethereum-rpc.publicnode.com';
  var BTC_BALANCE_URL = 'https://blockchain.info/balance?cors=true&active=';
  var WORDS = [12, 15, 18, 21, 24];

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('seed-form');
  if (!form) return;

  var schemeEl = byId('seed-scheme');
  var wordsEl = byId('seed-words');
  var chainEl = byId('seed-chain');
  var pathEl = byId('seed-path');
  var allPathsEl = byId('seed-all-paths');
  var phraseEl = byId('seed-phrase');
  var passphraseEl = byId('seed-passphrase');
  var errorEl = byId('seed-error');
  var statusEl = byId('seed-status');
  var helpEl = byId('seed-scheme-help');
  var resultEl = byId('seed-result');
  var rowsEl = byId('seed-rows');
  var countEl = byId('seed-count');
  var csvBtn = byId('seed-csv');
  var deriveBtn = byId('seed-derive');
  var generateBtn = byId('seed-generate');
  var clearBtn = byId('seed-clear');
  var countButtons = Array.prototype.slice.call(document.querySelectorAll('.seed-count-btn'));

  var state = {
    wasmPromise: null,
    busy: false,
    count: 1,
    results: [],
    run: 0,
    balanceAbort: null
  };

  function fail(message) {
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function note(message, isError) {
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.classList.toggle('err', Boolean(isError));
  }

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i += 1) out[i] = parseInt(hex.substr(i * 2, 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function readString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return DECODER.decode(new Uint8Array(wasm.memory.buffer, ptr, length));
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
      return module.instance ? module.instance.exports : module.exports;
    })();
    state.wasmPromise.catch(function () { state.wasmPromise = null; });
    return state.wasmPromise;
  }

  function reportFor(wasm, keyHex) {
    var bytes = hexToBytes(keyHex);
    var ptr = wasm.alloc(bytes.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted.');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, bytes.length).set(bytes);
      var status = wasm.derive_report(ptr, 0) >>> 0;
      if (status !== 0) {
        throw new Error(readString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0) ||
          ('derivation status ' + status));
      }
      return JSON.parse(readString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0));
    } finally {
      wasm.dealloc(ptr, bytes.length);
    }
  }

  function addressOf(report, id) {
    if (!report || !Array.isArray(report.addresses)) return '';
    for (var i = 0; i < report.addresses.length; i += 1) {
      if (report.addresses[i].id === id) return report.addresses[i].address || '';
    }
    return '';
  }

  function copyText(text, button) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fail('Clipboard access is unavailable in this browser. Select the value and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      button.textContent = 'Copied';
      window.setTimeout(function () { button.textContent = 'Copy'; }, 1200);
    }, function () {
      fail('Clipboard access was denied. Select the value and copy it manually.');
    });
  }

  /* ------------------------------------------------------------- controls */

  function schemeValue() {
    return schemeEl ? schemeEl.value : 'bip39';
  }

  function currentChain() {
    return chainEl ? chainEl.value : 'bitcoin';
  }

  function populateChains() {
    if (!chainEl) return;
    var previous = chainEl.value;
    chainEl.textContent = '';
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All supported chains';
    chainEl.appendChild(all);
    CHAIN_ORDER.forEach(function (id) {
      var option = document.createElement('option');
      option.value = id;
      option.textContent = CHAINS[id].label;
      chainEl.appendChild(option);
    });
    chainEl.value = previous && (previous === 'all' || CHAINS[previous]) ? previous : 'all';
  }

  function populatePaths() {
    if (!pathEl) return;
    var previous = pathEl.value;
    pathEl.textContent = '';
    var scheme = schemeValue();
    var chain = currentChain();
    if (scheme === 'electrum-old') {
      var old = document.createElement('option');
      old.value = 'old';
      old.textContent = 'Old sequence';
      pathEl.appendChild(old);
      pathEl.disabled = true;
      return;
    }
    if (chain === 'all') {
      var defaults = document.createElement('option');
      defaults.value = '';
      defaults.textContent = 'Default per chain';
      pathEl.appendChild(defaults);
      pathEl.disabled = true;
      return;
    }
    pathEl.disabled = false;
    var presets = CHAINS[chain] ? CHAINS[chain].presets : [];
    presets.forEach(function (preset) {
      var option = document.createElement('option');
      option.value = preset.path + '|' + preset.id;
      option.textContent = preset.label + ' · ' + preset.path;
      pathEl.appendChild(option);
    });
    var found = Array.prototype.some.call(pathEl.options, function (option) {
      return option.value === previous;
    });
    if (!found && pathEl.options.length) pathEl.selectedIndex = 0;
  }

  function refreshControls() {
    var scheme = schemeValue();
    var old = scheme === 'electrum-old';

    if (wordsEl) {
      Array.prototype.forEach.call(wordsEl.options, function (option) {
        option.disabled = old && [15, 18, 21].indexOf(Number(option.value)) >= 0;
      });
      if (old && [12, 24].indexOf(Number(wordsEl.value)) < 0) wordsEl.value = '12';
    }
    if (passphraseEl) {
      passphraseEl.disabled = old;
      if (old) passphraseEl.value = '';
    }
    if (chainEl) chainEl.disabled = old;
    if (allPathsEl) allPathsEl.disabled = old;
    if (old && chainEl) chainEl.value = 'bitcoin';
    populatePaths();

    if (helpEl) {
      if (old) {
        helpEl.textContent = 'Electrum old: the legacy 1626-word list. The words decode to a hex seed; the master key is 100,000 SHA-256 rounds, and each address uses Electrum\'s old sequence scheme. It has no BIP39 passphrase.';
      } else if (scheme === 'electrum-bip39') {
        helpEl.textContent = 'Electrum BIP39: BIP39 words checked against Electrum\'s seed-version prefix (01 standard, 100 segwit). The master seed is PBKDF2-HMAC-SHA512 with the salt "electrum" and the optional passphrase, then BIP32 along the selected path.';
      } else {
        helpEl.textContent = 'BIP39: the phrase checksum is validated, and the master seed is PBKDF2-HMAC-SHA512 with the salt "mnemonic" and the optional passphrase, then BIP32 along the selected path.';
      }
    }
  }

  function setCount(value) {
    state.count = value;
    countButtons.forEach(function (button) {
      var active = Number(button.getAttribute('data-count')) === value;
      button.classList.toggle('active', active);
      button.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
  }

  function invalidate() {
    state.run += 1;
    state.busy = false;
    state.results = [];
    if (state.balanceAbort) {
      try { state.balanceAbort.abort(); } catch (err) { /* already aborted */ }
      state.balanceAbort = null;
    }
    if (rowsEl) rowsEl.textContent = '';
    if (resultEl) resultEl.hidden = true;
    if (csvBtn) csvBtn.hidden = true;
    if (countEl) countEl.textContent = '';
    if (deriveBtn) {
      deriveBtn.disabled = false;
      deriveBtn.textContent = 'Convert & derive';
    }
    if (generateBtn) generateBtn.disabled = false;
  }

  /* --------------------------------------------------------- phrase checks */

  var bip39Set = null;
  function bip39WordSet() {
    if (bip39Set) return bip39Set;
    var words = window.RotorSeedCrypto.bip39Words();
    bip39Set = Object.create(null);
    words.forEach(function (word) { bip39Set[word] = true; });
    return bip39Set;
  }

  function cleanPhrase(text) {
    return String(text || '').trim().replace(/\s+/g, ' ').toLowerCase();
  }

  async function inspectPhrase(phrase) {
    var scheme = schemeValue();
    if (scheme === 'electrum-old') {
      if (passphraseEl && passphraseEl.value) {
        throw new Error('Electrum old seeds do not support a passphrase.');
      }
      var old = window.RotorSeedCrypto.validateOld(phrase);
      return { scheme: scheme, phrase: old.words.join(' '), seedHex: old.seedHex, seedType: 'old' };
    }

    if (scheme === 'electrum-bip39') {
      var electrum = await window.RotorSeedCrypto.validateElectrumBip39(phrase);
      return {
        scheme: scheme,
        phrase: electrum.phrase,
        passphrase: passphraseEl ? passphraseEl.value : '',
        seedType: electrum.seedType
      };
    }

    var words = phrase.split(' ');
    if (WORDS.indexOf(words.length) < 0) {
      throw new Error('A BIP39 mnemonic has 12, 15, 18, 21 or 24 words; this one has ' + words.length + '.');
    }
    var known = bip39WordSet();
    for (var i = 0; i < words.length; i += 1) {
      if (!known[words[i]]) throw new Error('Unknown BIP39 word: "' + words[i] + '".');
    }
    if (!window.RotorSeed.validate(words.join(' '))) {
      throw new Error('BIP39 checksum does not match. Check the words and their order.');
    }
    return {
      scheme: 'bip39',
      phrase: words.join(' '),
      passphrase: passphraseEl ? passphraseEl.value : '',
      seedType: 'bip39'
    };
  }

  /* ------------------------------------------------------------ selection */

  function presetTargets(chain) {
    var config = CHAINS[chain];
    if (!config) return [];
    if (allPathsEl && allPathsEl.checked) {
      return config.presets.map(function (preset) {
        return { chain: chain, chainLabel: config.label, explorer: config.explorer, preset: preset };
      });
    }
    if (chainEl && chainEl.value === chain) {
      var chosen = pathEl && pathEl.value ? pathEl.value.split('|') : [];
      var match = null;
      config.presets.forEach(function (preset) {
        if (preset.path === chosen[0] && preset.id === chosen[1]) match = preset;
      });
      if (match) {
        return [{ chain: chain, chainLabel: config.label, explorer: config.explorer, preset: match }];
      }
    }
    return [{ chain: chain, chainLabel: config.label, explorer: config.explorer, preset: config.presets[0] }];
  }

  function selectedTargets() {
    if (schemeValue() === 'electrum-old') {
      return [{
        chain: 'bitcoin',
        chainLabel: 'Bitcoin (Electrum old)',
        explorer: CHAINS.bitcoin.explorer,
        preset: { id: 'btc_p2pkh_uncompressed', label: 'Electrum old address', path: 'old' }
      }];
    }
    var chain = currentChain();
    if (chain === 'all') {
      var targets = [];
      CHAIN_ORDER.forEach(function (id) {
        targets = targets.concat(presetTargets(id));
      });
      return targets;
    }
    return presetTargets(chain);
  }

  function withIndex(path, index) {
    var parts = path.split('/');
    var last = parts[parts.length - 1];
    var hardened = /['hH]$/.test(last);
    parts[parts.length - 1] = hardened ? index + "'" : String(index);
    return parts.join('/');
  }

  /* ------------------------------------------------------------- deriving */

  async function deriveAll() {
    if (state.busy) return;
    fail('');
    if (!window.RotorSeed || !window.RotorSeedCrypto) {
      fail('The seed libraries did not load. Reload the page.');
      return;
    }
    var phrase = cleanPhrase(phraseEl ? phraseEl.value : '');
    if (!phrase) {
      fail('Paste a mnemonic first.');
      if (phraseEl) phraseEl.focus();
      return;
    }

    invalidate();
    state.busy = true;
    state.run += 1;
    var run = state.run;
    deriveBtn.disabled = true;
    if (generateBtn) generateBtn.disabled = true;
    deriveBtn.textContent = 'Deriving…';
    note('Validating the phrase locally…');

    try {
      var info = await inspectPhrase(phrase);
      if (run !== state.run) return;
      note('Deriving addresses in this browser…');
      var wasm = await loadWasm();
      var report = function (keyHex) { return reportFor(wasm, keyHex); };
      var pubkeyFor = async function (keyHex) {
        return hexToBytes(report(keyHex).pubkey_compressed);
      };

      var targets = selectedTargets();
      var total = targets.length * state.count;
      var done = 0;
      var results = [];

      if (info.scheme === 'electrum-old') {
        var old = await window.RotorSeedCrypto.oldPrivateKeys(info.seedHex, state.count, function (keyHex) {
          return report(keyHex);
        });
        for (var oi = 0; oi < old.keys.length; oi += 1) {
          var oldReport = report(old.keys[oi]);
          results.push(makeResult(targets[0], 'old/0/' + oi, old.keys[oi], oldReport));
          done += 1;
          note('Deriving ' + done + ' of ' + total + '…');
        }
      } else {
        var seed;
        if (info.scheme === 'bip39') {
          seed = await window.RotorSeedCrypto.bip39Seed(info.phrase, info.passphrase);
        } else {
          seed = await window.RotorSeedCrypto.electrumSeed(info.phrase, info.passphrase);
        }
        for (var ti = 0; ti < targets.length; ti += 1) {
          var target = targets[ti];
          for (var index = 0; index < state.count; index += 1) {
            if (run !== state.run) return;
            var path = withIndex(target.preset.path, index);
            var keyHex = await window.RotorSeedCrypto.bip32PrivateKey(seed, path, pubkeyFor);
            results.push(makeResult(target, path, keyHex, report(keyHex)));
            done += 1;
            note('Deriving ' + done + ' of ' + total + '…');
            if (done % 5 === 0) await new Promise(function (resolve) { window.setTimeout(resolve, 0); });
          }
        }
      }

      if (run !== state.run) return;
      state.results = results;
      renderGroups(results);
      var versions = {
        bip39: 'BIP39',
        standard: 'Electrum standard (seed version 01)',
        segwit: 'Electrum segwit (seed version 100)',
        old: 'Electrum old (1626-word legacy scheme)'
      };

      note('Derived ' + results.length + ' address' + (results.length === 1 ? '' : 'es') +
        '. Seed type: ' + versions[info.seedType] + '. Checking public balances…');
      await checkBalances();
    } catch (err) {
      if (run === state.run) {
        state.results = [];
        fail(err && err.message ? err.message : 'Derivation failed.');
        note('Nothing was derived. The phrase stays in this tab.', true);
      }
    } finally {
      if (run === state.run) {
        state.busy = false;
        deriveBtn.disabled = false;
        if (generateBtn) generateBtn.disabled = false;
        deriveBtn.textContent = 'Convert & derive';
      }
    }
  }

  function makeResult(target, path, keyHex, report) {
    return {
      chain: target.chain,
      chainLabel: target.chainLabel,
      explorer: target.explorer,
      presetLabel: target.preset.label,
      path: path,
      address: addressOf(report, target.preset.id),
      privHex: keyHex,
      wifCompressed: report.wif_compressed || '',
      wifUncompressed: report.wif_uncompressed || '',
      balanceEl: null
    };
  }

  /* ------------------------------------------------------------ rendering */

  function renderGroups(results) {
    if (!rowsEl) return;
    rowsEl.textContent = '';
    var groups = [];
    var index = Object.create(null);
    results.forEach(function (entry) {
      var key = entry.chainLabel;
      if (!(key in index)) {
        index[key] = groups.length;
        groups.push({ label: key, entries: [] });
      }
      groups[index[key]].entries.push(entry);
    });
    groups.forEach(function (group) {
      var section = document.createElement('section');
      section.className = 'seed-group';
      var head = document.createElement('div');
      head.className = 'seed-group-head';
      var title = document.createElement('h3');
      title.textContent = group.label;
      var meta = document.createElement('span');
      meta.textContent = group.entries.length + ' address' + (group.entries.length === 1 ? '' : 'es');
      head.appendChild(title);
      head.appendChild(meta);
      section.appendChild(head);
      var list = document.createElement('div');
      list.className = 'seed-rows';
      group.entries.forEach(function (entry) { list.appendChild(rowFor(entry)); });
      section.appendChild(list);
      rowsEl.appendChild(section);
    });
    if (countEl) {
      countEl.textContent = results.length + ' address' + (results.length === 1 ? '' : 'es') +
        ' · ' + groups.length + ' group' + (groups.length === 1 ? '' : 's');
    }
    if (resultEl) resultEl.hidden = false;
    if (csvBtn) csvBtn.hidden = results.length === 0;
    if (resultEl && resultEl.scrollIntoView) {
      resultEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function rowFor(entry) {
    var row = document.createElement('div');
    row.className = 'seed-row';

    var head = document.createElement('div');
    head.className = 'seed-row-head seed-row-title';
    var title = document.createElement('h4');
    title.textContent = entry.presetLabel;
    var path = document.createElement('span');
    path.className = 'seed-path mono';
    path.textContent = entry.path;
    head.appendChild(title);
    head.appendChild(path);
    row.appendChild(head);

    var addressLine = document.createElement('div');
    addressLine.className = 'key-addr-line';
    if (entry.address) {
      var link = document.createElement('a');
      link.className = 'mono key-addr address-link';
      link.href = entry.explorer + encodeURIComponent(entry.address);
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      link.textContent = entry.address;
      link.title = entry.address;
      addressLine.appendChild(link);
    } else {
      var missing = document.createElement('code');
      missing.className = 'mono key-addr';
      missing.textContent = 'Not available for this address type.';
      addressLine.appendChild(missing);
    }
    var copyAddress = document.createElement('button');
    copyAddress.type = 'button';
    copyAddress.className = 'key-copy';
    copyAddress.textContent = 'Copy';
    copyAddress.addEventListener('click', function () { copyText(entry.address, copyAddress); });
    addressLine.appendChild(copyAddress);
    row.appendChild(addressLine);

    if (entry.chain === 'bitcoin') {
      [['WIF (compressed)', entry.wifCompressed], ['WIF (uncompressed)', entry.wifUncompressed]].forEach(function (pair) {
        if (!pair[1]) return;
        var wif = document.createElement('a');
        wif.className = 'wif-line';
        wif.href = '/key/' + encodeURIComponent(pair[1]);
        wif.textContent = pair[1];
        wif.title = pair[0] + ': ' + pair[1];
        row.appendChild(wif);
      });
    }

    var details = document.createElement('details');
    details.className = 'key-steps';
    var summary = document.createElement('summary');
    summary.textContent = 'Private key and WIF';
    details.appendChild(summary);
    var body = document.createElement('div');
    body.className = 'seed-key-body';
    [['Hex', entry.privHex], ['WIF (compressed)', entry.wifCompressed], ['WIF (uncompressed)', entry.wifUncompressed]].forEach(function (pair) {
      if (!pair[1]) return;
      var line = document.createElement('div');
      line.className = 'detail-line';
      var label = document.createElement('span');
      label.className = 'detail-label';
      label.textContent = pair[0];
      var value = document.createElement('code');
      value.className = 'mono detail-value';
      value.textContent = pair[1];
      var copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = 'Copy';
      copy.addEventListener('click', function () { copyText(pair[1], copy); });
      line.appendChild(label);
      line.appendChild(value);
      line.appendChild(copy);
      body.appendChild(line);
    });
    details.appendChild(body);
    row.appendChild(details);

    var balance = document.createElement('p');
    balance.className = 'seed-balance';
    balance.textContent = 'Waiting for the public balance…';
    row.appendChild(balance);
    entry.balanceEl = balance;
    entry.rowEl = row;
    return row;
  }

  /* ------------------------------------------------------------- balances */

  function coin(value, decimals) {
    var number = Number(value) / Math.pow(10, decimals);
    if (!isFinite(number)) return '0';
    if (number === 0) return '0';
    if (number < 0.00000001) return '<0.00000001';
    return number.toLocaleString('en-US', { maximumFractionDigits: decimals > 8 ? 6 : 8 });
  }

  function iconUse(name) {
    var svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    use.setAttribute('href', '/icons.svg#' + name);
    svg.appendChild(use);
    return svg;
  }

  function ensureBalance(entry) {
    if (entry.balanceEl) return entry.balanceEl;
    if (!entry.rowEl) return null;
    var balance = document.createElement('p');
    balance.className = 'seed-balance';
    balance.textContent = 'Checking the public balance…';
    entry.rowEl.appendChild(balance);
    entry.balanceEl = balance;
    return balance;
  }

  function setBalance(entry, text, isError) {
    var element = ensureBalance(entry);
    if (!element) return;
    element.className = 'seed-balance' + (isError ? ' err' : '');
    element.textContent = text;
  }

  function showBalanceError(entry, message) {
    var element = ensureBalance(entry);
    if (!element) return;
    element.className = 'seed-balance err';
    element.textContent = message + ' ';
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'seed-balance-retry';
    button.title = 'Retry this balance';
    button.setAttribute('aria-label', 'Retry balance check for this address');
    button.appendChild(iconUse('ui-retry'));
    button.addEventListener('click', function () {
      setBalance(entry, 'Checking the public balance…');
      retryEntry(entry);
    });
    element.appendChild(button);
  }

  function balanceFetch(url, options, signal) {
    var controller = new AbortController();
    var timer = window.setTimeout(function () { controller.abort(); }, BALANCE_TIMEOUT_MS);
    var onAbort = null;
    if (signal) {
      if (signal.aborted) {
        window.clearTimeout(timer);
        controller.abort();
      } else {
        onAbort = function () { controller.abort(); };
        signal.addEventListener('abort', onAbort);
      }
    }
    var settings = options || {};
    settings.signal = controller.signal;
    return fetch(url, settings).finally(function () {
      window.clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener('abort', onAbort);
    });
  }

  async function withAutoRetry(task, signal) {
    try {
      return await task();
    } catch (err) {
      if (signal && signal.aborted) throw err;
      await new Promise(function (resolve) { window.setTimeout(resolve, 600); });
      if (signal && signal.aborted) throw err;
      return task();
    }
  }

  async function checkBtcRows(entries, run, signal) {
    var addresses = Array.from(new Set(entries.map(function (entry) { return entry.address; })));
    try {
      var response = await withAutoRetry(function () {
        return balanceFetch(BTC_BALANCE_URL + addresses.map(encodeURIComponent).join('|'), null, signal);
      }, signal);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var data = await response.json();
      if (run !== state.run) return;
      entries.forEach(function (entry) {
        var info = data[entry.address];
        if (!info) {
          showBalanceError(entry, 'Balance row missing from the provider.');
          return;
        }
        setBalance(entry, coin(info.final_balance, 8) + ' BTC · ' + Number(info.n_tx || 0) + ' tx');
      });
    } catch (err) {
      if (run !== state.run || (signal && signal.aborted)) return;
      entries.forEach(function (entry) { showBalanceError(entry, 'Balance lookup failed.'); });
    }
  }

  async function checkEvmRows(entries, run, signal) {
    var addresses = Array.from(new Set(entries.map(function (entry) { return entry.address; })));
    var payload = addresses.map(function (address, index) {
      return { jsonrpc: '2.0', id: index + 1, method: 'eth_getBalance', params: [address, 'latest'] };
    });
    try {
      var response = await withAutoRetry(function () {
        return balanceFetch(EVM_RPC, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        }, signal);
      }, signal);
      if (!response.ok) throw new Error('HTTP ' + response.status);
      var list = await response.json();
      if (run !== state.run) return;
      var byAddress = Object.create(null);
      (Array.isArray(list) ? list : []).forEach(function (item) {
        var address = addresses[item.id - 1];
        if (address) byAddress[address] = BigInt(item.result || '0x0');
      });
      entries.forEach(function (entry) {
        var value = byAddress[entry.address];
        if (value === undefined) {
          showBalanceError(entry, 'Balance row missing from the provider.');
          return;
        }
        setBalance(entry, coin(value, 18) + ' ETH');
      });
    } catch (err) {
      if (run !== state.run || (signal && signal.aborted)) return;
      entries.forEach(function (entry) { showBalanceError(entry, 'Balance lookup failed.'); });
    }
  }

  function balanceRows(chain) {
    return state.results.filter(function (entry) {
      return entry.chain === chain && entry.address && entry.balanceEl;
    });
  }

  function retryEntry(entry) {
    if (!entry.address) return;
    var run = state.run;
    if (entry.chain === 'bitcoin') checkBtcRows([entry], run, null);
    else if (entry.chain === 'ethereum') checkEvmRows([entry], run, null);
    else setBalance(entry, 'Explorer only — no public balance adapter here.');
  }

  async function checkBalances() {
    if (!state.results.length) return;
    if (state.balanceAbort) {
      try { state.balanceAbort.abort(); } catch (err) { /* already aborted */ }
    }
    var controller = new AbortController();
    state.balanceAbort = controller;
    var run = state.run;

    var btc = balanceRows('bitcoin');
    var evm = balanceRows('ethereum');
    state.results.forEach(function (entry) {
      if (entry.chain !== 'bitcoin' && entry.chain !== 'ethereum') {
        setBalance(entry, 'Explorer only — no public balance adapter here.');
      } else if (!entry.address) {
        setBalance(entry, 'No public address for this derivation type.');
      } else {
        setBalance(entry, 'Checking the public balance…');
      }
    });

    if (!btc.length && !evm.length) {
      note('No public address to check for this selection. Only derived addresses are ever sent.');
      state.balanceAbort = null;
      return;
    }

    note('Checking public balances. Only the derived public addresses are sent: blockchain.info for BTC and a public Ethereum JSON-RPC endpoint for EVM.');
    await Promise.all([
      btc.length ? checkBtcRows(btc, run, controller.signal) : Promise.resolve(),
      evm.length ? checkEvmRows(evm, run, controller.signal) : Promise.resolve()
    ]);
    if (run !== state.run) return;
    if (state.balanceAbort === controller) state.balanceAbort = null;
    note('Balances loaded from public providers. They can lag the chain; only public addresses were sent.');
  }

  /* ------------------------------------------------------------------ csv */

  function csvCell(value) {
    var text = String(value == null ? '' : value);
    return /[",\n]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
  }

  function exportCsv() {
    if (!state.results.length) return;
    var lines = ['chain,path,address'];
    state.results.forEach(function (entry) {
      lines.push([csvCell(entry.chainLabel), csvCell(entry.path), csvCell(entry.address)].join(','));
    });
    var blob = new Blob([lines.join('\n') + '\n'], { type: 'text/csv;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = 'rotor-seed-addresses.csv';
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  /* ------------------------------------------------------------- generate */

  async function generate() {
    if (state.busy) return;
    fail('');
    var scheme = schemeValue();
    var count = wordsEl ? Number(wordsEl.value) : 12;
    if (scheme === 'electrum-old' && count !== 12 && count !== 24) count = 12;
    state.busy = true;
    if (generateBtn) generateBtn.disabled = true;
    if (deriveBtn) deriveBtn.disabled = true;
    note('Generating a phrase locally…');
    try {
      var phrase;
      if (scheme === 'electrum-old') {
        phrase = window.RotorSeedCrypto.generateOld(count);
      } else if (scheme === 'electrum-bip39') {
        phrase = await window.RotorSeedCrypto.generateElectrumBip39(count);
      } else {
        phrase = window.RotorSeedCrypto.generateBip39(count);
      }
      phraseEl.value = phrase;
      if (passphraseEl) passphraseEl.value = '';
      note('New phrase generated in this tab. Write it down offline; it is not stored.');
    } catch (err) {
      fail(err && err.message ? err.message : 'Could not generate a phrase.');
    } finally {
      state.busy = false;
      if (generateBtn) generateBtn.disabled = false;
      if (deriveBtn) deriveBtn.disabled = false;
    }
  }

  /* ----------------------------------------------------------------- boot */

  function clearAll() {
    state.run += 1;
    state.results = [];
    if (state.balanceAbort) {
      try { state.balanceAbort.abort(); } catch (err) { /* already aborted */ }
      state.balanceAbort = null;
    }
    if (phraseEl) phraseEl.value = '';
    if (passphraseEl) passphraseEl.value = '';
    if (rowsEl) rowsEl.textContent = '';
    if (resultEl) resultEl.hidden = true;
    if (csvBtn) csvBtn.hidden = true;
    if (countEl) countEl.textContent = '';
    fail('');
    note('Cleared. The phrase, passphrase and results were removed from this tab.');
    if (phraseEl) phraseEl.focus();
  }

  if (schemeEl) schemeEl.addEventListener('change', function () { invalidate(); refreshControls(); });
  if (wordsEl) wordsEl.addEventListener('change', function () { invalidate(); refreshControls(); });
  if (chainEl) chainEl.addEventListener('change', function () { invalidate(); populatePaths(); });
  if (pathEl) pathEl.addEventListener('change', invalidate);
  if (allPathsEl) allPathsEl.addEventListener('change', invalidate);
  countButtons.forEach(function (button) {
    button.addEventListener('click', function () {
      setCount(Number(button.getAttribute('data-count')) || 1);
      invalidate();
    });
  });

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    deriveAll();
  });
  if (generateBtn) generateBtn.addEventListener('click', generate);
  if (clearBtn) clearBtn.addEventListener('click', clearAll);
  if (csvBtn) csvBtn.addEventListener('click', exportCsv);

  populateChains();
  refreshControls();
  setCount(1);

  (async function restoreSearchPhrase() {
    var phrase = '';
    try {
      phrase = sessionStorage.getItem('rotor-seed-phrase') || '';
      sessionStorage.removeItem('rotor-seed-phrase');
    } catch (err) { phrase = ''; }
    if (!phrase) return;
    phraseEl.value = phrase;
    var normalized = cleanPhrase(phrase);
    if (window.RotorSeed && window.RotorSeed.validate(normalized)) {
      schemeEl.value = 'bip39';
    } else {
      try {
        window.RotorSeedCrypto.validateOld(normalized);
        schemeEl.value = 'electrum-old';
      } catch (err) {
        schemeEl.value = 'electrum-bip39';
      }
    }
    refreshControls();
    deriveAll();
  })();

  window.addEventListener('pagehide', function () {
    state.run += 1;
    state.results = [];
    if (state.balanceAbort) {
      try { state.balanceAbort.abort(); } catch (err) { /* already aborted */ }
      state.balanceAbort = null;
    }
    if (phraseEl) phraseEl.value = '';
    if (passphraseEl) passphraseEl.value = '';
    if (rowsEl) rowsEl.textContent = '';
    try { sessionStorage.removeItem('rotor-seed-phrase'); } catch (err) { /* private mode */ }
  });
})();
