/* Top-level testnet send page: /send, /send/bitcoin, /send/ethereum.
 *
 * One embedded page and one script serve all three routes; the pathname picks
 * the chain. Only Bitcoin testnet and Ethereum Sepolia exist here. Mainnet is
 * refused at three layers:
 *   1. assertTestnetChain rejects any chain slug other than the two testnets;
 *   2. parseSecret rejects a Bitcoin mainnet WIF (version 0x80);
 *   3. every HTTP wrapper allowlists the public testnet endpoints, so a
 *      mainnet RPC or mempool.space mainnet URL cannot be reached.
 *
 * The validated send flow itself is the cabinet wallet kernel
 * (RotorBtcSend / RotorEvmSend, loaded before this file). This script only
 * wires the DOM, derives the address through the same local WASM core
 * (derive_report / derive_report_network), signs with btc_sign_tx /
 * evm_sign_tx and broadcasts the signed bytes. A pasted key never enters
 * localStorage, the URL, a request body or a log line; the in-memory bytes
 * are zeroed when the key is cleared or the page is left. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(root);
  else root.RotorSend = factory(root);
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  var BTC_CHAIN = 'bitcoin-testnet';
  var EVM_CHAIN = 'ethereum-sepolia';
  var SEPOLIA_CHAIN_ID = 11155111;
  var WASM_URL = '/rotor_wasm.wasm';
  var BTC_API = 'https://mempool.space/testnet/api';
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var WIF_MIN = 50;
  var WIF_MAX = 53;

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* --------------------------------------------------------- chain routing */

  function chainFromPath(pathname) {
    var value = String(pathname || '/send').replace(/\/+$/, '');
    return value === '/send/ethereum' ? EVM_CHAIN : BTC_CHAIN;
  }

  function chainLabel(chain) {
    return chain === EVM_CHAIN ? 'Ethereum Sepolia' : 'Bitcoin testnet';
  }

  function assertTestnetChain(chain) {
    if (chain === BTC_CHAIN || chain === EVM_CHAIN) return chain;
    if (chain === 'bitcoin' || chain === 'ethereum') {
      throw new Error('Mainnet sending is disabled: this page signs TESTNET transactions only.');
    }
    throw new Error('Unsupported chain: this page only sends on Bitcoin testnet and Ethereum Sepolia.');
  }

  /* -------------------------------------------------------- endpoint gates */

  function assertBtcApiUrl(url) {
    if (typeof url !== 'string' || (url !== BTC_API && url.indexOf(BTC_API + '/') !== 0)) {
      throw new Error('Blocked a non-testnet Bitcoin request.');
    }
    return url;
  }

  function assertBtcBroadcastUrl(url) {
    if (url !== BTC_API + '/tx') throw new Error('Blocked a non-testnet Bitcoin broadcast.');
    return url;
  }

  function assertEvmRpcUrl(url, providers) {
    var list = Array.isArray(providers) ? providers : [];
    if (list.indexOf(url) < 0) {
      throw new Error('Blocked an Ethereum RPC outside the Sepolia allowlist.');
    }
    return url;
  }

  /* ------------------------------------------------------------- key input */

  function hexToBytes(hex) {
    var out = new Uint8Array(hex.length / 2);
    for (var i = 0; i < out.length; i += 1) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    return out;
  }

  function bytesToHex(bytes) {
    var hex = '';
    for (var i = 0; i < bytes.length; i += 1) {
      var part = bytes[i].toString(16);
      hex += part.length === 1 ? '0' + part : part;
    }
    return hex;
  }

  function base58Decode(text) {
    var value = 0n;
    for (var i = 0; i < text.length; i += 1) {
      var index = BASE58.indexOf(text.charAt(i));
      if (index < 0) throw new Error('invalid base58 character');
      value = value * 58n + BigInt(index);
    }
    var leading = 0;
    while (leading < text.length && text.charAt(leading) === '1') leading += 1;
    var hex = value === 0n ? '' : value.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var body = hex ? hexToBytes(hex) : new Uint8Array(0);
    var out = new Uint8Array(leading + body.length);
    out.set(body, leading);
    return out;
  }

  async function sha256(bytes) {
    var subtle = root.crypto && root.crypto.subtle;
    if (!subtle) throw new Error('WIF checksums need WebCrypto (https or localhost).');
    return new Uint8Array(await subtle.digest('SHA-256', bytes));
  }

  async function decodeWif(text) {
    var raw;
    try {
      raw = base58Decode(text);
    } catch (err) {
      throw new Error('Not a valid WIF: ' + errorText(err) + '.');
    }
    if (raw.length !== 37 && raw.length !== 38) throw new Error('Not a valid WIF length.');
    var compressed = raw.length === 38;
    if (compressed && raw[33] !== 0x01) throw new Error('Invalid WIF compression marker.');
    var payload = raw.slice(0, raw.length - 4);
    var checksum = raw.slice(raw.length - 4);
    var hash = await sha256(await sha256(payload));
    for (var i = 0; i < 4; i += 1) {
      if (hash[i] !== checksum[i]) throw new Error('WIF checksum mismatch.');
    }
    return { version: raw[0], compressed: compressed, key: raw.slice(1, 33) };
  }

  /* Turn a pasted secret into a 32-byte key for the chain this route serves.
   * Nothing here derives an address or touches the network. */
  async function parseSecret(text, chain) {
    assertTestnetChain(chain);
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw new Error('Paste a private key first.');

    if (chain === EVM_CHAIN) {
      var evmKey = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
      if (!evmKey) {
        throw new Error('Ethereum Sepolia needs a 32-byte private key (0x + 64 hex characters).');
      }
      var hexKey = evmKey[1].toLowerCase();
      return { chain: EVM_CHAIN, keyBytes: hexToBytes(hexKey), keyHex: hexKey };
    }

    var btcHex = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
    if (btcHex) {
      var rawHex = btcHex[1].toLowerCase();
      return { chain: BTC_CHAIN, keyBytes: hexToBytes(rawHex), keyHex: rawHex };
    }
    if (value.length < WIF_MIN || value.length > WIF_MAX || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) {
      throw new Error('Use a Bitcoin testnet WIF or 64 hex characters (optionally 0x-prefixed).');
    }
    var wif = await decodeWif(value);
    if (wif.version === 0x80) {
      throw new Error('That is a Bitcoin mainnet WIF. Mainnet keys are rejected on this TESTNET page.');
    }
    if (wif.version !== 0xef) {
      throw new Error('Only Bitcoin testnet WIFs (version 0xef) are accepted here.');
    }
    if (!wif.compressed) {
      throw new Error('Use a compressed testnet WIF: the send flow spends a tb1q (P2WPKH) address.');
    }
    return { chain: BTC_CHAIN, keyBytes: wif.key, keyHex: bytesToHex(wif.key) };
  }

  function keyLooksComplete(value, chain) {
    var text = typeof value === 'string' ? value.trim() : '';
    if (chain === EVM_CHAIN) return /^(?:0x)?[0-9a-fA-F]{64}$/.test(text);
    if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) return true;
    return text.length >= WIF_MIN && text.length <= WIF_MAX &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
  }

  /* Test helper: proves a captured payload never carries the key. */
  function containsSecret(value, keyHex) {
    var secret = String(keyHex || '').toLowerCase();
    if (!secret) return false;
    var serialized;
    try {
      serialized = typeof value === 'string' ? value : JSON.stringify(value);
    } catch (err) {
      serialized = String(value);
    }
    return String(serialized || '').toLowerCase().indexOf(secret) >= 0;
  }

  /* ------------------------------------------------------------------ DOM */

  function init() {
    var btc = root.RotorBtcSend;
    var evm = root.RotorEvmSend;
    var state = {
      chain: assertTestnetChain(chainFromPath(root.location && root.location.pathname)),
      keyBytes: null,
      keyHex: null,
      address: '',
      wasm: null,
      wasmPromise: null,
      review: null,
      signedHex: null,
      busy: false
    };

    function byId(id) { return document.getElementById(id); }

    var keyInput = byId('send-key');
    var keyToggle = byId('send-key-toggle');
    var addressEl = byId('send-address');
    var addressCopy = byId('send-address-copy');
    var toInput = byId('send-to');
    var amountInput = byId('send-amount');
    var feeRateInput = byId('send-fee-rate');
    var valueInput = byId('send-value');
    var dataInput = byId('send-data');
    var gasInput = byId('send-gas');
    var maxFeeInput = byId('send-max-fee');
    var priorityInput = byId('send-priority');
    var prepareButton = byId('send-prepare');
    var clearButton = byId('send-clear');
    var signButton = byId('send-sign');
    var cancelButton = byId('send-review-cancel');
    var broadcastButton = byId('send-broadcast');
    var signedClearButton = byId('send-signed-clear');
    var errorBox = byId('send-error');
    var statusBox = byId('send-status');
    var reviewCard = byId('send-review');
    var reviewList = byId('send-review-list');
    var reviewWarnings = byId('send-review-warnings');
    var reviewUnsigned = byId('send-review-unsigned');
    var reviewCopy = byId('send-review-copy');
    var signedCard = byId('send-signed');
    var signedHexEl = byId('send-signed-hex');
    var signedCopy = byId('send-signed-copy');
    var resultCard = byId('send-result');
    var resultHash = byId('send-result-hash');
    var resultLink = byId('send-result-link');
    var unavailable = byId('send-unavailable');

    if (!btc || !evm) {
      if (unavailable) {
        unavailable.hidden = false;
        unavailable.textContent = 'The send kernel did not load. Reload the page.';
      }
      if (prepareButton) prepareButton.disabled = true;
      return;
    }

    var evmProviders = evm.PROVIDERS.map(function (provider) { return provider.url; });

    function setError(message) {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || '';
    }

    function setStatus(message) {
      if (!statusBox) return;
      statusBox.textContent = message || '';
    }

    function setAddress(value) {
      state.address = value || '';
      if (addressEl) addressEl.textContent = value || '—';
      if (addressCopy) addressCopy.disabled = !value;
    }

    function setBusy(busy, label) {
      state.busy = busy;
      if (prepareButton) {
        prepareButton.disabled = busy;
        prepareButton.textContent = busy ? (label || 'Working…') : 'Prepare review';
      }
      if (signButton) signButton.disabled = busy;
      if (broadcastButton) broadcastButton.disabled = busy;
    }

    function clearTimers(button) {
      if (button && button._sendTimer) {
        window.clearTimeout(button._sendTimer);
        button._sendTimer = null;
      }
    }

    function flashCopied(button, label) {
      var use = button.querySelector('use');
      if (!use) return;
      if (!button.getAttribute('data-icon')) {
        button.setAttribute('data-icon', use.getAttribute('href'));
        button.setAttribute('data-label', button.getAttribute('aria-label') || label);
      }
      clearTimers(button);
      use.setAttribute('href', '/icons.svg#ui-check');
      button.title = 'Copied';
      button.setAttribute('aria-label', 'Copied');
      button._sendTimer = window.setTimeout(function () {
        use.setAttribute('href', button.getAttribute('data-icon') || '/icons.svg#ui-copy');
        var reset = button.getAttribute('data-label') || label;
        button.title = reset;
        button.setAttribute('aria-label', reset);
        button._sendTimer = null;
      }, 1400);
    }

    function wireCopy(button, readText, label) {
      if (!button) return;
      button.addEventListener('click', function () {
        var text = readText();
        if (!text) return;
        if (!navigator.clipboard || !navigator.clipboard.writeText) {
          setError('Clipboard access is unavailable in this browser. Select the value and copy it manually.');
          return;
        }
        navigator.clipboard.writeText(text).then(function () {
          flashCopied(button, label);
        }, function () {
          setError('Clipboard access was denied. Select the value and copy it manually.');
        });
      });
    }

    /* ---------------------------------------------------------- chain UI */

    function refreshChainUi() {
      var evmMode = state.chain === EVM_CHAIN;
      Array.prototype.forEach.call(document.querySelectorAll('[data-send-chain]'), function (link) {
        if (link.getAttribute('data-send-chain') === state.chain) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-chain-only]'), function (el) {
        el.hidden = el.getAttribute('data-chain-only') !== state.chain;
      });
      var title = byId('send-title');
      if (title) title.textContent = evmMode ? 'Send Ethereum Sepolia' : 'Send Bitcoin testnet';
      var keyLabel = byId('send-key-label');
      if (keyLabel) {
        keyLabel.textContent = evmMode
          ? 'Ethereum Sepolia private key (0x + 64 hex)'
          : 'Bitcoin testnet WIF or 64-hex key';
      }
      var feeHelp = byId('send-fee-help');
      if (feeHelp) {
        feeHelp.textContent = evmMode
          ? 'Empty gas fields are filled from Sepolia RPC estimates; every value is shown in the review before signing.'
          : 'Leave the fee rate empty to use mempool.space testnet recommendations; the review shows the exact fee.';
      }
      document.title = (evmMode ? 'Send Ethereum Sepolia' : 'Send Bitcoin testnet') + ' — TESTNET only | Rotor';
    }

    /* ------------------------------------------------------------- wasm */

    function loadWasm() {
      if (state.wasm) return Promise.resolve(state.wasm);
      if (state.wasmPromise) return state.wasmPromise;
      state.wasmPromise = fetch(WASM_URL).then(function (response) {
        if (!response.ok) throw new Error('Cannot load ' + WASM_URL + ': HTTP ' + response.status);
        return WebAssembly.instantiateStreaming(response, {}).catch(function () {
          return fetch(WASM_URL).then(function (again) {
            return again.arrayBuffer().then(function (buffer) {
              return WebAssembly.instantiate(buffer, {});
            });
          });
        });
      }).then(function (module) {
        var wasm = module.instance ? module.instance.exports : module.exports;
        var required = ['alloc', 'dealloc', 'derive_report', 'derive_report_network',
          'result_ptr', 'result_len', 'error_ptr', 'error_len', 'clear_result',
          'evm_unsigned_tx', 'evm_sign_tx', 'btc_unsigned_tx', 'btc_sign_tx'];
        for (var i = 0; i < required.length; i += 1) {
          if (typeof wasm[required[i]] !== 'function') {
            throw new Error('The wasm core has no "' + required[i] + '" export.');
          }
        }
        if (!wasm.memory) throw new Error(WASM_URL + ' does not export memory.');
        state.wasm = wasm;
        return wasm;
      });
      state.wasmPromise.catch(function () { state.wasmPromise = null; });
      return state.wasmPromise;
    }

    function wasmText(wasm, pointer, length) {
      if (!pointer || !length) return '';
      return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, pointer, length));
    }

    function deriveReport(wasm, bytes, curve, network) {
      var pointer = wasm.alloc(bytes.length) >>> 0;
      if (!pointer) throw new Error('WASM memory exhausted.');
      try {
        new Uint8Array(wasm.memory.buffer, pointer, bytes.length).set(bytes);
        var status = network === 1
          ? wasm.derive_report_network(pointer, bytes.length, curve, 1) >>> 0
          : wasm.derive_report(pointer, curve) >>> 0;
        if (status !== 0) {
          var detail = wasmText(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
          throw new Error('Derivation failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
        }
        var text = wasmText(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
        return JSON.parse(text);
      } finally {
        wasm.dealloc(pointer, bytes.length);
      }
    }

    function unsignedBtc(fields) {
      return loadWasm().then(function (wasm) {
        return btc.callWasmString(wasm, 'btc_unsigned_tx', JSON.stringify(fields));
      });
    }

    function unsignedEvm(fields) {
      return loadWasm().then(function (wasm) {
        return evm.callWasmString(wasm, 'evm_unsigned_tx', JSON.stringify(fields));
      });
    }

    /* -------------------------------------------------------- http gates */

    function getJson(url) {
      assertBtcApiUrl(url);
      return fetch(url, { headers: { Accept: 'application/json' } }).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw new Error('mempool.space testnet answered HTTP ' + response.status);
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error('mempool.space testnet returned non-JSON data.');
          }
        });
      });
    }

    function fetchJson(url, options) {
      assertEvmRpcUrl(url, evmProviders);
      return fetch(url, options).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw new Error('Sepolia RPC answered HTTP ' + response.status);
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error('Sepolia RPC returned non-JSON data.');
          }
        });
      });
    }

    function broadcastBtc(url, signedHex) {
      assertBtcBroadcastUrl(url);
      return fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: signedHex
      }).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) {
            throw new Error('HTTP ' + response.status + (text ? ': ' + text.trim() : ''));
          }
          return text.trim();
        });
      });
    }

    /* --------------------------------------------------------- key entry */

    function wipeKey() {
      if (state.keyBytes) state.keyBytes.fill(0);
      state.keyBytes = null;
      state.keyHex = null;
      if (keyInput) keyInput.value = '';
      if (keyToggle && keyInput) {
        keyInput.type = 'password';
        keyToggle.textContent = 'Show';
        keyToggle.setAttribute('aria-pressed', 'false');
        keyToggle.setAttribute('aria-label', 'Show private key');
        keyToggle.title = 'Show private key';
      }
    }

    function clearReview() {
      state.review = null;
      state.signedHex = null;
      if (reviewCard) reviewCard.hidden = true;
      if (signedCard) signedCard.hidden = true;
      if (resultCard) resultCard.hidden = true;
      if (reviewList) reviewList.textContent = '';
      if (reviewWarnings) {
        reviewWarnings.textContent = '';
        reviewWarnings.hidden = true;
      }
      if (reviewUnsigned) reviewUnsigned.textContent = '';
      if (signedHexEl) signedHexEl.textContent = '';
      if (resultHash) resultHash.textContent = '';
      if (resultLink) {
        resultLink.hidden = true;
        resultLink.removeAttribute('href');
      }
    }

    function resetAll() {
      wipeKey();
      setAddress('');
      clearReview();
      setError('');
      setStatus('');
      if (toInput) toInput.value = '';
      if (amountInput) amountInput.value = '';
      if (feeRateInput) feeRateInput.value = '';
      if (valueInput) valueInput.value = '';
      if (dataInput) dataInput.value = '';
      if (gasInput) gasInput.value = '';
      if (maxFeeInput) maxFeeInput.value = '';
      if (priorityInput) priorityInput.value = '';
    }

    var deriveTimer = null;
    var deriveToken = 0;

    function scheduleDerive(delay) {
      if (deriveTimer) window.clearTimeout(deriveTimer);
      deriveTimer = window.setTimeout(function () {
        deriveTimer = null;
        deriveKey();
      }, delay);
    }

    async function deriveKey() {
      var token = (deriveToken += 1);
      var value = keyInput ? keyInput.value : '';
      clearReview();
      setStatus('');
      if (!value.trim()) {
        wipeKey();
        setAddress('');
        setError('');
        return;
      }
      if (!keyLooksComplete(value, state.chain)) {
        wipeKey();
        setAddress('');
        return;
      }
      try {
        var parsed = await parseSecret(value, state.chain);
        var wasm = await loadWasm();
        var network = state.chain === EVM_CHAIN ? 0 : 1;
        var report = deriveReport(wasm, parsed.keyBytes, 0, network);
        var wanted = state.chain === EVM_CHAIN ? 'evm' : 'btc_p2wpkh';
        var rows = Array.isArray(report.addresses) ? report.addresses : [];
        var row = null;
        for (var i = 0; i < rows.length; i += 1) {
          if (rows[i] && rows[i].id === wanted) { row = rows[i]; break; }
        }
        if (!row || typeof row.address !== 'string' || !row.address) {
          throw new Error('The local core returned no "' + wanted + '" address.');
        }
        if (token !== deriveToken) {
          parsed.keyBytes.fill(0);
          return;
        }
        if (state.keyBytes) state.keyBytes.fill(0);
        state.keyBytes = parsed.keyBytes;
        state.keyHex = parsed.keyHex;
        setAddress(row.address);
        setError('');
        setStatus(chainLabel(state.chain) + ' address derived locally. Nothing was sent.');
      } catch (err) {
        if (token !== deriveToken) return;
        if (state.keyBytes) state.keyBytes.fill(0);
        state.keyBytes = null;
        state.keyHex = null;
        setAddress('');
        setError(errorText(err));
      }
    }

    /* ------------------------------------------------------------ review */

    function addRow(label, value, mono) {
      var row = document.createElement('div');
      row.className = 'key-form-row';
      var term = document.createElement('dt');
      term.textContent = label;
      var detail = document.createElement('dd');
      if (mono) {
        var code = document.createElement('code');
        code.className = 'mono detail-value';
        code.textContent = value;
        detail.appendChild(code);
      } else {
        detail.textContent = value;
      }
      row.appendChild(term);
      row.appendChild(detail);
      if (reviewList) reviewList.appendChild(row);
    }

    function renderWarnings(warnings) {
      if (!reviewWarnings) return;
      reviewWarnings.textContent = '';
      var list = Array.isArray(warnings) ? warnings : [];
      if (!list.length) {
        reviewWarnings.hidden = true;
        return;
      }
      reviewWarnings.hidden = false;
      var heading = document.createElement('h3');
      heading.textContent = 'Warnings';
      reviewWarnings.appendChild(heading);
      var ul = document.createElement('ul');
      list.forEach(function (warning) {
        var li = document.createElement('li');
        li.textContent = warning;
        ul.appendChild(li);
      });
      reviewWarnings.appendChild(ul);
    }

    function renderBtcReview(review) {
      if (!reviewList) return;
      reviewList.textContent = '';
      addRow('Network', 'Bitcoin testnet (TESTNET)');
      addRow('From', review.from, true);
      addRow('To', review.to, true);
      addRow('Amount', btc.formatBtc(review.amountSats) + ' tBTC');
      addRow('Fee', btc.formatBtc(review.feeSats) + ' tBTC at ' +
        btc.formatFeeRate(review.feeRateHundredths) + ' sat/vB (' + review.feeRateSource + ')');
      addRow('Change', btc.formatBtc(review.changeSats) + ' tBTC');
      addRow('Inputs / outputs', review.inputCount + ' / ' + review.outputCount);
      addRow('Virtual size', review.vsize + ' vB');
      addRow('Total spent', btc.formatBtc(review.totalSpentSats) + ' tBTC');
      renderWarnings(review.warnings);
      if (reviewUnsigned) reviewUnsigned.textContent = review.unsignedHex;
    }

    function renderEvmReview(review) {
      if (!reviewList) return;
      reviewList.textContent = '';
      addRow('Network', 'Ethereum Sepolia (TESTNET), chain id ' + review.chainId);
      addRow('From', review.from, true);
      addRow('To', review.to, true);
      addRow('Value', evm.formatUnits(review.valueWei, evm.ETH_DECIMALS) + ' ETH');
      addRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual ? ' (manual)' : ' (estimated)'));
      addRow('Max fee', evm.formatUnits(review.maxFeeWei, evm.GWEI_DECIMALS) + ' gwei');
      addRow('Priority fee', evm.formatUnits(review.priorityWei, evm.GWEI_DECIMALS) + ' gwei');
      addRow('Nonce', review.nonce.toString());
      addRow('Total max cost', evm.formatUnits(review.totalMaxCostWei, evm.ETH_DECIMALS) + ' ETH');
      addRow('Provider', review.providerLabel);
      renderWarnings(review.warnings);
      if (reviewUnsigned) reviewUnsigned.textContent = review.unsignedHex;
    }

    async function prepare(event) {
      if (event) event.preventDefault();
      if (state.busy) return;
      setError('');
      setStatus('');
      clearReview();
      if (!state.address || !state.keyBytes) {
        setError('Enter a valid key so the local core can derive the sending address.');
        return;
      }
      try {
        assertTestnetChain(state.chain);
        setBusy(true, 'Preparing…');
        if (state.chain === EVM_CHAIN) {
          var evmReview = await evm.prepareTransaction({
            form: {
              to: toInput ? toInput.value : '',
              value: valueInput ? valueInput.value : '',
              data: dataInput ? dataInput.value : '',
              gasLimit: gasInput ? gasInput.value : '',
              maxFee: maxFeeInput ? maxFeeInput.value : '',
              priorityFee: priorityInput ? priorityInput.value : ''
            },
            from: state.address,
            fetchJson: fetchJson,
            unsigned: unsignedEvm
          });
          state.review = evmReview;
          renderEvmReview(evmReview);
        } else {
          var btcReview = await btc.prepareTransaction({
            form: {
              to: toInput ? toInput.value : '',
              amount: amountInput ? amountInput.value : '',
              feeRate: feeRateInput ? feeRateInput.value : ''
            },
            from: state.address,
            chain: BTC_CHAIN,
            getJson: getJson,
            unsigned: unsignedBtc
          });
          state.review = btcReview;
          renderBtcReview(btcReview);
        }
        if (reviewCard) reviewCard.hidden = false;
        setStatus('Review ready. Nothing has been signed or broadcast yet.');
        var heading = byId('send-review-title');
        if (heading && heading.focus) heading.focus();
      } catch (err) {
        var missing = err && err.fieldErrors ? Object.keys(err.fieldErrors) : [];
        if (missing.length) {
          setError(missing.map(function (key) { return key + ': ' + err.fieldErrors[key]; }).join(' '));
        } else {
          setError(errorText(err));
        }
      } finally {
        setBusy(false);
      }
    }

    /* -------------------------------------------------------------- sign */

    async function signBtc(review) {
      assertTestnetChain(state.chain);
      var keyHex = bytesToHex(state.keyBytes);
      var request = {
        network: 'testnet',
        inputs: review.request.inputs.map(function (input) {
          return {
            txid: input.txid,
            vout: input.vout,
            value: input.value,
            sequence: input.sequence
          };
        }),
        outputs: review.request.outputs.map(function (output) {
          return {
            address: btc.assertP2wpkhAddress(output.address, 'Output'),
            value: output.value
          };
        }),
        private_key: '0x' + keyHex
      };
      var text = JSON.stringify(request);
      try {
        var wasm = await loadWasm();
        return btc.callWasmString(wasm, 'btc_sign_tx', text);
      } finally {
        keyHex = null;
        request = null;
        text = null;
      }
    }

    async function signEvm(review) {
      assertTestnetChain(state.chain);
      if (BigInt(review.chainId) !== BigInt(SEPOLIA_CHAIN_ID)) {
        throw new Error('Ethereum Sepolia (chain id ' + SEPOLIA_CHAIN_ID +
          ') is required; refusing to sign a different chain.');
      }
      var keyHex = bytesToHex(state.keyBytes);
      var request = {
        chain_id: String(review.chainId),
        nonce: String(review.nonce),
        max_priority_fee: String(review.priorityWei),
        max_fee: String(review.maxFeeWei),
        gas_limit: String(review.gasLimit),
        to: evm.normalizeAddress(review.to),
        value: String(review.valueWei),
        data: evm.normalizeData(review.dataHex),
        private_key: '0x' + keyHex
      };
      var text = JSON.stringify(request);
      try {
        var wasm = await loadWasm();
        return evm.callWasmString(wasm, 'evm_sign_tx', text);
      } finally {
        keyHex = null;
        request = null;
        text = null;
      }
    }

    function showSigned(hex) {
      state.signedHex = hex;
      if (signedHexEl) signedHexEl.textContent = hex;
      if (signedCard) signedCard.hidden = false;
    }

    async function signLocally() {
      if (state.busy || !state.review) return;
      setError('');
      try {
        assertTestnetChain(state.chain);
        setBusy(true, 'Signing…');
        var signed = state.chain === EVM_CHAIN
          ? await signEvm(state.review)
          : await signBtc(state.review);
        if (state.chain === EVM_CHAIN) {
          if (!/^0x02[0-9a-f]+$/.test(signed) || signed.length % 2) {
            throw new Error('The local core returned an unexpected signed transaction.');
          }
        } else if (!/^[0-9a-f]+$/.test(signed) || signed.length % 2) {
          throw new Error('The local core returned an unexpected signed transaction.');
        }
        showSigned(signed);
        wipeKey();
        setStatus('Signed locally. The private key was cleared; review the signed hex, then broadcast or copy it.');
      } catch (err) {
        setError('Signing failed: ' + errorText(err));
      } finally {
        setBusy(false);
      }
    }

    /* --------------------------------------------------------- broadcast */

    async function broadcast() {
      if (state.busy || !state.review || !state.signedHex) return;
      setError('');
      var signed = state.signedHex;
      try {
        assertTestnetChain(state.chain);
        var result;
        if (state.chain === EVM_CHAIN) {
          setBusy(true, 'Broadcasting…');
          result = await evm.confirmTransaction({
            review: state.review,
            fetchJson: fetchJson,
            sign: function () { return signed; }
          });
          if (resultHash) resultHash.textContent = result.txHash;
          if (resultLink) {
            resultLink.setAttribute('href', result.explorerUrl);
            resultLink.hidden = false;
          }
          setStatus('Broadcast to Ethereum Sepolia accepted.');
        } else {
          setBusy(true, 'Broadcasting…');
          result = await btc.confirmTransaction({
            review: state.review,
            sign: function () { return signed; },
            onSigned: function (hex) { showSigned(hex); },
            broadcast: broadcastBtc
          });
          if (resultHash) resultHash.textContent = result.txid;
          if (resultLink) {
            resultLink.setAttribute('href', result.explorerUrl);
            resultLink.hidden = false;
          }
          setStatus('Broadcast to Bitcoin testnet accepted.');
        }
        if (resultCard) resultCard.hidden = false;
      } catch (err) {
        setError(errorText(err));
      } finally {
        setBusy(false);
      }
    }

    /* ------------------------------------------------------------- wiring */

    refreshChainUi();
    setAddress('');
    setStatus('');
    setError('');

    if (prepareButton) prepareButton.addEventListener('click', prepare);
    if (clearButton) clearButton.addEventListener('click', resetAll);
    if (signButton) signButton.addEventListener('click', function (event) {
      event.preventDefault();
      signLocally();
    });
    if (cancelButton) cancelButton.addEventListener('click', function () {
      clearReview();
      setStatus('Review discarded. Nothing was signed.');
    });
    if (broadcastButton) broadcastButton.addEventListener('click', function (event) {
      event.preventDefault();
      broadcast();
    });
    if (signedClearButton) signedClearButton.addEventListener('click', function () {
      clearReview();
      setStatus('Signed transaction discarded. The key was already cleared.');
    });

    if (keyInput) {
      keyInput.addEventListener('input', function () { scheduleDerive(320); });
      keyInput.addEventListener('blur', function () { scheduleDerive(0); });
      keyInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') {
          event.preventDefault();
          scheduleDerive(0);
        }
      });
    }

    if (keyToggle && keyInput) {
      keyToggle.addEventListener('click', function () {
        var showing = keyInput.type === 'text';
        keyInput.type = showing ? 'password' : 'text';
        keyToggle.textContent = showing ? 'Show' : 'Hide';
        keyToggle.setAttribute('aria-pressed', showing ? 'false' : 'true');
        keyToggle.setAttribute('aria-label', showing ? 'Show private key' : 'Hide private key');
        keyToggle.title = showing ? 'Show private key' : 'Hide private key';
      });
    }

    wireCopy(addressCopy, function () { return state.address; }, 'Copy derived address');
    wireCopy(reviewCopy, function () {
      return reviewUnsigned ? reviewUnsigned.textContent : '';
    }, 'Copy unsigned transaction');
    wireCopy(signedCopy, function () {
      return signedHexEl ? signedHexEl.textContent : '';
    }, 'Copy signed transaction');

    window.addEventListener('pagehide', function () {
      wipeKey();
      clearReview();
    });
  }

  if (typeof document !== 'undefined') init();

  return {
    BTC_CHAIN: BTC_CHAIN,
    EVM_CHAIN: EVM_CHAIN,
    SEPOLIA_CHAIN_ID: SEPOLIA_CHAIN_ID,
    BTC_API: BTC_API,
    chainFromPath: chainFromPath,
    chainLabel: chainLabel,
    assertTestnetChain: assertTestnetChain,
    assertBtcApiUrl: assertBtcApiUrl,
    assertBtcBroadcastUrl: assertBtcBroadcastUrl,
    assertEvmRpcUrl: assertEvmRpcUrl,
    base58Decode: base58Decode,
    decodeWif: decodeWif,
    parseSecret: parseSecret,
    keyLooksComplete: keyLooksComplete,
    containsSecret: containsSecret
  };
});
