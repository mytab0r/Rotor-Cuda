/* Byte-fragment assembler: known bytes in, one 32-byte value out. The page
 * never fills unknown bytes and never sends the value anywhere. */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('rebuild-form');
  if (!form) return;

  var input = byId('rebuild-input');
  var errorBox = byId('rebuild-error');
  var result = byId('rebuild-result');
  var facts = byId('rebuild-facts');
  var status = byId('rebuild-status');
  var submit = byId('rebuild-submit');
  var state = { busy: false };

  var EXAMPLE = [
    '# Two known halves of a 32-byte value.',
    '0:hex:4c0883a69102937d6231471b5dbb6204',
    '16:hex:fe5129617082792ae468d01a3f362318'
  ].join('\n');

  function fail(message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
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

  function factRow(label, value, href) {
    var line = document.createElement('div');
    line.className = 'key-form-row';
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    var node;
    if (href) {
      node = document.createElement('a');
      node.className = 'mono detail-value';
      node.href = href;
      node.target = '_blank';
      node.rel = 'noopener noreferrer';
    } else {
      node = document.createElement('code');
      node.className = 'mono detail-value';
    }
    node.textContent = value;
    detail.appendChild(node);
    var copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'key-copy';
    copy.textContent = 'Copy';
    copy.addEventListener('click', function () { copyText(value, copy); });
    line.appendChild(term);
    line.appendChild(detail);
    line.appendChild(copy);
    return line;
  }

  function decimalOf(bytes) {
    var value = 0n;
    for (var index = 0; index < bytes.length; index += 1) {
      value = (value << 8n) | BigInt(bytes[index]);
    }
    return value.toString(10);
  }

  function binaryOf(bytes) {
    var out = '';
    for (var index = 0; index < bytes.length; index += 1) {
      out += bytes[index].toString(2).padStart(8, '0');
    }
    return out;
  }

  function missingLabel(missing) {
    var ranges = [];
    var start = missing[0];
    var previous = missing[0];
    for (var index = 1; index <= missing.length; index += 1) {
      var current = missing[index];
      if (current === previous + 1) {
        previous = current;
        continue;
      }
      ranges.push(start === previous ? String(start) : start + '-' + previous);
      start = current;
      previous = current;
    }
    return ranges.join(', ');
  }

  async function derive(complete) {
    facts.textContent = '';
    facts.appendChild(factRow('Hex', complete.hex));
    facts.appendChild(factRow('Decimal', decimalOf(complete.bytes)));
    facts.appendChild(factRow('Binary', binaryOf(complete.bytes)));
    status.textContent = 'Assembled from ' + complete.fragments + ' known fragment' +
      (complete.fragments === 1 ? '' : 's') + '.';

    try {
      var wasm = await window.RotorKeyTools.loadWasm(window.RotorAssets.url('/rotor_wasm.wasm'));
      if (typeof wasm.derive_report !== 'function') return;
      var upload = window.RotorKeyTools.upload(wasm, complete.bytes);
      var code;
      try {
        code = wasm.derive_report(upload.pointer, 0) >>> 0;
      } finally {
        wasm.dealloc(upload.pointer, upload.length);
      }
      if (code !== 0) {
        status.textContent += ' These 32 bytes are not a valid secp256k1 private key (' +
          window.RotorKeyTools.wasmError(wasm) + '), so no addresses are shown.';
        return;
      }
      var report = window.RotorKeyTools.wasmResultJson(wasm);
      var byIdMap = {};
      report.addresses.forEach(function (entry) { byIdMap[entry.id] = entry.address; });
      facts.appendChild(factRow('WIF (compressed)', report.wif_compressed));
      facts.appendChild(factRow('Bitcoin P2PKH', byIdMap.btc_p2pkh,
        byIdMap.btc_p2pkh ? 'https://mempool.space/address/' + byIdMap.btc_p2pkh : ''));
      facts.appendChild(factRow('Ethereum', byIdMap.evm,
        byIdMap.evm ? 'https://etherscan.io/address/' + byIdMap.evm : ''));
      facts.appendChild(factRow('TRON', byIdMap.tron,
        byIdMap.tron ? 'https://tronscan.org/#/address/' + byIdMap.tron : ''));
      status.textContent += ' Valid secp256k1 private key: the derived addresses are shown below.';
    } catch (err) {
      status.textContent += ' The calculation core could not be loaded, so only the raw value is shown: ' +
        (err && err.message ? err.message : String(err));
    }
  }

  async function rebuild() {
    if (state.busy) return;
    fail('');
    result.hidden = true;
    try {
      if (!window.RotorKeyTools) throw new Error('The assembler library did not load. Reload the page.');
      var assembled = window.RotorKeyTools.assembleKey(input.value);
      if (!assembled.complete) {
        throw new Error('Missing byte' + (assembled.missing.length === 1 ? ' ' : 's ') +
          missingLabel(assembled.missing) + '. Supply every byte 0-31; the page does not guess.');
      }
      state.busy = true;
      submit.disabled = true;
      submit.textContent = 'Assembling…';
      await derive(assembled);
      result.hidden = false;
      result.scrollIntoView({ behavior: window.RotorKeyTools.scrollBehavior(), block: 'start' });
    } catch (err) {
      fail(err && err.message ? err.message : 'Assembly failed.');
    } finally {
      state.busy = false;
      submit.disabled = false;
      submit.textContent = 'Assemble';
    }
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    rebuild();
  });

  byId('rebuild-example').addEventListener('click', function () {
    input.value = EXAMPLE;
    fail('');
    input.focus();
  });

  byId('rebuild-clear').addEventListener('click', function () {
    input.value = '';
    facts.textContent = '';
    result.hidden = true;
    fail('');
    input.focus();
  });
})();
