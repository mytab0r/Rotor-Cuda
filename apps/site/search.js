/* Shared wallet-search parser and result helpers: hex, WIF, keypair,
 * XRP secret, mnemonic and brainwallet input plus public-row shaping and CSV
 * export for the global search modal.
 *
 * This module never touches the DOM, storage, the URL or the network. The
 * derivation stays in the wasm core; this file only calls it and picks the
 * public address rows. Private key material is never included in shaped rows
 * or exported CSV. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorSearch = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var MNEMONIC_WORD_COUNTS = [12, 15, 18, 21, 24];
  var WIF_RE = /^[5KL][1-9A-HJ-NP-Za-km-z]{50,51}$/;
  var XRP_SECRET_RE = /^s[1-9A-HJ-NP-Za-km-z]{20,30}$/;
  var XRP_UNSUPPORTED = 'XRP family seeds (s…) are not supported in this search. ' +
    'Paste the 64-hex private key or export the hex key from your wallet.';

  /* The explicit "Interpret as" choices. `auto` keeps the old detection
   * order; the rest force one format so an ambiguous value is never guessed. */
  var INTERPRET = [
    ['auto', 'Auto-detect'],
    ['hex', 'HEX'],
    ['wif', 'WIF'],
    ['keypair', 'Keypair'],
    ['xrp-secret', 'XRP secret'],
    ['mnemonic', 'Mnemonic'],
    ['brainwallet', 'Brainwallet']
  ];

  var COUNTS = [1, 3, 5, 10];

  /* The 18 chains offered by the selector, in display order. `family` maps a
   * chain to the address rows the derivation core reports; `symbol` and
   * `icon` drive the per-chain result cards. */
  var CHAINS = [
    { slug: 'bitcoin', label: 'Bitcoin', symbol: 'BTC', icon: 'chain-bitcoin', family: 'btc', explorer: 'https://mempool.space/address/' },
    { slug: 'ethereum', label: 'Ethereum', symbol: 'ETH', icon: 'chain-ethereum', family: 'evm', explorer: 'https://etherscan.io/address/' },
    { slug: 'bnb', label: 'BNB', symbol: 'BNB', icon: 'chain-bnb', family: 'evm', explorer: 'https://bscscan.com/address/' },
    { slug: 'arbitrum', label: 'Arbitrum', symbol: 'ARB', icon: 'chain-arbitrum', family: 'evm', explorer: 'https://arbiscan.io/address/' },
    { slug: 'optimism', label: 'Optimism', symbol: 'OP', icon: 'chain-optimism', family: 'evm', explorer: 'https://optimistic.etherscan.io/address/' },
    { slug: 'base', label: 'Base', symbol: 'BASE', icon: 'chain-base', family: 'evm', explorer: 'https://basescan.org/address/' },
    { slug: 'polygon', label: 'Polygon', symbol: 'POL', icon: 'chain-polygon', family: 'evm', explorer: 'https://polygonscan.com/address/' },
    { slug: 'avalanche', label: 'Avalanche', symbol: 'AVAX', icon: 'chain-avalanche', family: 'evm', explorer: 'https://snowtrace.io/address/' },
    { slug: 'zksync', label: 'zkSync', symbol: 'zkSync', icon: 'chain-zksync', family: 'evm', explorer: 'https://explorer.zksync.io/address/' },
    { slug: 'solana', label: 'Solana', symbol: 'SOL', icon: 'chain-solana', family: 'solana', explorer: 'https://solscan.io/account/' },
    { slug: 'tron', label: 'TRON', symbol: 'TRX', icon: 'chain-tron', family: 'tron', explorer: 'https://tronscan.org/#/address/' },
    { slug: 'xrp', label: 'XRP', symbol: 'XRP', icon: 'chain-xrp', family: 'xrp', explorer: 'https://xrpscan.com/account/' },
    { slug: 'litecoin', label: 'Litecoin', symbol: 'LTC', icon: 'chain-litecoin', family: 'ltc', explorer: 'https://blockchair.com/litecoin/address/' },
    { slug: 'bitcoin-cash', label: 'Bitcoin Cash', symbol: 'BCH', icon: 'chain-bitcoin-cash', family: 'bch', explorer: 'https://blockchair.com/bitcoin-cash/address/' },
    { slug: 'dogecoin', label: 'Dogecoin', symbol: 'DOGE', icon: 'chain-dogecoin', family: 'doge', explorer: 'https://blockchair.com/dogecoin/address/' },
    { slug: 'zcash', label: 'Zcash', symbol: 'ZEC', icon: 'chain-zcash', family: 'zcash', explorer: 'https://blockchair.com/zcash/address/' },
    { slug: 'sui', label: 'Sui', symbol: 'SUI', icon: 'chain-sui', family: 'sui', explorer: 'https://suiscan.xyz/mainnet/account/' },
    { slug: 'ton', label: 'TON', symbol: 'TON', icon: 'chain-ton', family: 'ton', explorer: 'https://tonviewer.com/' }
  ];

  var CHAIN_BY_SLUG = {};
  CHAINS.forEach(function (chain) { CHAIN_BY_SLUG[chain.slug] = chain; });

  /* One canonical row per family when the chain filter is "all chains". */
  var FAMILY_CANONICAL = {
    btc: 'btc_p2pkh',
    evm: 'evm',
    tron: 'tron',
    solana: 'solana',
    ltc: 'ltc_p2pkh',
    doge: 'doge_p2pkh',
    bch: 'bch_legacy',
    xrp: 'xrp_classic',
    zcash: 'zcash_p2pkh',
    sui: 'sui',
    ton: 'ton'
  };

  var TYPE_LABELS = {
    btc_p2pkh: 'Legacy',
    btc_p2pkh_uncompressed: 'Legacy (uncompressed)',
    btc_p2sh_p2wpkh: 'P2SH-P2WPKH',
    btc_p2wpkh: 'Native segwit',
    btc_p2tr: 'Taproot',
    evm: 'EVM',
    tron: 'TRON',
    solana: 'Solana',
    ltc_p2pkh: 'Legacy',
    ltc_p2sh_p2wpkh: 'P2SH-P2WPKH',
    ltc_p2wpkh: 'Native segwit',
    ltc_p2tr: 'Taproot',
    doge_p2pkh: 'Legacy',
    doge_p2pkh_uncompressed: 'Legacy (uncompressed)',
    bch_legacy: 'Legacy',
    bch_cashaddr: 'CashAddr',
    xrp_classic: 'Classic',
    zcash_p2pkh: 'Transparent',
    zcash_p2pkh_uncompressed: 'Transparent (uncompressed)',
    sui: 'Sui',
    ton: 'v4R2',
    ton_w5: 'W5'
  };

  function cryptoObject() {
    if (typeof window !== 'undefined' && window.crypto) return window.crypto;
    if (typeof crypto !== 'undefined') return crypto;
    return null;
  }

  function bytesToHex(bytes) {
    return Array.prototype.map.call(bytes, function (byte) {
      return byte.toString(16).padStart(2, '0');
    }).join('');
  }

  function hexFromBytes(bytes) {
    return bytes.map(function (n) { return n.toString(16).padStart(2, '0'); }).join('');
  }

  function hexToBytes(hex) {
    var clean = String(hex == null ? '' : hex).replace(/^0[xX]/, '');
    if (!/^[0-9a-fA-F]*$/.test(clean) || clean.length % 2 !== 0) {
      throw new Error('Hex input is not valid.');
    }
    var out = new Uint8Array(clean.length / 2);
    for (var i = 0; i < out.length; i += 1) out[i] = parseInt(clean.substr(i * 2, 2), 16);
    return out;
  }

  function decodeBase58(text) {
    var number = 0n;
    for (var i = 0; i < text.length; i += 1) {
      var index = BASE58.indexOf(text[i]);
      if (index < 0) throw new Error('Invalid base58 character.');
      number = number * 58n + BigInt(index);
    }
    var hex = number === 0n ? '' : number.toString(16);
    if (hex.length % 2) hex = '0' + hex;
    var bytes = new Uint8Array(hex.length / 2);
    for (var j = 0; j < bytes.length; j += 1) bytes[j] = parseInt(hex.substr(j * 2, 2), 16);
    var leading = 0;
    while (leading < text.length && text[leading] === '1') leading += 1;
    if (!leading) return bytes;
    var out = new Uint8Array(bytes.length + leading);
    out.set(bytes, leading);
    return out;
  }

  async function decodeWif(text) {
    var subtle = cryptoObject() && cryptoObject().subtle;
    if (!subtle) {
      throw new Error('WIF checksums need a secure context (https or localhost) in this browser.');
    }
    var raw = decodeBase58(text);
    if (raw.length !== 37 && raw.length !== 38) throw new Error('Not a WIF length.');
    if (raw[0] !== 0x80) throw new Error('Not a mainnet WIF.');
    if (raw.length === 38 && raw[33] !== 0x01) throw new Error('Bad compression marker.');
    var payload = raw.slice(0, raw.length - 4);
    var digest = new Uint8Array(await subtle.digest('SHA-256', payload));
    digest = new Uint8Array(await subtle.digest('SHA-256', digest));
    for (var i = 0; i < 4; i += 1) {
      if (digest[i] !== raw[raw.length - 4 + i]) throw new Error('WIF checksum mismatch.');
    }
    return bytesToHex(payload.slice(1, 33));
  }

  async function sha256Hex(text) {
    var subtle = cryptoObject() && cryptoObject().subtle;
    if (!subtle) {
      throw new Error('Brainwallet search needs HTTPS in this browser.');
    }
    var digest = new Uint8Array(await subtle.digest('SHA-256', new TextEncoder().encode(text)));
    return bytesToHex(digest);
  }

  function isMnemonic(value) {
    var words = value.split(/\s+/);
    return MNEMONIC_WORD_COUNTS.indexOf(words.length) >= 0 &&
      words.every(function (word) { return /^[a-z]+$/.test(word); });
  }

  function parseHexInput(value) {
    var hex = value;
    if (/^0x/i.test(hex)) hex = hex.slice(2);
    if (!/^[0-9a-fA-F]+$/.test(hex)) {
      throw new Error('HEX may only contain the digits 0-9 and the letters a-f.');
    }
    if (hex.length > 64) {
      throw new Error('Hex keys are exactly 64 characters (you have ' + hex.length + ').');
    }
    return { kind: 'hex', hex: hex.toLowerCase().padStart(64, '0') };
  }

  async function parseWifInput(value) {
    if (!WIF_RE.test(value)) {
      throw new Error('Not a WIF: expected a 51- or 52-character base58 key starting with 5, K or L.');
    }
    return { kind: 'wif', hex: await decodeWif(value) };
  }

  function parseKeypairInput(value) {
    if (value.charAt(0) !== '[') {
      throw new Error('Keypair must be a JSON array of 32 (seed) or 64 (secret key) byte values 0–255.');
    }
    var parsed;
    try {
      parsed = JSON.parse(value);
    } catch (err) {
      throw new Error('Keypair JSON is not valid.');
    }
    if (!Array.isArray(parsed) || (parsed.length !== 32 && parsed.length !== 64) ||
        !parsed.every(function (n) { return Number.isInteger(n) && n >= 0 && n <= 255; })) {
      throw new Error('Keypair must be a JSON array of 32 (seed) or 64 (secret key) byte values 0–255.');
    }
    return { kind: 'keypair', hex: hexFromBytes(parsed.slice(0, 32)), curve: 'ed25519', chain: 'solana' };
  }

  function parseMnemonicInput(value) {
    if (!isMnemonic(value)) {
      throw new Error('Mnemonic must be 12, 15, 18, 21 or 24 lower-case words.');
    }
    return { kind: 'mnemonic', phrase: value.split(/\s+/).join(' ') };
  }

  /**
   * Auto-detect or force the input format without deriving anything.
   * Returns { kind, hex?, curve?, phrase?, chain? } or throws a precise error
   * for formats the search cannot consume (XRP family seeds, bad keypairs).
   * Never falls back to a brainwallet hash for a recognized non-text format.
   */
  async function detect(text, mode) {
    var value = String(text || '').trim();
    if (!value) throw new Error('Paste a key, WIF, mnemonic or brainwallet text first.');
    var selected = mode || 'auto';

    if (selected === 'mnemonic') return parseMnemonicInput(value);
    if (selected === 'brainwallet') return { kind: 'brainwallet', hex: await sha256Hex(value) };
    if (selected === 'xrp-secret') {
      if (XRP_SECRET_RE.test(value)) throw new Error(XRP_UNSUPPORTED);
      throw new Error('Not an XRP family secret: expected a base58 string starting with "s".');
    }
    if (selected === 'keypair') return parseKeypairInput(value);
    if (selected === 'wif') return parseWifInput(value);
    if (selected === 'hex') return parseHexInput(value);
    if (selected !== 'auto') throw new Error('Unknown interpretation mode.');

    if (isMnemonic(value)) {
      return { kind: 'mnemonic', phrase: value.split(/\s+/).join(' ') };
    }
    if (XRP_SECRET_RE.test(value)) throw new Error(XRP_UNSUPPORTED);
    if (value.charAt(0) === '[') return parseKeypairInput(value);

    var normalized = value;
    if (/^0x[0-9a-fA-F]{1,64}$/.test(normalized)) normalized = normalized.slice(2);
    if (/^[0-9a-fA-F]+$/.test(normalized)) {
      if (normalized.length > 64) {
        throw new Error('Hex keys are exactly 64 characters (you have ' + normalized.length + ').');
      }
      return { kind: 'hex', hex: normalized.toLowerCase().padStart(64, '0') };
    }
    if (WIF_RE.test(value)) return { kind: 'wif', hex: await decodeWif(value) };

    return { kind: 'brainwallet', hex: await sha256Hex(value) };
  }

  async function resolve(text, mode) {
    var result = await detect(text, mode);
    if (result.kind === 'mnemonic') {
      throw new Error('A mnemonic opens the seed tools; it is not a single private key.');
    }
    return result.hex;
  }

  /* ------------------------------------------------------ wasm derivation */

  function readWasmString(wasm, ptr, length) {
    if (!ptr || !length) return '';
    return new TextDecoder('utf-8').decode(new Uint8Array(wasm.memory.buffer, ptr, length));
  }

  function deriveReport(wasm, bytes, curve) {
    if (!wasm) throw new Error('The derivation core is not loaded.');
    var required = ['alloc', 'dealloc', 'derive_report', 'result_ptr', 'result_len', 'error_ptr', 'error_len'];
    for (var i = 0; i < required.length; i += 1) {
      if (typeof wasm[required[i]] !== 'function') {
        throw new Error('This build of the derivation core has no "' + required[i] + '" export yet.');
      }
    }
    if (!wasm.memory) throw new Error('The derivation core does not export memory.');
    var input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    var ptr = wasm.alloc(input.length) >>> 0;
    if (!ptr) throw new Error('WASM memory exhausted (requested ' + input.length + ' bytes).');
    try {
      new Uint8Array(wasm.memory.buffer, ptr, input.length).set(input);
      var status = wasm.derive_report(ptr, curve) >>> 0;
      if (status !== 0) {
        var detail = readWasmString(wasm, wasm.error_ptr() >>> 0, wasm.error_len() >>> 0);
        throw new Error('Derivation failed' + (detail ? ': ' + detail : ' (status ' + status + ')'));
      }
      var text = readWasmString(wasm, wasm.result_ptr() >>> 0, wasm.result_len() >>> 0);
      try {
        return JSON.parse(text);
      } catch (err) {
        throw new Error('The derivation core returned invalid JSON.');
      }
    } finally {
      try {
        new Uint8Array(wasm.memory.buffer, ptr, input.length).fill(0);
      } catch (err) { /* memory may have grown; nothing else to wipe */ }
      wasm.dealloc(ptr, input.length);
    }
  }

  /* ------------------------------------------------------- result shaping */

  function familyOf(id) {
    if (id === 'evm' || id === 'tron' || id === 'solana' || id === 'sui' || id === 'ton') return id;
    if (typeof id !== 'string') return '';
    if (id.indexOf('btc_') === 0) return 'btc';
    if (id.indexOf('ltc_') === 0) return 'ltc';
    if (id.indexOf('doge_') === 0) return 'doge';
    if (id.indexOf('bch_') === 0) return 'bch';
    if (id.indexOf('xrp_') === 0) return 'xrp';
    if (id.indexOf('zcash_') === 0) return 'zcash';
    return '';
  }

  function makeRow(addr, chain) {
    return {
      id: addr.id,
      chain: chain.slug,
      chainLabel: chain.label,
      type: TYPE_LABELS[addr.id] || addr.label || addr.id,
      address: addr.address,
      explorer: chain.explorer ? chain.explorer + encodeURIComponent(addr.address) : ''
    };
  }

  function appendTonRow(report, address) {
    if (!report || !Array.isArray(report.addresses) || !address) return report;
    var hasTon = report.addresses.some(function (row) { return row && row.id === 'ton'; });
    if (hasTon) return report;
    report.addresses.push({ id: 'ton', label: 'TON wallet v4R2', address: address, steps: {} });
    return report;
  }

  /**
   * Pick public address rows from a wasm derivation report.
   *
   * `chain` is one of the selector slugs ('' = all chains). With a chain
   * filter, every address type of that chain family is returned (e.g. the five
   * Bitcoin encodings). With all chains, one canonical row per family is
   * returned so the table shows a useful spread instead of five Bitcoin rows.
   * `count` is one of 1/3/5/10; it caps the returned rows.
   */
  function shapeReport(report, options) {
    var opts = options || {};
    var requested = Number(opts.count);
    var count = COUNTS.indexOf(requested) >= 0 ? requested : 5;
    var addresses = report && Array.isArray(report.addresses) ? report.addresses.filter(function (addr) {
      return addr && addr.id && addr.address;
    }) : [];
    var selected = opts.chain ? CHAIN_BY_SLUG[opts.chain] : null;
    var rows = [];

    if (selected) {
      addresses.forEach(function (addr) {
        if (familyOf(addr.id) !== selected.family) return;
        rows.push(makeRow(addr, selected));
      });
    } else {
      var seen = {};
      CHAINS.forEach(function (chain) {
        if (seen[chain.family]) return;
        seen[chain.family] = true;
        var canonical = FAMILY_CANONICAL[chain.family];
        var match = null;
        for (var i = 0; i < addresses.length; i += 1) {
          if (addresses[i].id === canonical) {
            match = addresses[i];
            break;
          }
        }
        if (match) rows.push(makeRow(match, chain));
      });
    }

    return rows.slice(0, count);
  }

  function chainLabel(slug) {
    return CHAIN_BY_SLUG[slug] ? CHAIN_BY_SLUG[slug].label : slug;
  }

  function csvEscape(value) {
    var text = String(value === null || value === undefined ? '' : value);
    if (/[",\r\n]/.test(text)) return '"' + text.replace(/"/g, '""') + '"';
    return text;
  }

  /* CSV holds public rows only: chain, address, type and explorer link. */
  function toCsv(rows) {
    var lines = ['chain,address,type,explorer'];
    (rows || []).forEach(function (row) {
      lines.push([
        csvEscape(row.chainLabel || row.chain || ''),
        csvEscape(row.address || ''),
        csvEscape(row.type || ''),
        csvEscape(row.explorer || '')
      ].join(','));
    });
    return lines.join('\n') + '\n';
  }

  /* ------------------------------------------------------ result cards */
  /* One card per chain, with every address type the wasm report and the JS
   * codecs (CashAddr, uncompressed UTXO rows, Litecoin taproot) produce for
   * that family. Private key material is never copied into a card row. */

  function cardRows(report, family) {
    var addresses = report && Array.isArray(report.addresses) ? report.addresses : [];
    return addresses.filter(function (addr) {
      return addr && typeof addr.id === 'string' && addr.address &&
        familyOf(addr.id) === family;
    });
  }

  function cardRowsById(report, ids) {
    var addresses = report && Array.isArray(report.addresses) ? report.addresses : [];
    return addresses.filter(function (addr) {
      return addr && typeof addr.id === 'string' && addr.address && ids.indexOf(addr.id) >= 0;
    });
  }

  function extraList(extras) {
    if (Array.isArray(extras)) return extras;
    if (extras && typeof extras === 'object') {
      return Object.keys(extras).map(function (key) { return extras[key]; });
    }
    return [];
  }

  function cardRow(addr, chain) {
    return {
      id: addr.id,
      type: TYPE_LABELS[addr.id] || addr.label || addr.id.replace(/_/g, ' '),
      address: addr.address,
      explorer: chain.explorer ? chain.explorer + encodeURIComponent(addr.address) : '',
      active: false,
      balance: null
    };
  }

  function makeCard(chain, addresses) {
    var seen = {};
    var rows = [];
    addresses.forEach(function (addr) {
      if (!addr || !addr.id || !addr.address || seen[addr.id]) return;
      seen[addr.id] = true;
      rows.push(cardRow(addr, chain));
    });
    return {
      slug: chain.slug,
      label: chain.label,
      symbol: chain.symbol || chain.label,
      icon: chain.icon || ('chain-' + chain.slug),
      family: chain.family,
      explorer: chain.explorer || '',
      rows: rows,
      balance: null,
      balanceState: 'idle'
    };
  }

  /**
   * Build the donor-style per-chain cards. `secpReport` and `edReport` are
   * the two derive_report outputs (either may be null); `extras` is the JS
   * codec output (array or id->row map). Chains without any address are
   * omitted so a card is never half-empty.
   */
  function buildCards(secpReport, edReport, extras) {
    var extra = extraList(extras);
    var cards = [];
    CHAINS.forEach(function (chain) {
      var rows;
      if (chain.family === 'evm') {
        rows = cardRows(secpReport, 'evm').filter(function (row) { return row.id === 'evm'; });
      } else if (chain.family === 'solana' || chain.family === 'sui') {
        rows = cardRows(edReport, chain.family);
      } else if (chain.family === 'ton') {
        rows = cardRowsById(edReport, ['ton', 'ton_w5']);
        if (!rows.length) rows = cardRows(secpReport, 'ton');
      } else {
        rows = cardRows(secpReport, chain.family).concat(cardRows({ addresses: extra }, chain.family));
      }
      if (!rows.length) return;
      cards.push(makeCard(chain, rows));
    });
    return cards;
  }

  function balanceFor(balances, card) {
    if (!balances) return '—';
    var value = balances[card.slug];
    return value === undefined || value === null || value === '' ? '—' : String(value);
  }

  /* TSV for "Copy All": one public row per line, balance last. */
  function cardsToTsv(cards, balances) {
    var lines = ['chain\tindex\ttype\taddress\texplorer\tbalance'];
    (cards || []).forEach(function (card) {
      (card.rows || []).forEach(function (row, index) {
        lines.push([
          card.label,
          '#' + index,
          row.type || '',
          row.address || '',
          row.explorer || '',
          balanceFor(balances, card)
        ].join('\t'));
      });
    });
    return lines.join('\n') + '\n';
  }

  /* CSV for "Copy CSV": the same public columns, never a private key. */
  function cardsToCsv(cards, balances) {
    var lines = ['chain,index,type,address,explorer,balance'];
    (cards || []).forEach(function (card) {
      (card.rows || []).forEach(function (row, index) {
        lines.push([
          csvEscape(card.label),
          csvEscape('#' + index),
          csvEscape(row.type || ''),
          csvEscape(row.address || ''),
          csvEscape(row.explorer || ''),
          csvEscape(balanceFor(balances, card))
        ].join(','));
      });
    });
    return lines.join('\n') + '\n';
  }

  /* Counts over rows the providers marked active (a positive balance or a
   * provider activity signal). Unknown balances stay inactive, never zero. */
  function summaryCounts(cards) {
    var chains = 0;
    var addresses = 0;
    (cards || []).forEach(function (card) {
      var chainActive = false;
      (card.rows || []).forEach(function (row) {
        if (row.active === true) {
          chainActive = true;
          addresses += 1;
        }
      });
      if (chainActive) chains += 1;
    });
    return { chains: chains, addresses: addresses };
  }

  return {
    resolve: resolve,
    detect: detect,
    hexToBytes: hexToBytes,
    deriveReport: deriveReport,
    shapeReport: shapeReport,
    appendTonRow: appendTonRow,
    toCsv: toCsv,
    buildCards: buildCards,
    cardsToTsv: cardsToTsv,
    cardsToCsv: cardsToCsv,
    summaryCounts: summaryCounts,
    csvEscape: csvEscape,
    familyOf: familyOf,
    chainLabel: chainLabel,
    CHAINS: CHAINS,
    INTERPRET: INTERPRET,
    COUNTS: COUNTS
  };
});
