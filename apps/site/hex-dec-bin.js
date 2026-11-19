/* 256-bit integer converter: input parsing and rendering stay in the tab. */
(function () {
  'use strict';

  var byId = function (id) { return document.getElementById(id); };
  var form = byId('convert-form');
  if (!form) return;

  var input = byId('convert-input');
  var errorBox = byId('convert-error');
  var result = byId('convert-result');
  var rows = byId('convert-rows');
  var meta = byId('convert-meta');

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

  function row(label, value, mono) {
    var line = document.createElement('div');
    line.className = 'key-form-row';
    var term = document.createElement('dt');
    term.textContent = label;
    var detail = document.createElement('dd');
    var code = document.createElement('code');
    code.className = mono ? 'mono detail-value' : 'detail-value';
    code.textContent = value;
    detail.appendChild(code);
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

  function render(source, formatted) {
    rows.textContent = '';
    rows.appendChild(row('Input base', source, false));
    rows.appendChild(row('Hex', formatted.hex, true));
    rows.appendChild(row('Decimal', formatted.decimal, true));
    rows.appendChild(row('Binary', formatted.binary, true));
    rows.appendChild(row('Padded hex (32 bytes)', formatted.hexPadded, true));
    rows.appendChild(row('Padded binary (256 bits)', formatted.binaryPadded, true));
    meta.textContent = formatted.bytes + ' byte' + (formatted.bytes === 1 ? '' : 's') +
      ' for the minimal big-endian encoding; the padded forms always show 32 bytes.';
    result.hidden = false;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    fail('');
    result.hidden = true;
    try {
      if (!window.RotorKeyTools) throw new Error('The converter library did not load. Reload the page.');
      var value = window.RotorKeyTools.parseInteger(input.value);
      var formatted = window.RotorKeyTools.formatInteger(value);
      var cleaned = input.value.trim().replace(/[\s_]+/g, '').toLowerCase();
      var base = cleaned.slice(0, 2) === '0x' ? 'hexadecimal' : cleaned.slice(0, 2) === '0b' ? 'binary' : 'decimal';
      render(base, formatted);
    } catch (err) {
      fail(err && err.message ? err.message : 'Conversion failed.');
    }
  });

  byId('convert-clear').addEventListener('click', function () {
    input.value = '';
    rows.textContent = '';
    result.hidden = true;
    fail('');
    input.focus();
  });
})();
