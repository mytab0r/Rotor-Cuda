/* DOM wiring for /tx, /tx/bitcoin and /tx/ethereum.
 *
 * Rendering only: every decoded value comes from tx-decoders.js and is inserted
 * with textContent. No network calls, no storage, no URL payload. Icon-only
 * copy controls use the shared .icon-button target (44x44) and flip to a check
 * icon for the visible copied state.
 */
(function () {
  'use strict';

  var decoders = window.RotorTxDecoders;
  if (!decoders) return;

  var SVG_NS = 'http://www.w3.org/2000/svg';

  function byId(id) {
    return document.getElementById(id);
  }

  function fail(errorBox, message) {
    errorBox.textContent = message || '';
    errorBox.hidden = !message;
  }

  function flashCopied(button) {
    var use = button.querySelector('use');
    if (!use) return;
    if (button._resetTimer) window.clearTimeout(button._resetTimer);
    if (!button.getAttribute('data-icon')) {
      button.setAttribute('data-icon', use.getAttribute('href'));
      button.setAttribute('data-label', button.getAttribute('aria-label') || '');
    }
    use.setAttribute('href', '/icons.svg#ui-check');
    button.setAttribute('data-tooltip', 'Copied');
    button.setAttribute('aria-label', 'Copied');
    button._resetTimer = window.setTimeout(function () {
      use.setAttribute('href', button.getAttribute('data-icon'));
      button.setAttribute('data-tooltip', button.getAttribute('data-label') || 'Copy');
      button.setAttribute('aria-label', button.getAttribute('data-label') || 'Copy');
    }, 1200);
  }

  function copyText(text, button, errorBox) {
    if (!navigator.clipboard || !navigator.clipboard.writeText) {
      fail(errorBox, 'Clipboard access is unavailable in this browser. Select the value and copy it manually.');
      return;
    }
    navigator.clipboard.writeText(text).then(function () {
      flashCopied(button);
    }, function () {
      fail(errorBox, 'Clipboard access was denied. Select the value and copy it manually.');
    });
  }

  function iconButton(iconId, label) {
    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button icon-button--quiet icon-button--lg';
    button.setAttribute('aria-label', label);
    button.setAttribute('data-tooltip', label);
    var svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'icon');
    svg.setAttribute('aria-hidden', 'true');
    var use = document.createElementNS(SVG_NS, 'use');
    use.setAttribute('href', '/icons.svg#' + iconId);
    svg.appendChild(use);
    button.appendChild(svg);
    return button;
  }

  function copyButton(text, label, errorBox) {
    var button = iconButton('ui-copy', label);
    button.addEventListener('click', function () {
      copyText(text, button, errorBox);
    });
    return button;
  }

  function kvRow(label, value, copy) {
    var row = document.createElement('div');
    row.className = 'key-form-row';
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    var code = document.createElement('code');
    code.className = 'mono detail-value';
    code.textContent = value;
    detail.appendChild(code);
    row.appendChild(term);
    row.appendChild(detail);
    if (copy) row.appendChild(copy);
    return row;
  }

  function copyValueCell(text, label, errorBox) {
    var cell = document.createElement('span');
    var code = document.createElement('code');
    code.className = 'mono detail-value';
    code.textContent = text;
    cell.appendChild(code);
    if (text && text !== '—') {
      cell.appendChild(document.createTextNode(' '));
      cell.appendChild(copyButton(text, label, errorBox));
    }
    return cell;
  }

  function buildTable(container, captionText, headers, rows) {
    container.textContent = '';
    var scroll = document.createElement('div');
    scroll.className = 'table-scroll';
    var table = document.createElement('table');
    var caption = document.createElement('caption');
    caption.className = 'visually-hidden';
    caption.textContent = captionText;
    table.appendChild(caption);
    var head = document.createElement('thead');
    var headRow = document.createElement('tr');
    headers.forEach(function (header) {
      var th = document.createElement('th');
      th.scope = 'col';
      th.textContent = header;
      headRow.appendChild(th);
    });
    head.appendChild(headRow);
    table.appendChild(head);
    var body = document.createElement('tbody');
    rows.forEach(function (cells) {
      var row = document.createElement('tr');
      cells.forEach(function (cell) {
        var td = document.createElement('td');
        td.className = 'wrap';
        if (cell && cell.nodeType === 1) td.appendChild(cell);
        else td.textContent = String(cell);
        row.appendChild(td);
      });
      body.appendChild(row);
    });
    table.appendChild(body);
    scroll.appendChild(table);
    container.appendChild(scroll);
  }

  function initBitcoin() {
    var form = byId('btc-form');
    if (!form) return;
    var hexInput = byId('btc-hex');
    var prevoutInput = byId('btc-prevouts');
    var errorBox = byId('btc-error');
    var result = byId('btc-result');
    var title = byId('btc-result-title');
    var summary = byId('btc-summary');
    var inputs = byId('btc-inputs');
    var outputs = byId('btc-outputs');
    var json = byId('btc-json');
    var copyJson = byId('btc-copy-json');
    var lastReport = null;

    function clear() {
      form.reset();
      result.hidden = true;
      summary.textContent = '';
      inputs.textContent = '';
      outputs.textContent = '';
      json.textContent = '';
      lastReport = null;
      fail(errorBox, '');
      hexInput.focus();
    }

    function render(report) {
      summary.textContent = '';
      summary.appendChild(kvRow('Encoding', report.encoding === 'segwit' ? 'SegWit (marker 0x00, flag 0x01)' : 'Legacy', null));
      summary.appendChild(kvRow('Version', String(report.version), null));
      summary.appendChild(kvRow('Locktime', String(report.locktime), null));
      summary.appendChild(kvRow('Size', report.size + ' bytes', null));
      summary.appendChild(kvRow('Weight', report.weight + ' WU', null));
      summary.appendChild(kvRow('Virtual size', report.vsize + ' vB', null));
      summary.appendChild(kvRow('Total output', report.totalOutSats + ' sats (' + report.totalOutBtc + ' BTC)', null));
      summary.appendChild(kvRow('Fee', report.feeSats === null
        ? 'fee unavailable without prevouts'
        : report.feeSats + ' sats (' + report.feeBtc + ' BTC)', null));

      buildTable(
        inputs,
        'Transaction inputs',
        ['#', 'Outpoint', 'Sequence', 'scriptSig (hex)', 'Witness'],
        report.inputs.map(function (input) {
          return [
            String(input.index),
            copyValueCell(input.txid + ':' + input.vout, 'Copy input ' + input.index + ' txid', errorBox),
            String(input.sequence),
            copyValueCell(input.scriptSig || '—', 'Copy input ' + input.index + ' scriptSig', errorBox),
            input.witness.length ? input.witness.join(' · ') : '—'
          ];
        })
      );

      buildTable(
        outputs,
        'Transaction outputs',
        ['#', 'Value', 'Type', 'Address', 'scriptPubKey (hex)'],
        report.outputs.map(function (output) {
          return [
            String(output.index),
            output.valueSats + ' sats (' + output.valueBtc + ' BTC)',
            output.scriptTypeLabel,
            output.address
              ? copyValueCell(output.address, 'Copy output ' + output.index + ' address', errorBox)
              : '—',
            copyValueCell(output.scriptPubKey || '—', 'Copy output ' + output.index + ' scriptPubKey', errorBox)
          ];
        })
      );

      json.textContent = JSON.stringify(report);
      lastReport = report;
      result.hidden = false;
      title.focus();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      fail(errorBox, '');
      result.hidden = true;
      try {
        render(decoders.decodeBitcoin(hexInput.value, prevoutInput.value));
      } catch (err) {
        fail(errorBox, err && err.message ? err.message : 'Decoding failed.');
      }
    });

    byId('btc-clear').addEventListener('click', clear);

    copyJson.addEventListener('click', function () {
      if (lastReport) copyText(JSON.stringify(lastReport, null, 2), copyJson, errorBox);
    });
  }

  function initEthereum() {
    var form = byId('evm-form');
    if (!form) return;
    var hexInput = byId('evm-hex');
    var errorBox = byId('evm-error');
    var result = byId('evm-result');
    var title = byId('evm-result-title');
    var summary = byId('evm-summary');
    var access = byId('evm-access');
    var accessSection = byId('evm-access-section');
    var json = byId('evm-json');
    var copyJson = byId('evm-copy-json');
    var lastReport = null;

    function clear() {
      form.reset();
      result.hidden = true;
      summary.textContent = '';
      access.textContent = '';
      accessSection.hidden = true;
      json.textContent = '';
      lastReport = null;
      fail(errorBox, '');
      hexInput.focus();
    }

    function render(report) {
      summary.textContent = '';
      summary.appendChild(kvRow('Type', report.typeLabel, null));
      summary.appendChild(kvRow('Chain ID', report.chainId === null
        ? 'pre-EIP-155 (no chain id)'
        : report.chainId + ' (' + report.chainIdHex + ')', null));
      summary.appendChild(kvRow('Nonce', report.nonce, null));
      if (report.type === 'eip1559') {
        summary.appendChild(kvRow('Max priority fee', report.maxPriorityFeePerGas + ' wei (' + report.maxPriorityFeePerGasHex + ')', null));
        summary.appendChild(kvRow('Max fee', report.maxFeePerGas + ' wei (' + report.maxFeePerGasHex + ')', null));
      } else {
        summary.appendChild(kvRow('Gas price', report.gasPrice + ' wei (' + report.gasPriceHex + ')', null));
      }
      summary.appendChild(kvRow('Gas limit', report.gasLimit + ' (' + report.gasLimitHex + ')', null));
      summary.appendChild(kvRow(
        'To',
        report.contractCreation ? 'Contract creation' : report.to,
        report.to ? copyButton(report.to, 'Copy to address', errorBox) : null
      ));
      summary.appendChild(kvRow('Value', report.valueWei + ' wei (' + report.valueEth + ' ETH)', null));
      summary.appendChild(kvRow('Data length', report.dataLength + ' byte' + (report.dataLength === 1 ? '' : 's'), null));
      summary.appendChild(kvRow(
        'Selector',
        report.selector || '—',
        report.selector ? copyButton(report.selector, 'Copy data selector', errorBox) : null
      ));
      summary.appendChild(kvRow('First bytes', report.firstBytes, null));
      summary.appendChild(kvRow('Access list', report.accessList.length + ' entr' +
        (report.accessList.length === 1 ? 'y' : 'ies'), null));
      summary.appendChild(kvRow('y-parity', report.signature.yParity === null ? '—' : String(report.signature.yParity), null));
      if (report.type === 'legacy') {
        summary.appendChild(kvRow('v', report.signature.v, null));
      }
      summary.appendChild(kvRow('r', report.signature.r, copyButton(report.signature.r, 'Copy signature r', errorBox)));
      summary.appendChild(kvRow('s', report.signature.s, copyButton(report.signature.s, 'Copy signature s', errorBox)));
      summary.appendChild(kvRow('Size', report.size + ' bytes', null));

      if (report.accessList.length) {
        accessSection.hidden = false;
        buildTable(
          access,
          'Access list',
          ['#', 'Address', 'Storage keys'],
          report.accessList.map(function (entry, index) {
            return [
              String(index),
              copyValueCell(entry.address, 'Copy access-list address ' + index, errorBox),
              entry.storageKeys.length ? entry.storageKeys.join(' · ') : '—'
            ];
          })
        );
      } else {
        accessSection.hidden = true;
        access.textContent = '';
      }

      json.textContent = JSON.stringify(report);
      lastReport = report;
      result.hidden = false;
      title.focus();
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      fail(errorBox, '');
      result.hidden = true;
      try {
        render(decoders.decodeEthereum(hexInput.value));
      } catch (err) {
        fail(errorBox, err && err.message ? err.message : 'Decoding failed.');
      }
    });

    byId('evm-clear').addEventListener('click', clear);

    copyJson.addEventListener('click', function () {
      if (lastReport) copyText(JSON.stringify(lastReport, null, 2), copyJson, errorBox);
    });
  }

  initBitcoin();
  initEthereum();
})();
