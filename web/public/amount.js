/* Single source for atomic-unit parsing and display. No build step, no deps.
 *
 * Every amount on the site goes through this module: BigInt only, never
 * `Number` for the integer part. It is generated-free hand-written ES5-style
 * code (var + function, no modules) and exposes `window.RotorAmount`.
 *
 * Formatting rules:
 *  - formatUnits is exact. `value` is an atomic integer (bigint, integer
 *    number or integer string) and `decimals` is the unit exponent.
 *  - The fraction is printed with at most `decimals` digits, trailing zeros
 *    are trimmed and there is no grouping unless `options.grouping` is true.
 *  - `options.maximumFractionDigits` truncates the fraction (it never rounds;
 *    key.js needs the historical micro-ETH truncation). Default: `decimals`.
 *  - `options.minimumFractionDigits` pads the trimmed fraction with zeros.
 *  - `options.symbol` appends " <symbol>" when it is a non-empty string.
 *  - coin is the display helper the five directory pages use: grouped
 *    thousands, at most 6 fraction digits above 8 decimals (8 otherwise),
 *    half-up rounding, "0" for zero and "<0.00000001" for a smaller nonzero
 *    amount. The integer part is always exact.
 *  - parseUnits is exact and rejects a fraction longer than `decimals`; it
 *    accepts only a plain positive decimal (no sign, exponent or comma).
 *  - receivedText keeps the donor's tiny "sat"/"zat" form below 0.0001 coin.
 *    The caller supplies the atomic unit name.
 *
 * Behaviour matches the replaced local copies for every in-range value; the
 * only intended changes are exact results above 2^53 (the old `Number` paths
 * rounded there) and a thrown error for negative formatUnits input (no caller
 * produced one).
 */
(function (root) {
  'use strict';

  var MAX_DECIMALS = 100;

  function pow10(places) {
    return 10n ** BigInt(places);
  }

  function normalizeDecimals(value) {
    if (value === undefined || value === null || value === '') {
      throw new Error('decimals must be a non-negative integer');
    }
    var places = Number(value);
    if (!isFinite(places) || Math.floor(places) !== places || places < 0) {
      throw new Error('decimals must be a non-negative integer');
    }
    if (places > MAX_DECIMALS) {
      throw new Error('decimals must be at most ' + MAX_DECIMALS);
    }
    return places;
  }

  function toBigInt(value) {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') {
      if (!Number.isSafeInteger(value)) {
        throw new Error('a number amount must be a safe integer; pass a bigint or decimal string');
      }
      return BigInt(value);
    }
    if (typeof value === 'string') {
      var text = value.trim();
      if (!/^[+-]?\d+$/.test(text)) throw new Error('amount must be an integer string');
      return BigInt(text);
    }
    throw new Error('amount must be an integer, bigint or integer string');
  }

  function fractionDigits(remainder, places) {
    if (remainder === 0n || places === 0) return '';
    return remainder.toString().padStart(places, '0');
  }

  function trimZeros(text) {
    return text.replace(/0+$/, '');
  }

  function groupInteger(text) {
    return text.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function fractionOption(value, places, name) {
    if (value === undefined || value === null) return null;
    var number = Number(value);
    if (!isFinite(number) || Math.floor(number) !== number || number < 0) {
      throw new Error(name + ' must be a non-negative integer');
    }
    return number > places ? places : number;
  }

  function formatUnits(value, decimals, options) {
    var amount = toBigInt(value);
    if (amount < 0n) throw new Error('amount must not be negative');
    var places = normalizeDecimals(decimals);
    var unit = pow10(places);
    var whole = amount / unit;
    var digits = fractionDigits(amount % unit, places);
    var settings = options || {};

    var maximum = fractionOption(settings.maximumFractionDigits, places, 'maximumFractionDigits');
    if (maximum === null) maximum = places;
    if (digits.length > maximum) digits = digits.slice(0, maximum);
    digits = trimZeros(digits);

    var minimum = fractionOption(settings.minimumFractionDigits, places, 'minimumFractionDigits');
    if (minimum === null) minimum = 0;
    if (minimum > maximum) minimum = maximum;
    while (digits.length < minimum) digits += '0';

    var wholeText = whole.toString();
    if (settings.grouping === true) wholeText = groupInteger(wholeText);
    var text = digits ? wholeText + '.' + digits : wholeText;
    if (typeof settings.symbol === 'string' && settings.symbol) {
      text += ' ' + settings.symbol;
    }
    return text;
  }

  function parseUnits(text, decimals) {
    var places = normalizeDecimals(decimals);
    if (typeof text !== 'string') throw new Error('use a plain decimal number');
    var value = text.trim();
    if (!value) throw new Error('a number is required');
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('use a plain decimal number like 0.01 (no exponent, sign or comma)');
    }
    var fraction = match[2] || '';
    if (fraction.length > places) {
      throw new Error('at most ' + places + ' decimal places');
    }
    return BigInt(match[1]) * pow10(places) +
      BigInt(fraction.padEnd(places, '0') || '0');
  }

  function coin(value, decimals) {
    var amount = toBigInt(value);
    var places = normalizeDecimals(decimals);
    if (amount === 0n) return '0';
    if (amount < 0n) return '<0.00000001';

    var unit = pow10(places);
    if (places > 8 && amount < pow10(places - 8)) return '<0.00000001';

    var maximum = places > 8 ? 6 : 8;
    var scale = pow10(maximum);
    var whole = amount / unit;
    var remainder = amount % unit;
    var scaled = remainder * scale;
    var rounded = (scaled + unit / 2n) / unit;
    if (rounded >= scale) {
      whole += 1n;
      rounded -= scale;
    }
    var digits = rounded === 0n ? '' : trimZeros(rounded.toString().padStart(maximum, '0'));
    var text = groupInteger(whole.toString());
    return digits ? text + '.' + digits : text;
  }

  function receivedText(value, decimals, symbol, atomicUnit) {
    var amount = toBigInt(value);
    var places = normalizeDecimals(decimals);
    if (amount === 0n) return '0';
    if (amount > 0n && atomicUnit && places >= 4) {
      var cut = pow10(places - 4);
      if (amount < cut) return amount.toString() + ' ' + atomicUnit;
    }
    var text = coin(amount, places);
    return symbol ? text + ' ' + symbol : text;
  }

  root.RotorAmount = {
    version: 1,
    formatUnits: formatUnits,
    parseUnits: parseUnits,
    coin: coin,
    receivedText: receivedText
  };
})(typeof globalThis !== 'undefined' ? globalThis : this);
