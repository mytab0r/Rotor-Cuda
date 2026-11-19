/* EVM testnet send flow (pure browser/Node codec, no DOM).
 *
 * This module owns the parts that can be tested without a browser:
 *  - exact decimal parsing of ETH and gwei values into wei (BigInt, no float);
 *  - destination, data and quantity validation with field-specific errors;
 *  - the chain-id guard, review preparation over an injected public RPC and
 *    the explicit confirm step that signs and broadcasts.
 *
 * It never holds a private key: `confirmTransaction` calls an injected `sign`
 * callback bound to the unlocked vault entry, and the only network payloads it
 * builds are public JSON-RPC reads and the signed raw transaction. The
 * provider URLs are called directly by the browser with its real Origin; there
 * is no proxy and no spoofing here. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorEvmSend = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var SEPOLIA = {
    chainId: 11155111,
    chainIdHex: '0xaa36a7',
    name: 'Ethereum Sepolia',
    explorerTx: 'https://sepolia.etherscan.io/tx/'
  };

  /* Verified with a real browser (Chrome, Origin http://127.0.0.1:18321) on
   * 2026-11-19: all three answer eth_chainId with 0xaa36a7 and allow CORS.
   * rpc.sepolia.org returns HTTP 404 and sepolia.drpc.org refuses the Sepolia
   * chain on its free plan, so neither is offered. */
  var PROVIDERS = [
    { id: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com', label: 'publicnode.com' },
    { id: '1rpc', url: 'https://1rpc.io/sepolia', label: '1RPC' },
    { id: 'tenderly', url: 'https://sepolia.gateway.tenderly.co', label: 'Tenderly gateway' }
  ];

  /* EVM chains the vault can hold; only Sepolia is enabled for sending. */
  var EVM_CHAIN_SLUGS = [
    'ethereum', 'bnb', 'arbitrum', 'optimism', 'base', 'polygon', 'avalanche', 'zksync'
  ];

  var ETH_DECIMALS = 18;
  var GWEI_DECIMALS = 9;
  var U64_MAX = (1n << 64n) - 1n;
  var U128_MAX = (1n << 128n) - 1n;

  function errorText(err) {
    return err && err.message ? err.message : String(err);
  }

  function fieldError(errors, key, message) {
    errors[key] = message;
  }

  /* Exact decimal -> integer conversion. No Number, no exponent, no rounding. */
  function parseUnits(text, decimals) {
    if (typeof text !== 'string') throw new Error('use a plain decimal number');
    var value = text.trim();
    if (!value) throw new Error('a number is required');
    var match = /^(\d+)(?:\.(\d+))?$/.exec(value);
    if (!match) {
      throw new Error('use a plain decimal number like 0.01 (no exponent, sign or comma)');
    }
    var fraction = match[2] || '';
    if (fraction.length > decimals) {
      throw new Error('at most ' + decimals + ' decimal places');
    }
    return BigInt(match[1]) * (10n ** BigInt(decimals)) +
      BigInt(fraction.padEnd(decimals, '0') || '0');
  }

  function formatUnits(value, decimals) {
    var unit = 10n ** BigInt(decimals);
    var whole = value / unit;
    var fraction = (value % unit).toString().padStart(decimals, '0').replace(/0+$/, '');
    return fraction ? whole.toString() + '.' + fraction : whole.toString();
  }

  function parseEthToWei(text) {
    return parseUnits(text, ETH_DECIMALS);
  }

  function parseGweiToWei(text) {
    return parseUnits(text, GWEI_DECIMALS);
  }

  function normalizeAddress(text) {
    if (typeof text !== 'string') throw new Error('Enter a 0x-prefixed 20-byte address.');
    var value = text.trim();
    if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
      throw new Error('Use 0x followed by 40 hex characters.');
    }
    return value.toLowerCase();
  }

  function normalizeData(text) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!value || value === '0x' || value === '0X') return '0x';
    if (!/^0[xX][0-9a-fA-F]*$/.test(value)) {
      throw new Error('Use 0x followed by hexadecimal digits, or leave empty.');
    }
    var hex = value.slice(2).toLowerCase();
    if (hex.length % 2) throw new Error('Use an even number of hex digits.');
    return '0x' + hex;
  }

  function parseUint(text, max, field) {
    var value = typeof text === 'string' ? text.trim() : '';
    if (!/^\d+$/.test(value)) throw new Error(field + ' must be a whole decimal number.');
    var parsed = BigInt(value);
    if (parsed <= 0n) throw new Error(field + ' must be greater than zero.');
    if (parsed > max) throw new Error(field + ' is too large.');
    return parsed;
  }

  function parseFee(text, field, allowZero) {
    var parsed = parseGweiToWei(text);
    if (!allowZero && parsed === 0n) throw new Error(field + ' must be greater than zero.');
    return parsed;
  }

  /* Validate the raw form strings. Returns { errors, values }; every value
   * that parsed is present even when another field failed, so the UI can show
   * all field errors at once. */
  function validateForm(raw) {
    var input = raw || {};
    var errors = {};
    var values = {
      to: null,
      value: 0n,
      data: '0x',
      gasLimit: null,
      maxFee: null,
      priorityFee: null
    };

    try {
      values.to = normalizeAddress(input.to);
    } catch (err) {
      fieldError(errors, 'to', errorText(err));
    }

    try {
      var valueText = typeof input.value === 'string' ? input.value.trim() : '';
      values.value = valueText ? parseEthToWei(valueText) : 0n;
      if (values.value > U128_MAX) throw new Error('Value is too large.');
    } catch (err) {
      fieldError(errors, 'value', errorText(err));
    }

    try {
      values.data = normalizeData(input.data);
    } catch (err) {
      fieldError(errors, 'data', errorText(err));
    }

    try {
      var gasText = typeof input.gasLimit === 'string' ? input.gasLimit.trim() : '';
      if (gasText) values.gasLimit = parseUint(gasText, U64_MAX, 'Gas limit');
    } catch (err) {
      fieldError(errors, 'gasLimit', errorText(err));
    }

    try {
      var maxText = typeof input.maxFee === 'string' ? input.maxFee.trim() : '';
      if (maxText) values.maxFee = parseFee(maxText, 'Max fee', false);
      if (values.maxFee !== null && values.maxFee > U128_MAX) {
        throw new Error('Max fee is too large.');
      }
    } catch (err) {
      fieldError(errors, 'maxFee', errorText(err));
    }

    try {
      var priorityText = typeof input.priorityFee === 'string' ? input.priorityFee.trim() : '';
      if (priorityText) values.priorityFee = parseFee(priorityText, 'Priority fee', true);
      if (values.priorityFee !== null && values.priorityFee > U128_MAX) {
        throw new Error('Priority fee is too large.');
      }
    } catch (err) {
      fieldError(errors, 'priorityFee', errorText(err));
    }

    if (values.maxFee !== null && values.priorityFee !== null &&
        values.priorityFee > values.maxFee) {
      fieldError(errors, 'priorityFee', 'Priority fee must not exceed the max fee.');
    }

    return { errors: errors, values: values };
  }

  /* ------------------------------------------------------------- chain id */

  function parseChainId(value) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error('eth_chainId returned a non-hex quantity.');
    }
    return BigInt(value);
  }

  function assertChainId(value, expectedId) {
    var actual = parseChainId(value);
    var expected = BigInt(expectedId);
    if (actual !== expected) {
      throw new Error('Chain id mismatch: the provider answered ' + actual.toString() +
        ' but ' + expected.toString() + ' is required. Refusing to sign.');
    }
    return Number(actual);
  }

  /* ------------------------------------------------------------------ RPC */

  function rpcCall(fetchJson, url, method, params) {
    return Promise.resolve()
      .then(function () {
        return fetchJson(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: method,
            params: params
          })
        });
      })
      .then(function (response) {
        if (!response || typeof response !== 'object') {
          throw new Error('the RPC returned a non-JSON response');
        }
        if (response.error) {
          throw new Error(String(response.error.message || 'RPC error code ' + response.error.code));
        }
        if (!Object.prototype.hasOwnProperty.call(response, 'result')) {
          throw new Error('the RPC response has no result');
        }
        return response.result;
      });
  }

  function providerLabel(url) {
    for (var i = 0; i < PROVIDERS.length; i += 1) {
      if (PROVIDERS[i].url === url) return PROVIDERS[i].label;
    }
    return url;
  }

  function quantity(value, field) {
    if (typeof value !== 'string' || !/^0x[0-9a-fA-F]+$/.test(value)) {
      throw new Error(field + ' is not a hex quantity.');
    }
    return BigInt(value);
  }

  function toQuantity(value) {
    return '0x' + value.toString(16);
  }

  function assertType2Hex(text, what) {
    if (typeof text !== 'string' || !/^0x02[0-9a-f]+$/.test(text) || text.length % 2) {
      throw new Error('The local core returned an unexpected ' + what + '.');
    }
    return text;
  }

  function chooseProvider(fetchJson, providers, expectedChainId) {
    var failures = [];

    function attempt(index) {
      if (index >= providers.length) {
        throw new Error('No public Sepolia RPC answered correctly from this browser' +
          (providers.length > 1 ? ' (tried ' + providers.length + ' endpoints)' : '') +
          '. Browser CORS or network access may be blocked; Rotor does not proxy or spoof Origin. ' +
          failures.join(' · '));
      }
      var url = providers[index];
      return rpcCall(fetchJson, url, 'eth_chainId', []).then(function (hex) {
        assertChainId(hex, expectedChainId);
        return url;
      }).catch(function (err) {
        failures.push(providerLabel(url) + ': ' + errorText(err));
        return attempt(index + 1);
      });
    }

    return attempt(0);
  }

  function read(fetchJson, url, method, params, what) {
    return rpcCall(fetchJson, url, method, params).catch(function (err) {
      throw new Error('Reading ' + what + ' failed on ' + providerLabel(url) + ': ' + errorText(err));
    });
  }

  /* --------------------------------------------------------------- prepare */

  /* Build the review. It never signs: `unsigned` is a local serializer and
   * there is no signing callback in this function's contract.
   *
   * options: { form, from, fetchJson, providers?, providerUrl?,
   *            unsigned(fields) -> hex, expectedChainId?, chainName? } */
  async function prepareTransaction(options) {
    var settings = options || {};
    var expectedChainId = settings.expectedChainId === undefined
      ? SEPOLIA.chainId
      : settings.expectedChainId;
    var validated = validateForm(settings.form);
    if (Object.keys(validated.errors).length) {
      var invalid = new Error('Fix the highlighted fields before review.');
      invalid.fieldErrors = validated.errors;
      throw invalid;
    }
    if (typeof settings.unsigned !== 'function') {
      throw new Error('The local unsigned-transaction builder is unavailable.');
    }

    var from;
    try {
      from = normalizeAddress(settings.from);
    } catch (err) {
      throw new Error('The vault address is invalid: ' + errorText(err));
    }
    var values = validated.values;
    var providers = settings.providerUrl
      ? [settings.providerUrl]
      : (settings.providers || PROVIDERS.map(function (provider) { return provider.url; }));

    var providerUrl;
    var nonce;
    var balance;
    var estimate;
    var baseFee;
    var networkPriority;
    var feesSource = 'eth_feeHistory';
    var prioritySource = 'eth_maxPriorityFeePerGas';

    return chooseProvider(settings.fetchJson, providers, expectedChainId)
      .then(function (chosen) {
        providerUrl = chosen;
        return read(settings.fetchJson, chosen, 'eth_getTransactionCount', [from, 'pending'], 'the nonce');
      })
      .then(function (nonceHex) {
        nonce = quantity(nonceHex, 'nonce');
        if (nonce > U64_MAX) throw new Error('The nonce is too large.');
        return read(settings.fetchJson, providerUrl, 'eth_getBalance', [from, 'latest'], 'the balance');
      })
      .then(function (balanceHex) {
        balance = quantity(balanceHex, 'balance');
        var call = { from: from, to: values.to, value: toQuantity(values.value) };
        if (values.data !== '0x') call.data = values.data;
        return read(settings.fetchJson, providerUrl, 'eth_estimateGas', [call], 'the gas estimate');
      })
      .then(function (estimateHex) {
        estimate = quantity(estimateHex, 'gas estimate');
        if (estimate === 0n || estimate > U64_MAX) throw new Error('The gas estimate is out of range.');
        return rpcCall(settings.fetchJson, providerUrl, 'eth_feeHistory', ['0x1', 'latest', []])
          .then(function (history) {
            if (!history || !Array.isArray(history.baseFeePerGas) || !history.baseFeePerGas.length) {
              throw new Error('the fee history has no base fee');
            }
            baseFee = quantity(history.baseFeePerGas[history.baseFeePerGas.length - 1], 'base fee');
          }, function () {
            feesSource = 'eth_gasPrice';
            return read(settings.fetchJson, providerUrl, 'eth_gasPrice', [], 'the base fee')
              .then(function (hex) { baseFee = quantity(hex, 'base fee'); });
          });
      })
      .then(function () {
        return rpcCall(settings.fetchJson, providerUrl, 'eth_maxPriorityFeePerGas', [])
          .then(function (hex) {
            networkPriority = quantity(hex, 'priority fee');
          }, function () {
            prioritySource = 'eth_gasPrice';
            return read(settings.fetchJson, providerUrl, 'eth_gasPrice', [], 'the priority fee')
              .then(function (hex) { networkPriority = quantity(hex, 'priority fee'); });
          });
      })
      .then(function () {
        var priority = values.priorityFee === null ? networkPriority : values.priorityFee;
        var maxFee = values.maxFee === null ? baseFee * 2n + priority : values.maxFee;
        if (priority > maxFee) {
          var conflict = new Error('Priority fee exceeds the max fee.');
          conflict.fieldErrors = { priorityFee: 'Priority fee must not exceed the max fee.' };
          throw conflict;
        }
        var gasLimit = values.gasLimit === null ? estimate : values.gasLimit;
        var totalMaxCost = values.value + gasLimit * maxFee;
        var fields = {
          chain_id: String(expectedChainId),
          nonce: nonce.toString(),
          max_priority_fee: priority.toString(),
          max_fee: maxFee.toString(),
          gas_limit: gasLimit.toString(),
          to: values.to,
          value: values.value.toString(),
          data: values.data
        };
        return Promise.resolve(settings.unsigned(fields)).then(function (unsignedHex) {
          assertType2Hex(unsignedHex, 'unsigned transaction');

          var warnings = [];
          if (values.gasLimit !== null && gasLimit < estimate) {
            warnings.push('Gas limit ' + gasLimit.toString() +
              ' is below the node estimate of ' + estimate.toString() +
              '; the transaction may run out of gas.');
          }
          if (totalMaxCost > balance) {
            warnings.push('The maximum cost exceeds the balance of ' +
              formatUnits(balance, ETH_DECIMALS) +
              ' ETH; the node will reject the transaction.');
          }
          if (/^0x0{40}$/.test(values.to)) {
            warnings.push('The destination is the zero address; value sent there is not recoverable.');
          }

          return {
            chainId: expectedChainId,
            chainName: settings.chainName || SEPOLIA.name,
            from: from,
            to: values.to,
            valueWei: values.value,
            dataHex: values.data,
            gasLimit: gasLimit,
            gasEstimate: estimate,
            gasLimitIsManual: values.gasLimit !== null,
            priorityWei: priority,
            maxFeeWei: maxFee,
            baseFeeWei: baseFee,
            nonce: nonce,
            balanceWei: balance,
            totalMaxCostWei: totalMaxCost,
            feesSource: feesSource,
            prioritySource: prioritySource,
            providerUrl: providerUrl,
            providerLabel: providerLabel(providerUrl),
            warnings: warnings,
            unsignedHex: unsignedHex
          };
        });
      });
  }

  /* --------------------------------------------------------------- confirm */

  /* options: { review, fetchJson, sign(fields) -> signed hex } */
  async function confirmTransaction(options) {
    var settings = options || {};
    var review = settings.review;
    if (!review || typeof review !== 'object') {
      throw new Error('Prepare and review the transaction first.');
    }
    if (typeof settings.sign !== 'function') {
      throw new Error('Local signing is unavailable.');
    }
    if (typeof settings.fetchJson !== 'function' || !review.providerUrl) {
      throw new Error('The RPC provider is missing from the review.');
    }
    assertType2Hex(review.unsignedHex, 'unsigned transaction');

    return read(settings.fetchJson, review.providerUrl, 'eth_chainId', [], 'the chain id')
      .then(function (chainHex) {
        assertChainId(chainHex, review.chainId);
        var fields = {
          chain_id: String(review.chainId),
          nonce: String(review.nonce),
          max_priority_fee: String(review.priorityWei),
          max_fee: String(review.maxFeeWei),
          gas_limit: String(review.gasLimit),
          to: review.to,
          value: String(review.valueWei),
          data: review.dataHex
        };
        return Promise.resolve(settings.sign(fields));
      })
      .then(function (signedHex) {
        assertType2Hex(signedHex, 'signed transaction');
        return rpcCall(settings.fetchJson, review.providerUrl, 'eth_sendRawTransaction', [signedHex])
          .catch(function (err) {
            throw new Error('Broadcasting to ' + providerLabel(review.providerUrl) +
              ' failed: ' + errorText(err));
          })
          .then(function (hash) {
            if (typeof hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(hash)) {
              throw new Error('The provider returned an unexpected transaction hash.');
            }
            var txHash = hash.toLowerCase();
            return {
              signedHex: signedHex,
              txHash: txHash,
              providerUrl: review.providerUrl,
              providerLabel: providerLabel(review.providerUrl),
              explorerUrl: SEPOLIA.explorerTx + txHash
            };
          });
      });
  }

  return {
    SEPOLIA: SEPOLIA,
    PROVIDERS: PROVIDERS,
    EVM_CHAIN_SLUGS: EVM_CHAIN_SLUGS,
    ETH_DECIMALS: ETH_DECIMALS,
    GWEI_DECIMALS: GWEI_DECIMALS,
    parseUnits: parseUnits,
    formatUnits: formatUnits,
    parseEthToWei: parseEthToWei,
    parseGweiToWei: parseGweiToWei,
    normalizeAddress: normalizeAddress,
    normalizeData: normalizeData,
    parseChainId: parseChainId,
    assertChainId: assertChainId,
    validateForm: validateForm,
    prepareTransaction: prepareTransaction,
    confirmTransaction: confirmTransaction,
    providerLabel: providerLabel
  };
});
