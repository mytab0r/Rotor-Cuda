/* Self-contained QR encoder: byte mode, error-correction level M, versions 1-6.
   No DOM access; expose the encoder before anything else so tests can load it. */
(function () {
  'use strict';

  var MAX_BYTES = 106;
  var CAPACITY = [0, 14, 26, 42, 62, 84, 106];
  /* Per-version EC-M layout: block count, total and data codewords. */
  var BLOCKS = [
    null,
    { count: 1, total: 26, data: 16 },
    { count: 1, total: 44, data: 28 },
    { count: 1, total: 70, data: 44 },
    { count: 2, total: 100, data: 64 },
    { count: 2, total: 134, data: 86 },
    { count: 4, total: 172, data: 108 }
  ];
  /* Alignment-pattern centre coordinates (the last one is size - 7). */
  var ALIGN = [null, [], [6, 18], [6, 22], [6, 26], [6, 30], [6, 34]];

  /* GF(256) with primitive polynomial 0x11D. */
  var GF_EXP = new Uint8Array(512);
  var GF_LOG = new Uint8Array(256);
  (function () {
    var x = 1;
    for (var i = 0; i < 255; i += 1) {
      GF_EXP[i] = x;
      GF_LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11D;
    }
    for (var j = 255; j < 512; j += 1) GF_EXP[j] = GF_EXP[j - 255];
  })();

  function gfMul(a, b) {
    if (a === 0 || b === 0) return 0;
    return GF_EXP[GF_LOG[a] + GF_LOG[b]];
  }

  function polyMul(a, b) {
    var out = [];
    for (var i = 0; i < a.length + b.length - 1; i += 1) out.push(0);
    for (var j = 0; j < a.length; j += 1) {
      for (var k = 0; k < b.length; k += 1) out[j + k] ^= gfMul(a[j], b[k]);
    }
    return out;
  }

  function rsGenerator(degree) {
    var gen = [1];
    for (var i = 0; i < degree; i += 1) gen = polyMul(gen, [1, GF_EXP[i]]);
    return gen;
  }

  function rsRemainder(data, degree) {
    var gen = rsGenerator(degree);
    var remainder = data.slice();
    for (var i = 0; i < degree; i += 1) remainder.push(0);
    for (var j = 0; j < data.length; j += 1) {
      var factor = remainder[j];
      if (factor !== 0) {
        for (var k = 0; k < gen.length; k += 1) {
          remainder[j + k] ^= gfMul(gen[k], factor);
        }
      }
    }
    return remainder.slice(data.length);
  }

  function appendBits(bits, value, length) {
    for (var i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  }

  function utf8Bytes(text) {
    return new TextEncoder().encode(text);
  }

  function pickVersion(byteLength) {
    for (var version = 1; version <= 6; version += 1) {
      if (byteLength <= CAPACITY[version]) return version;
    }
    return 0;
  }

  function dataCodewords(version, bytes) {
    var layout = BLOCKS[version];
    var capacityBits = layout.data * 8;
    var bits = [];
    appendBits(bits, 0x4, 4);
    appendBits(bits, bytes.length, 8);
    for (var i = 0; i < bytes.length; i += 1) appendBits(bits, bytes[i], 8);
    if (bits.length > capacityBits) throw new Error('Data does not fit QR version ' + version + '.');
    appendBits(bits, 0, Math.min(4, capacityBits - bits.length));
    while (bits.length % 8 !== 0) bits.push(0);
    var pad = [0xEC, 0x11];
    for (var p = 0; bits.length < capacityBits; p ^= 1) appendBits(bits, pad[p], 8);
    var words = [];
    for (var j = 0; j < bits.length; j += 8) {
      var value = 0;
      for (var k = 0; k < 8; k += 1) value = (value << 1) | bits[j + k];
      words.push(value);
    }
    return words;
  }

  function interleave(version, words) {
    var layout = BLOCKS[version];
    var perData = layout.data / layout.count;
    var perEc = (layout.total - layout.data) / layout.count;
    var blocks = [];
    var i;
    for (i = 0; i < layout.count; i += 1) {
      var data = words.slice(i * perData, (i + 1) * perData);
      blocks.push({ data: data, ec: rsRemainder(data, perEc) });
    }
    var out = [];
    var j;
    for (j = 0; j < perData; j += 1) {
      for (i = 0; i < blocks.length; i += 1) out.push(blocks[i].data[j]);
    }
    for (j = 0; j < perEc; j += 1) {
      for (i = 0; i < blocks.length; i += 1) out.push(blocks[i].ec[j]);
    }
    return out;
  }

  function blank(size) {
    var modules = [];
    var reserved = [];
    for (var r = 0; r < size; r += 1) {
      var row = [];
      var flags = [];
      for (var c = 0; c < size; c += 1) {
        row.push(0);
        flags.push(false);
      }
      modules.push(row);
      reserved.push(flags);
    }
    return { modules: modules, reserved: reserved };
  }

  function placeFinder(grid, size, row, col) {
    for (var r = -1; r <= 7; r += 1) {
      for (var c = -1; c <= 7; c += 1) {
        var rr = row + r;
        var cc = col + c;
        if (rr < 0 || cc < 0 || rr >= size || cc >= size) continue;
        grid.reserved[rr][cc] = true;
        var inside = r >= 0 && r <= 6 && c >= 0 && c <= 6;
        var dark = false;
        if (inside) {
          dark = r === 0 || r === 6 || c === 0 || c === 6 ||
            (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        }
        grid.modules[rr][cc] = dark ? 1 : 0;
      }
    }
  }

  function placeAlignment(grid, row, col) {
    for (var r = -2; r <= 2; r += 1) {
      for (var c = -2; c <= 2; c += 1) {
        grid.reserved[row + r][col + c] = true;
        grid.modules[row + r][col + c] = Math.max(Math.abs(r), Math.abs(c)) !== 1 ? 1 : 0;
      }
    }
  }

  function placeFunctionPatterns(grid, version) {
    var size = 4 * version + 17;
    placeFinder(grid, size, 0, 0);
    placeFinder(grid, size, 0, size - 7);
    placeFinder(grid, size, size - 7, 0);

    for (var i = 8; i < size - 8; i += 1) {
      var dark = i % 2 === 0 ? 1 : 0;
      grid.reserved[6][i] = true;
      grid.modules[6][i] = dark;
      grid.reserved[i][6] = true;
      grid.modules[i][6] = dark;
    }

    var centers = ALIGN[version];
    var last = size - 7;
    for (var a = 0; a < centers.length; a += 1) {
      for (var b = 0; b < centers.length; b += 1) {
        var row = centers[a];
        var col = centers[b];
        /* Skip the three centres that fall under a finder. */
        if ((row === 6 && col === 6) || (row === 6 && col === last) || (row === last && col === 6)) {
          continue;
        }
        placeAlignment(grid, row, col);
      }
    }

    /* Dark module and both reserved format-information copies. */
    grid.reserved[size - 8][8] = true;
    grid.modules[size - 8][8] = 1;
    for (var f = 0; f <= 8; f += 1) {
      grid.reserved[8][f] = true;
      grid.reserved[f][8] = true;
    }
    for (var g = 0; g < 8; g += 1) grid.reserved[8][size - 1 - g] = true;
    for (var h = 0; h < 7; h += 1) grid.reserved[size - 1 - h][8] = true;
  }

  function placeData(grid, codewords) {
    var size = grid.modules.length;
    var bits = [];
    for (var i = 0; i < codewords.length; i += 1) appendBits(bits, codewords[i], 8);
    var index = 0;
    var upward = true;
    for (var right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (var vert = 0; vert < size; vert += 1) {
        var row = upward ? size - 1 - vert : vert;
        for (var j = 0; j < 2; j += 1) {
          var col = right - j;
          if (!grid.reserved[row][col]) {
            grid.modules[row][col] = index < bits.length ? bits[index] : 0;
            index += 1;
          }
        }
      }
      upward = !upward;
    }
  }

  var MASKS = [
    function (r, c) { return (r + c) % 2 === 0; },
    function (r) { return r % 2 === 0; },
    function (r, c) { return c % 3 === 0; },
    function (r, c) { return (r + c) % 3 === 0; },
    function (r, c) { return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0; },
    function (r, c) { return (r * c) % 2 + (r * c) % 3 === 0; },
    function (r, c) { return ((r * c) % 2 + (r * c) % 3) % 2 === 0; },
    function (r, c) { return ((r + c) % 2 + (r * c) % 3) % 2 === 0; }
  ];

  function applyMask(modules, reserved, maskIndex) {
    var fn = MASKS[maskIndex];
    for (var r = 0; r < modules.length; r += 1) {
      for (var c = 0; c < modules.length; c += 1) {
        if (!reserved[r][c] && fn(r, c)) modules[r][c] ^= 1;
      }
    }
  }

  function formatBits(maskIndex) {
    /* EC level M is 00; then the three mask bits. */
    var data = maskIndex;
    var rem = data;
    for (var i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    return ((data << 10) | rem) ^ 0x5412;
  }

  function drawFormat(modules, maskIndex) {
    var size = modules.length;
    var bits = formatBits(maskIndex);
    var i;
    for (i = 0; i <= 5; i += 1) modules[i][8] = (bits >>> i) & 1;
    modules[7][8] = (bits >>> 6) & 1;
    modules[8][8] = (bits >>> 7) & 1;
    modules[8][7] = (bits >>> 8) & 1;
    for (i = 9; i < 15; i += 1) modules[8][14 - i] = (bits >>> i) & 1;
    for (i = 0; i < 8; i += 1) modules[8][size - 1 - i] = (bits >>> i) & 1;
    for (i = 8; i < 15; i += 1) modules[size - 15 + i][8] = (bits >>> i) & 1;
    modules[size - 8][8] = 1;
  }

  /* Mask penalty per the four standard rules, using run histories so a
     1:1:3:1:1 finder-like pattern is credited for each side that has its
     four-module light border. N1 adds 3 at five equal modules then 1 more per
     extra module; N2 adds 3 per 2x2 block; N3 adds 40; N4 adds 10 per 5%
     dark-ratio step above the 45-55% band. */
  function finderPenaltyAddHistory(runHistory, runLength, size) {
    if (runHistory[0] === 0) runLength += size;
    for (var i = runHistory.length - 1; i > 0; i -= 1) runHistory[i] = runHistory[i - 1];
    runHistory[0] = runLength;
  }

  function finderPenaltyCountPatterns(runHistory) {
    var n = runHistory[1];
    var core = n > 0 && runHistory[2] === n && runHistory[4] === n &&
      runHistory[5] === n && runHistory[3] === n * 3;
    var count = 0;
    if (core && runHistory[0] >= n * 4 && runHistory[6] >= n) count += 1;
    if (core && runHistory[6] >= n * 4 && runHistory[0] >= n) count += 1;
    return count;
  }

  function scanLinePenalty(modules, index, vertical) {
    var size = modules.length;
    var result = 0;
    var runColor = false;
    var runLength = 0;
    var runHistory = [0, 0, 0, 0, 0, 0, 0];
    for (var i = 0; i < size; i += 1) {
      var cell = (vertical ? modules[i][index] : modules[index][i]) === 1;
      if (cell === runColor) {
        runLength += 1;
        if (runLength === 5) result += 3;
        else if (runLength > 5) result += 1;
      } else {
        finderPenaltyAddHistory(runHistory, runLength, size);
        if (!runColor) result += finderPenaltyCountPatterns(runHistory) * 40;
        runColor = cell;
        runLength = 1;
      }
    }
    if (runColor) {
      finderPenaltyAddHistory(runHistory, runLength, size);
      runLength = 0;
    }
    runLength += size;
    finderPenaltyAddHistory(runHistory, runLength, size);
    result += finderPenaltyCountPatterns(runHistory) * 40;
    return result;
  }

  function runPenalty(modules) {
    var size = modules.length;
    var penalty = 0;
    var r;
    var c;
    for (r = 0; r < size; r += 1) penalty += scanLinePenalty(modules, r, false);
    for (c = 0; c < size; c += 1) penalty += scanLinePenalty(modules, c, true);
    var dark = 0;
    for (r = 0; r < size; r += 1) {
      for (c = 0; c < size; c += 1) dark += modules[r][c];
    }
    for (r = 0; r < size - 1; r += 1) {
      for (c = 0; c < size - 1; c += 1) {
        var v = modules[r][c];
        if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
          penalty += 3;
        }
      }
    }
    var total = size * size;
    var k = Math.floor((Math.abs(dark * 20 - total * 10) + total - 1) / total) - 1;
    penalty += k * 10;
    return penalty;
  }

  function encode(text) {
    if (typeof text !== 'string') throw new Error('QR input must be a string.');
    if (text.length === 0) throw new Error('QR input must not be empty.');
    var bytes = utf8Bytes(text);
    if (bytes.length === 0) throw new Error('QR input must not be empty.');
    if (bytes.length > MAX_BYTES) {
      throw new Error('QR input is ' + bytes.length + ' bytes; the limit is ' + MAX_BYTES + '.');
    }
    var version = pickVersion(bytes.length);
    var size = 4 * version + 17;

    var grid = blank(size);
    placeFunctionPatterns(grid, version);
    placeData(grid, interleave(version, dataCodewords(version, bytes)));

    var bestPenalty = Infinity;
    var bestModules = null;
    for (var maskIndex = 0; maskIndex < 8; maskIndex += 1) {
      var trial = [];
      for (var r = 0; r < size; r += 1) {
        var row = [];
        for (var c = 0; c < size; c += 1) row.push(grid.modules[r][c]);
        trial.push(row);
      }
      applyMask(trial, grid.reserved, maskIndex);
      drawFormat(trial, maskIndex);
      var penalty = runPenalty(trial);
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        bestModules = trial;
      }
    }

    return { version: version, size: size, modules: bestModules };
  }

  var root = typeof globalThis !== 'undefined' ? globalThis : window;
  root.RotorQR = { encode: encode };
})();
