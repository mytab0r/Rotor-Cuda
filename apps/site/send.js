/* Top-level testnet send page: /send, /send/bitcoin, /send/ethereum,
 * /send/bnb, /send/usdt and /send/tron.
 *
 * One embedded page and one script serve all six routes; the pathname picks
 * the chain. Only testnets exist here: Bitcoin testnet, Ethereum Sepolia,
 * BNB Smart Chain testnet (chapel, chain id 97) and TRON Nile. The USDT route
 * is a generic ERC-20 transfer builder on Ethereum Sepolia; the token contract
 * is supplied by the user because there is no canonical USDT deployment on
 * Sepolia. The TRON route signs a plain TRX transfer through the WASM core and
 * broadcasts only to api.nileex.io.
 *
 * Mainnet is refused at three layers:
 *   1. assertTestnetChain rejects every chain slug except the five testnets,
 *      naming bitcoin/ethereum/bnb/usdt/tron mainnet slugs explicitly;
 *   2. parseSecret rejects a Bitcoin mainnet WIF (version 0x80) on the Bitcoin
 *      route. On the EVM and TRON routes a Bitcoin WIF is only a 32-byte key
 *      container: both the mainnet (0x80) and testnet (0xef) version bytes are
 *      accepted, and neither selects the chain, so mainnet cannot be reached
 *      from a WIF. Those routes still sign only Sepolia/BNB testnet/USDT
 *      testnet/TRON Nile transactions;
 *   3. every HTTP wrapper allowlists the public testnet endpoints, so a
 *      mainnet RPC or mempool.space mainnet URL cannot be reached, and the
 *      EVM kernel refuses any chain id outside this table (BNB mainnet 56 is
 *      not present). tron-tx.js pins every TRON call to https://api.nileex.io.
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
  var BNB_CHAIN = 'bnb-testnet';
  var USDT_CHAIN = 'usdt-sepolia';
  var TRON_CHAIN = 'tron-nile';
  var SEPOLIA_CHAIN_ID = 11155111;
  var BNB_CHAIN_ID = 97;
  var WASM_URL = '/rotor_wasm.wasm';
  var BTC_API = 'https://mempool.space/testnet/api';
  var BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  var WIF_MIN = 50;
  var WIF_MAX = 53;
  var ERC20_TRANSFER_SELECTOR = '0xa9059cbb';
  var USDT_DEFAULT_DECIMALS = 6;
  var USDT_DEFAULT_GAS = '60000';
  var U256_MAX = (1n << 256n) - 1n;

  /* Public BNB Smart Chain testnet (chapel) RPCs. Verified 2026-11-20: both
   * answer eth_chainId 0x61 and send Access-Control-Allow-Origin: *. No
   * mainnet BSC endpoint appears here. */
  var BNB_TESTNET_PROVIDERS = [
    'https://data-seed-prebsc-1-s1.bnbchain.org:8545',
    'https://bsc-testnet-rpc.publicnode.com'
  ];

  /* One table drives routing, labels, chain ids, explorers and the guards. */
  var CHAINS = {};
  CHAINS[BTC_CHAIN] = {
    slug: BTC_CHAIN, kind: 'btc', label: 'Bitcoin testnet',
    title: 'Send Bitcoin testnet', keyLabel: 'Testnet WIF or 64-hex key'
  };
  CHAINS[EVM_CHAIN] = {
    slug: EVM_CHAIN, kind: 'evm', label: 'Ethereum Sepolia',
    title: 'Send Ethereum Sepolia', keyLabel: 'Testnet WIF or 64-hex key',
    chainId: SEPOLIA_CHAIN_ID, nativeSymbol: 'ETH',
    explorerTx: 'https://sepolia.etherscan.io/tx/'
  };
  CHAINS[BNB_CHAIN] = {
    slug: BNB_CHAIN, kind: 'evm', label: 'BNB Smart Chain testnet',
    title: 'Send BNB Smart Chain testnet', keyLabel: 'Testnet WIF or 64-hex key',
    chainId: BNB_CHAIN_ID, nativeSymbol: 'tBNB',
    explorerTx: 'https://testnet.bscscan.com/tx/'
  };
  CHAINS[USDT_CHAIN] = {
    slug: USDT_CHAIN, kind: 'evm', token: true, label: 'Ethereum Sepolia (ERC-20)',
    title: 'Send ERC-20 on Ethereum Sepolia', keyLabel: 'Testnet WIF or 64-hex key',
    chainId: SEPOLIA_CHAIN_ID, nativeSymbol: 'ETH',
    explorerTx: 'https://sepolia.etherscan.io/tx/'
  };
  CHAINS[TRON_CHAIN] = {
    slug: TRON_CHAIN, kind: 'tron', label: 'TRON Nile testnet',
    title: 'Send TRON Nile testnet', keyLabel: 'Testnet WIF or 64-hex key',
    nativeSymbol: 'TRX',
    explorerTx: 'https://nile.tronscan.org/#/transaction/'
  };

  var SEND_PATHS = {
    '/send/bitcoin': BTC_CHAIN,
    '/send/ethereum': EVM_CHAIN,
    '/send/bnb': BNB_CHAIN,
    '/send/usdt': USDT_CHAIN,
    '/send/tron': TRON_CHAIN
  };
  var ALLOWED_CHAINS = [BTC_CHAIN, EVM_CHAIN, BNB_CHAIN, USDT_CHAIN, TRON_CHAIN];
  var MAINNET_SLUGS = ['bitcoin', 'ethereum', 'bnb', 'usdt', 'tron'];
  var ALLOWED_EVM_CHAIN_IDS = [SEPOLIA_CHAIN_ID, BNB_CHAIN_ID];

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  /* --------------------------------------------------------- chain routing */

  function isEvmChain(chain) {
    return Boolean(CHAINS[chain] && CHAINS[chain].kind === 'evm');
  }

  function isTokenChain(chain) {
    return Boolean(CHAINS[chain] && CHAINS[chain].token);
  }

  function isTronChain(chain) {
    return Boolean(CHAINS[chain] && CHAINS[chain].kind === 'tron');
  }

  function chainFromPath(pathname) {
    var value = String(pathname || '/send').replace(/\/+$/, '');
    return SEND_PATHS[value] || BTC_CHAIN;
  }

  function chainLabel(chain) {
    return CHAINS[chain] ? CHAINS[chain].label : CHAINS[BTC_CHAIN].label;
  }

  function assertTestnetChain(chain) {
    if (ALLOWED_CHAINS.indexOf(chain) >= 0) return chain;
    if (MAINNET_SLUGS.indexOf(chain) >= 0) {
      throw new Error('Mainnet sending is disabled: this page signs TESTNET transactions only.');
    }
    throw new Error('Unsupported chain: this page only sends on Bitcoin testnet, ' +
      'Ethereum Sepolia, BNB Smart Chain testnet and TRON Nile testnet.');
  }

  /* Chain ids the EVM signing path may ever see. BNB mainnet (56) and every
   * other untabled network are rejected. With a chain slug, the id must match
   * that chain exactly. */
  function assertAllowedChainId(chainId, chain) {
    var actual;
    try {
      actual = BigInt(chainId);
    } catch (err) {
      throw new Error('Invalid chain id: ' + String(chainId));
    }
    var config = chain ? CHAINS[chain] : null;
    if (config && config.chainId !== undefined) {
      if (actual !== BigInt(config.chainId)) {
        throw new Error(config.label + ' (chain id ' + config.chainId +
          ') is required; refusing to sign a different chain.');
      }
      return Number(actual);
    }
    if (ALLOWED_EVM_CHAIN_IDS.indexOf(Number(actual)) < 0) {
      throw new Error('Chain id ' + actual.toString() +
        ' is not an allowed testnet chain; refusing to sign.');
    }
    return Number(actual);
  }

  function providersForChain(chain, evmProviders) {
    if (chain === BNB_CHAIN) return BNB_TESTNET_PROVIDERS.slice();
    if (isEvmChain(chain)) return Array.isArray(evmProviders) ? evmProviders.slice() : [];
    return [];
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
      throw new Error('Blocked an EVM RPC outside the testnet allowlist.');
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

  function looksLikeWif(text) {
    return text.length >= WIF_MIN && text.length <= WIF_MAX &&
      /^[1-9A-HJ-NP-Za-km-z]+$/.test(text);
  }

  /* A Bitcoin WIF on the EVM and TRON routes is only a 32-byte key container:
   * the network byte and the compression byte do not change the key and do not
   * select the chain. Both Bitcoin mainnet (0x80) and testnet (0xef) versions
   * are accepted; every other version is a different coin's WIF and is not. */
  async function parseWifForSecpChain(text, chain) {
    if (!looksLikeWif(text)) {
      throw new Error(chainLabel(chain) +
        ' needs a 32-byte private key: a Bitcoin WIF or 64 hex characters (0x optional).');
    }
    var wif = await decodeWif(text);
    if (wif.version !== 0x80 && wif.version !== 0xef) {
      throw new Error('Only Bitcoin mainnet (0x80) or testnet (0xef) WIFs are accepted; ' +
        'the WIF network byte does not select the chain.');
    }
    var keyHex = bytesToHex(wif.key);
    return { chain: chain, keyBytes: wif.key, keyHex: keyHex };
  }

  /* Turn a pasted secret into a 32-byte key for the chain this route serves.
   * Hex is tried first; the EVM and TRON routes then accept a Bitcoin WIF as a
   * plain 32-byte key. Nothing here derives an address or touches the network. */
  async function parseSecret(text, chain) {
    assertTestnetChain(chain);
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw new Error('Paste a private key first.');

    if (isEvmChain(chain) || isTronChain(chain)) {
      var key = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
      if (key) {
        var hexKey = key[1].toLowerCase();
        return { chain: chain, keyBytes: hexToBytes(hexKey), keyHex: hexKey };
      }
      return parseWifForSecpChain(value, chain);
    }

    var btcHex = /^(?:0x)?([0-9a-fA-F]{64})$/.exec(value);
    if (btcHex) {
      var rawHex = btcHex[1].toLowerCase();
      return { chain: BTC_CHAIN, keyBytes: hexToBytes(rawHex), keyHex: rawHex };
    }
    if (!looksLikeWif(value)) {
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
    if (/^(?:0x)?[0-9a-fA-F]{64}$/.test(text)) return true;
    return looksLikeWif(text);
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

  /* ------------------------------------------------------ ERC-20 transfer */

  function normalizeEvmAddress(text, field) {
    var value = typeof text === 'string' ? text.trim().toLowerCase() : '';
    if (!/^0x[0-9a-f]{40}$/.test(value)) {
      throw new Error(field + ' must be 0x followed by 40 hex characters.');
    }
    return value;
  }

  function tokenDecimals(value) {
    var text = value === undefined || value === null ? '' : String(value).trim();
    if (!text) return USDT_DEFAULT_DECIMALS;
    if (!/^\d+$/.test(text)) throw new Error('Decimals must be a whole number between 0 and 36.');
    var parsed = Number(text);
    if (parsed > 36) throw new Error('Decimals must be between 0 and 36.');
    return parsed;
  }

  /* Strict decimal -> raw integer. No Number, no exponent, no rounding. This
   * is deliberately local: send.js is required standalone in the Node tests,
   * so it does not depend on RotorEvmSend being on the global object. */
  function parseTokenUnits(text, decimals) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value) throw new Error('Enter a token amount.');
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('Use a plain decimal token amount like 1.5 (no exponent, sign or comma).');
    }
    var fraction = match[2] || '';
    if (fraction.length > decimals) {
      throw new Error('At most ' + decimals + ' decimal places for this token.');
    }
    return BigInt(match[1]) * (10n ** BigInt(decimals)) +
      BigInt(fraction.padEnd(decimals, '0') || '0');
  }

  function pad32(hex) {
    if (hex.length > 64) throw new Error('A 32-byte word cannot hold that value.');
    return hex.padStart(64, '0');
  }

  /* Canonical ERC-20 transfer(address,uint256): selector 0xa9059cbb, the
   * recipient and the raw amount each left-padded to one 32-byte word. The
   * contract address is never assumed; it is required from the user. */
  function buildErc20Transfer(options) {
    var input = options || {};
    var contract = normalizeEvmAddress(input.contract, 'Token contract');
    var recipient = normalizeEvmAddress(input.recipient, 'Recipient');
    var decimals = tokenDecimals(input.decimals);
    var rawAmount = parseTokenUnits(input.amount, decimals);
    if (rawAmount <= 0n) throw new Error('Token amount must be greater than zero.');
    if (rawAmount > U256_MAX) throw new Error('Token amount is too large for a uint256.');
    var data = ERC20_TRANSFER_SELECTOR + pad32(recipient.slice(2)) + pad32(rawAmount.toString(16));
    return {
      contract: contract,
      recipient: recipient,
      decimals: decimals,
      rawAmount: rawAmount,
      data: data
    };
  }

  /* ------------------------------------------------------ TRON transfer */

  function tronApi(api) {
    var tron = api || root.RotorTronSend;
    if (!tron) throw new Error('The TRON helper did not load. Reload the page.');
    return tron;
  }

  /* TRX text -> sun. tron-tx.js rejects anything that is not a plain decimal
   * with at most 6 decimals; this wrapper adds the positive-amount rule. */
  function tronAmountSun(text, tron) {
    var api = tronApi(tron);
    var sun = api.tronToSun(text);
    if (sun <= 0n) throw new Error('TRX amount must be greater than zero.');
    return sun;
  }

  /* Build the unsigned TRX transfer for review. `options` takes
   * {wasm, tron, from, to, amount, latestBlock?, unsigned?}; the two callbacks
   * are the test seam and default to the real Nile helper and WASM core. */
  async function prepareTronTransfer(options) {
    var input = options || {};
    var tron = tronApi(input.tron);
    var from = tron.assertAddress(input.from, 'From');
    var to = tron.assertAddress(input.to, 'To');
    var sun = tronAmountSun(input.amount, tron);
    var latest = typeof input.latestBlock === 'function'
      ? input.latestBlock
      : function () { return tron.latestBlock(); };
    var block = await latest();
    if (!block || typeof block.ref_block_bytes !== 'string' ||
        typeof block.ref_block_hash !== 'string' || typeof block.expiration !== 'string' ||
        typeof block.timestamp !== 'string') {
      throw new Error('The Nile block reference is incomplete.');
    }
    var request = {
      owner_address: from,
      to_address: to,
      amount: sun.toString(),
      ref_block_bytes: block.ref_block_bytes,
      ref_block_hash: block.ref_block_hash,
      expiration: block.expiration,
      timestamp: block.timestamp,
      fee_limit: '0'
    };
    var unsigned = typeof input.unsigned === 'function'
      ? input.unsigned
      : function (fields) { return tron.unsignedTransfer(input.wasm, fields); };
    var tx = await unsigned(request);
    if (!tx || typeof tx !== 'object' || typeof tx.txID !== 'string' ||
        typeof tx.raw_data_hex !== 'string' || !/^[0-9a-fA-F]+$/.test(tx.raw_data_hex)) {
      throw new Error('The local core returned an unexpected TRON transaction.');
    }
    return {
      chain: TRON_CHAIN,
      from: from,
      to: to,
      amountSun: sun,
      amountTron: tron.sunToTron(sun),
      block: block,
      request: request,
      tx: tx
    };
  }

  /* Sign the reviewed TRX transfer. The private key goes to the WASM core in
   * its request buffer only; it is never added to the returned object. The
   * `sign` callback is the test seam and defaults to the real WASM call. */
  async function signTronTransfer(options) {
    var input = options || {};
    var tron = tronApi(input.tron);
    var review = input.review;
    if (!review || !review.request) throw new Error('No TRON review to sign.');
    var keyHex = String(input.keyHex || '').replace(/^0x/i, '').toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(keyHex)) {
      throw new Error('TRON signing needs a 32-byte hex key (64 hex characters).');
    }
    var request = {
      owner_address: review.request.owner_address,
      to_address: review.request.to_address,
      amount: review.request.amount,
      ref_block_bytes: review.request.ref_block_bytes,
      ref_block_hash: review.request.ref_block_hash,
      expiration: review.request.expiration,
      timestamp: review.request.timestamp,
      fee_limit: review.request.fee_limit,
      private_key: '0x' + keyHex
    };
    try {
      var sign = typeof input.sign === 'function'
        ? input.sign
        : function (fields) { return tron.signTransfer(input.wasm, fields); };
      var signed = await sign(request);
      if (!signed || typeof signed !== 'object' ||
          typeof signed.txID !== 'string' || typeof signed.raw_data_hex !== 'string' ||
          typeof signed.signature !== 'string') {
        throw new Error('The local core returned an unexpected signed TRON transaction.');
      }
      return signed;
    } finally {
      request.private_key = null;
      request = null;
    }
  }

  /* --------------------------------------------------------- derivation */

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

  /* Derive the sending address for `chain` from a 32-byte key through the same
   * local WASM core the page uses. EVM and TRON rows live in the mainnet report;
   * Bitcoin uses the Bitcoin testnet report. */
  function deriveAddress(wasm, keyBytes, chain) {
    assertTestnetChain(chain);
    var network = isEvmChain(chain) || isTronChain(chain) ? 0 : 1;
    var report = deriveReport(wasm, keyBytes, 0, network);
    var wanted = isEvmChain(chain) ? 'evm'
      : isTronChain(chain) ? 'tron' : 'btc_p2wpkh';
    var rows = Array.isArray(report.addresses) ? report.addresses : [];
    for (var i = 0; i < rows.length; i += 1) {
      if (rows[i] && rows[i].id === wanted &&
          typeof rows[i].address === 'string' && rows[i].address) {
        return rows[i].address;
      }
    }
    throw new Error('The local core returned no "' + wanted + '" address.');
  }

  /* ------------------------------------------------------------------ DOM */

  function init() {
    var btc = root.RotorBtcSend;
    var evm = root.RotorEvmSend;
    var tron = root.RotorTronSend;
    var state = {
      chain: assertTestnetChain(chainFromPath(root.location && root.location.pathname)),
      keyBytes: null,
      keyHex: null,
      address: '',
      wasm: null,
      wasmPromise: null,
      review: null,
      token: null,
      providers: [],
      signedHex: null,
      signedTx: null,
      busy: false
    };

    function byId(id) { return document.getElementById(id); }

    var keyInput = byId('send-key');
    var keyToggle = byId('send-key-toggle');
    var wifNotice = byId('send-wif-notice');
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
    var tokenInput = byId('send-token');
    var tokenDecimalsInput = byId('send-token-decimals');
    var tokenAmountInput = byId('send-token-amount');
    var tronAmountInput = byId('send-tron-amount');
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

    if (!btc || !evm || !tron) {
      if (unavailable) {
        unavailable.hidden = false;
        unavailable.textContent = 'The send kernel did not load. Reload the page.';
      }
      if (prepareButton) prepareButton.disabled = true;
      return;
    }

    var evmProviders = evm.PROVIDERS.map(function (provider) { return provider.url; });
    state.providers = providersForChain(state.chain, evmProviders);
    var config = CHAINS[state.chain];

    function setError(message) {
      if (!errorBox) return;
      errorBox.hidden = !message;
      errorBox.textContent = message || '';
    }

    function setStatus(message) {
      if (!statusBox) return;
      statusBox.textContent = message || '';
    }

    /* The EVM and TRON routes use a Bitcoin WIF only as a 32-byte key
     * container; remind the user that its network byte does not pick a chain. */
    function setWifNotice(show) {
      if (!wifNotice) return;
      wifNotice.hidden = !show;
      wifNotice.textContent = show
        ? 'Bitcoin WIF accepted as a 32-byte key; the WIF network byte does not select the chain.'
        : '';
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
      button.setAttribute('data-tooltip', 'Copied');
      button.setAttribute('aria-label', 'Copied');
      button._sendTimer = window.setTimeout(function () {
        use.setAttribute('href', button.getAttribute('data-icon') || '/icons.svg#ui-copy');
        var reset = button.getAttribute('data-label') || label;
        button.setAttribute('data-tooltip', reset);
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
      var evmMode = isEvmChain(state.chain);
      Array.prototype.forEach.call(document.querySelectorAll('[data-send-chain]'), function (link) {
        if (link.getAttribute('data-send-chain') === state.chain) link.setAttribute('aria-current', 'page');
        else link.removeAttribute('aria-current');
      });
      Array.prototype.forEach.call(document.querySelectorAll('[data-chain-only]'), function (el) {
        var allowed = (el.getAttribute('data-chain-only') || '').split(',');
        el.hidden = allowed.indexOf(state.chain) < 0;
      });
      var title = byId('send-title');
      if (title) title.textContent = config.title;
      var keyLabel = byId('send-key-label');
      if (keyLabel) keyLabel.textContent = config.keyLabel;
      var valueLabel = byId('send-value-label');
      if (valueLabel && config.nativeSymbol) {
        valueLabel.textContent = 'Value (' + config.nativeSymbol + ', optional for a call)';
      }
      var feeHelp = byId('send-fee-help');
      if (feeHelp) {
        if (isTronChain(state.chain)) {
          feeHelp.textContent = 'TRON Nile: a plain TRX transfer consumes bandwidth, not a token fee. ' +
            'The review shows the exact ref block and expiration taken from the latest Nile block.';
        } else if (isTokenChain(state.chain)) {
          feeHelp.textContent = 'ERC-20 transfer on Sepolia: gas defaults to 60000 and the exact calldata is shown before signing.';
        } else if (evmMode) {
          feeHelp.textContent = 'Empty gas fields are filled from ' + config.label +
            ' RPC estimates; every value is shown in the review before signing.';
        } else {
          feeHelp.textContent = 'Leave the fee rate empty to use mempool.space testnet recommendations; the review shows the exact fee.';
        }
      }
      document.title = config.title + ' — TESTNET only | Crypto';
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
      assertEvmRpcUrl(url, state.providers);
      return fetch(url, options).then(function (response) {
        return response.text().then(function (text) {
          if (!response.ok) throw new Error(config.label + ' RPC answered HTTP ' + response.status);
          try {
            return JSON.parse(text);
          } catch (err) {
            throw new Error(config.label + ' RPC returned non-JSON data.');
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
      setWifNotice(false);
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
      state.token = null;
      state.signedHex = null;
      state.signedTx = null;
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
      if (tokenInput) tokenInput.value = '';
      if (tokenDecimalsInput) tokenDecimalsInput.value = String(USDT_DEFAULT_DECIMALS);
      if (tokenAmountInput) tokenAmountInput.value = '';
      if (tronAmountInput) tronAmountInput.value = '';
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
        var address = deriveAddress(wasm, parsed.keyBytes, state.chain);
        if (token !== deriveToken) {
          parsed.keyBytes.fill(0);
          return;
        }
        if (state.keyBytes) state.keyBytes.fill(0);
        state.keyBytes = parsed.keyBytes;
        state.keyHex = parsed.keyHex;
        setAddress(address);
        setWifNotice((isEvmChain(state.chain) || isTronChain(state.chain)) &&
          looksLikeWif(value.trim()));
        setError('');
        setStatus(chainLabel(state.chain) + ' address derived locally. Nothing was sent.');
      } catch (err) {
        if (token !== deriveToken) return;
        if (state.keyBytes) state.keyBytes.fill(0);
        state.keyBytes = null;
        state.keyHex = null;
        setAddress('');
        setWifNotice(false);
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
      var symbol = config.nativeSymbol || 'ETH';
      addRow('Network', config.label + ' (TESTNET), chain id ' + review.chainId);
      addRow('From', review.from, true);
      if (state.token) {
        addRow('Recipient', state.token.recipient, true);
        addRow('Token contract', state.token.contract, true);
        addRow('Decimals', String(state.token.decimals));
        addRow('Token amount', evm.formatUnits(state.token.rawAmount, state.token.decimals));
        addRow('Calldata', state.token.data, true);
        addRow('Value', '0 (the token amount travels in the calldata)');
      } else {
        addRow('To', review.to, true);
        addRow('Value', evm.formatUnits(review.valueWei, evm.ETH_DECIMALS) + ' ' + symbol);
      }
      addRow('Gas limit', review.gasLimit.toString() + (review.gasLimitIsManual ? ' (manual)' : ' (estimated)'));
      addRow('Max fee', evm.formatUnits(review.maxFeeWei, evm.GWEI_DECIMALS) + ' gwei');
      addRow('Priority fee', evm.formatUnits(review.priorityWei, evm.GWEI_DECIMALS) + ' gwei');
      addRow('Nonce', review.nonce.toString());
      addRow('Total max cost', evm.formatUnits(review.totalMaxCostWei, evm.ETH_DECIMALS) + ' ' + symbol);
      addRow('Provider', review.providerLabel);
      renderWarnings(review.warnings);
      if (reviewUnsigned) reviewUnsigned.textContent = review.unsignedHex;
    }

    function renderTronReview(review) {
      if (!reviewList) return;
      reviewList.textContent = '';
      addRow('Network', 'TRON Nile testnet (TESTNET)');
      addRow('From', review.from, true);
      addRow('To', review.to, true);
      addRow('Amount', review.amountTron + ' TRX (' + review.amountSun.toString() + ' sun)');
      addRow('Ref block bytes', review.request.ref_block_bytes, true);
      addRow('Ref block hash', review.request.ref_block_hash, true);
      addRow('Expiration', review.request.expiration + ' ms since epoch');
      addRow('txID', review.tx.txID, true);
      addRow('raw_data_hex', review.tx.raw_data_hex, true);
      addRow('Fee', 'fee_limit 0; a plain TRX transfer consumes bandwidth, not a token fee');
      renderWarnings([
        'TESTNET only: this transaction targets the TRON Nile testnet. Mainnet hosts and the mainnet tron route are rejected; the page posts only to api.nileex.io.',
        'The expiration comes from the latest Nile block. Re-prepare if you wait more than about a minute before signing.'
      ]);
      if (reviewUnsigned) reviewUnsigned.textContent = review.tx.raw_data_hex;
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
        if (isTronChain(state.chain)) {
          var tronReview = await prepareTronTransfer({
            wasm: await loadWasm(),
            tron: tron,
            from: state.address,
            to: toInput ? toInput.value : '',
            amount: tronAmountInput ? tronAmountInput.value : ''
          });
          state.review = tronReview;
          renderTronReview(tronReview);
        } else if (isEvmChain(state.chain)) {
          var form;
          var token = null;
          if (isTokenChain(state.chain)) {
            token = buildErc20Transfer({
              contract: tokenInput ? tokenInput.value : '',
              recipient: toInput ? toInput.value : '',
              decimals: tokenDecimalsInput ? tokenDecimalsInput.value : '',
              amount: tokenAmountInput ? tokenAmountInput.value : ''
            });
            form = {
              to: token.contract,
              value: '0',
              data: token.data,
              gasLimit: (gasInput && gasInput.value.trim()) || USDT_DEFAULT_GAS,
              maxFee: maxFeeInput ? maxFeeInput.value : '',
              priorityFee: priorityInput ? priorityInput.value : ''
            };
          } else {
            form = {
              to: toInput ? toInput.value : '',
              value: valueInput ? valueInput.value : '',
              data: dataInput ? dataInput.value : '',
              gasLimit: gasInput ? gasInput.value : '',
              maxFee: maxFeeInput ? maxFeeInput.value : '',
              priorityFee: priorityInput ? priorityInput.value : ''
            };
          }
          var evmReview = await evm.prepareTransaction({
            form: form,
            from: state.address,
            fetchJson: fetchJson,
            unsigned: unsignedEvm,
            providers: state.providers,
            expectedChainId: config.chainId,
            chainName: config.label,
            nativeSymbol: config.nativeSymbol,
            networkName: config.label
          });
          state.token = token;
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
      var chainId = assertAllowedChainId(review.chainId, state.chain);
      var keyHex = bytesToHex(state.keyBytes);
      var request = {
        chain_id: String(chainId),
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
        if (isTronChain(state.chain)) {
          var signedTron = await signTronTransfer({
            wasm: await loadWasm(),
            tron: tron,
            review: state.review,
            keyHex: bytesToHex(state.keyBytes)
          });
          if (!/^[0-9a-f]{64}$/i.test(signedTron.txID) ||
              !/^[0-9a-f]+$/i.test(signedTron.raw_data_hex) ||
              signedTron.raw_data_hex.length % 2 ||
              !/^[0-9a-f]{130}$/i.test(signedTron.signature)) {
            throw new Error('The local core returned an unexpected signed transaction.');
          }
          state.signedTx = signedTron;
          showSigned('raw_data_hex: ' + signedTron.raw_data_hex +
            '\nsignature: ' + signedTron.signature);
        } else {
          var signed = isEvmChain(state.chain)
            ? await signEvm(state.review)
            : await signBtc(state.review);
          if (isEvmChain(state.chain)) {
            if (!/^0x02[0-9a-f]+$/.test(signed) || signed.length % 2) {
              throw new Error('The local core returned an unexpected signed transaction.');
            }
          } else if (!/^[0-9a-f]+$/.test(signed) || signed.length % 2) {
            throw new Error('The local core returned an unexpected signed transaction.');
          }
          showSigned(signed);
        }
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
        if (isTronChain(state.chain)) {
          setBusy(true, 'Broadcasting…');
          result = await tron.broadcast(state.signedTx);
          if (resultHash) resultHash.textContent = result.txID;
          if (resultLink) {
            resultLink.setAttribute('href', config.explorerTx + result.txID);
            resultLink.hidden = false;
          }
          setStatus('Broadcast to TRON Nile testnet accepted.');
        } else if (isEvmChain(state.chain)) {
          setBusy(true, 'Broadcasting…');
          result = await evm.confirmTransaction({
            review: state.review,
            fetchJson: fetchJson,
            sign: function () { return signed; }
          });
          if (config.explorerTx) result.explorerUrl = config.explorerTx + result.txHash;
          if (resultHash) resultHash.textContent = result.txHash;
          if (resultLink) {
            resultLink.setAttribute('href', result.explorerUrl);
            resultLink.hidden = false;
          }
          setStatus('Broadcast to ' + config.label + ' accepted.');
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
    BNB_CHAIN: BNB_CHAIN,
    USDT_CHAIN: USDT_CHAIN,
    TRON_CHAIN: TRON_CHAIN,
    SEPOLIA_CHAIN_ID: SEPOLIA_CHAIN_ID,
    BNB_CHAIN_ID: BNB_CHAIN_ID,
    BTC_API: BTC_API,
    BNB_TESTNET_PROVIDERS: BNB_TESTNET_PROVIDERS,
    ALLOWED_CHAINS: ALLOWED_CHAINS,
    ALLOWED_EVM_CHAIN_IDS: ALLOWED_EVM_CHAIN_IDS,
    ERC20_TRANSFER_SELECTOR: ERC20_TRANSFER_SELECTOR,
    USDT_DEFAULT_DECIMALS: USDT_DEFAULT_DECIMALS,
    USDT_DEFAULT_GAS: USDT_DEFAULT_GAS,
    chainFromPath: chainFromPath,
    chainLabel: chainLabel,
    isEvmChain: isEvmChain,
    isTokenChain: isTokenChain,
    isTronChain: isTronChain,
    providersForChain: providersForChain,
    assertTestnetChain: assertTestnetChain,
    assertAllowedChainId: assertAllowedChainId,
    assertBtcApiUrl: assertBtcApiUrl,
    assertBtcBroadcastUrl: assertBtcBroadcastUrl,
    assertEvmRpcUrl: assertEvmRpcUrl,
    base58Decode: base58Decode,
    decodeWif: decodeWif,
    looksLikeWif: looksLikeWif,
    parseSecret: parseSecret,
    keyLooksComplete: keyLooksComplete,
    deriveAddress: deriveAddress,
    containsSecret: containsSecret,
    normalizeEvmAddress: normalizeEvmAddress,
    tokenDecimals: tokenDecimals,
    parseTokenUnits: parseTokenUnits,
    buildErc20Transfer: buildErc20Transfer,
    tronAmountSun: tronAmountSun,
    prepareTronTransfer: prepareTronTransfer,
    signTronTransfer: signTronTransfer
  };
});
