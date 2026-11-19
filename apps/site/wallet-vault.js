/* Encrypted wallet vault codec shared by the cabinet wallet page and its Node
 * test. This file is pure: it never touches the DOM, IndexedDB, the URL, the
 * console or the network, and it keeps no module-level secret state.
 *
 * Record format (version 1):
 *   {
 *     version: 1,
 *     kdf:    { name: "PBKDF2-SHA256", iterations: 600000, salt: "<base64>" },
 *     cipher: { name: "AES-GCM", iv: "<base64>" },
 *     ciphertext: "<base64>",
 *     updated_at: "<ISO-8601>"
 *   }
 *
 * The plaintext is { entries: [{ id, chain, label, secret_type, secret }] }.
 * A fresh 16-byte salt and a fresh 12-byte IV are generated on every save. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RotorWalletVault = factory();
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  'use strict';

  var VERSION = 1;
  var MIN_ITERATIONS = 600000;
  /* An imported blob must not be able to freeze the tab with an absurd KDF
   * cost. Our own records use 600,000. */
  var MAX_ITERATIONS = 5000000;
  var SALT_BYTES = 16;
  var IV_BYTES = 12;
  var TAG_BITS = 128;
  var KDF_NAME = 'PBKDF2-SHA256';
  var CIPHER_NAME = 'AES-GCM';
  var SECRET_TYPES = { wif: true, hex: true };

  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  var ENCODER = new TextEncoder();
  var DECODER = new TextDecoder('utf-8');

  function fail(message) {
    throw new Error(message);
  }

  function resolveCrypto(cryptoObj) {
    var value = cryptoObj ||
      (typeof globalThis !== 'undefined' ? globalThis.crypto : null);
    if (!value || !value.subtle || typeof value.getRandomValues !== 'function') {
      fail('WebCrypto is unavailable. Open this page over https or localhost.');
    }
    return value;
  }

  function bytesToBase64(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i += 3) {
      var remaining = bytes.length - i;
      var b0 = bytes[i];
      var b1 = remaining > 1 ? bytes[i + 1] : 0;
      var b2 = remaining > 2 ? bytes[i + 2] : 0;
      var triple = (b0 << 16) | (b1 << 8) | b2;
      out += B64.charAt((triple >> 18) & 63) + B64.charAt((triple >> 12) & 63) +
        (remaining > 1 ? B64.charAt((triple >> 6) & 63) : '=') +
        (remaining > 2 ? B64.charAt(triple & 63) : '=');
    }
    return out;
  }

  function base64ToBytes(text) {
    if (typeof text !== 'string') fail('base64 field is not a string');
    var value = text.trim();
    if (!value || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) {
      fail('base64 field is malformed');
    }
    var body = value.replace(/=+$/, '');
    var out = new Uint8Array(Math.floor(body.length * 3 / 4));
    var buffer = 0;
    var bits = 0;
    var index = 0;
    for (var i = 0; i < body.length; i += 1) {
      var digit = B64.indexOf(body.charAt(i));
      if (digit < 0) fail('base64 field is malformed');
      buffer = (buffer << 6) | digit;
      bits += 6;
      if (bits >= 8) {
        bits -= 8;
        out[index] = (buffer >> bits) & 255;
        index += 1;
      }
    }
    return out.slice(0, index);
  }

  function randomBytes(cryptoObj, length) {
    var bytes = new Uint8Array(length);
    cryptoObj.getRandomValues(bytes);
    return bytes;
  }

  function validateIterations(value) {
    if (typeof value !== 'number' || !isFinite(value) || Math.floor(value) !== value) {
      fail('vault KDF iterations must be an integer');
    }
    if (value < MIN_ITERATIONS) {
      fail('vault KDF iterations are below the required ' + MIN_ITERATIONS);
    }
    if (value > MAX_ITERATIONS) {
      fail('vault KDF iterations exceed the supported maximum ' + MAX_ITERATIONS);
    }
    return value;
  }

  function canonicalEntry(entry, index) {
    if (!entry || typeof entry !== 'object') fail('entry ' + index + ' is not an object');
    var id = entry.id;
    var chain = entry.chain;
    var label = entry.label;
    var type = entry.secret_type;
    var secret = entry.secret;
    if (typeof id !== 'string' || !id) fail('entry ' + index + ' has no id');
    if (typeof chain !== 'string' || !chain) fail('entry ' + index + ' has no chain');
    if (typeof label !== 'string') fail('entry ' + index + ' has no label');
    if (typeof type !== 'string' || !SECRET_TYPES[type]) {
      fail('entry ' + index + ' has an unsupported secret_type');
    }
    if (typeof secret !== 'string' || !secret) fail('entry ' + index + ' has no secret');
    /* Copy only the schema fields: nothing else is ever written to the vault. */
    return { id: id, chain: chain, label: label, secret_type: type, secret: secret };
  }

  function canonicalEntries(entries) {
    if (!Array.isArray(entries)) fail('vault entries must be an array');
    return entries.map(canonicalEntry);
  }

  function validateRecord(record) {
    if (!record || typeof record !== 'object' || Array.isArray(record)) {
      fail('the backup is not a vault record');
    }
    if (record.version !== VERSION) fail('unsupported vault version');
    var kdf = record.kdf;
    if (!kdf || typeof kdf !== 'object') fail('vault record has no KDF');
    if (kdf.name !== KDF_NAME) fail('unsupported vault KDF');
    validateIterations(kdf.iterations);
    var salt = base64ToBytes(kdf.salt);
    if (salt.length !== SALT_BYTES) fail('vault salt must be ' + SALT_BYTES + ' bytes');
    var cipher = record.cipher;
    if (!cipher || typeof cipher !== 'object') fail('vault record has no cipher');
    if (cipher.name !== CIPHER_NAME) fail('unsupported vault cipher');
    var iv = base64ToBytes(cipher.iv);
    if (iv.length !== IV_BYTES) fail('vault IV must be ' + IV_BYTES + ' bytes');
    var ciphertext = base64ToBytes(record.ciphertext);
    if (!ciphertext.length) fail('vault ciphertext is empty');
    if (typeof record.updated_at !== 'string' || !record.updated_at) {
      fail('vault record has no updated_at');
    }
    return { salt: salt, iv: iv, ciphertext: ciphertext };
  }

  async function deriveKey(passphrase, salt, iterations, cryptoObj) {
    var material = await cryptoObj.subtle.importKey(
      'raw',
      ENCODER.encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return cryptoObj.subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt: salt,
        iterations: iterations
      },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  function nowIso() {
    return new Date().toISOString();
  }

  /**
   * Encrypt entries into a fresh vault record. The salt and IV are new on
   * every call, so saving the same entries twice never reuses key material.
   */
  async function createVaultRecord(entries, passphrase, options) {
    var settings = options || {};
    var cryptoObj = resolveCrypto(settings.crypto);
    if (typeof passphrase !== 'string' || !passphrase) fail('a passphrase is required');
    var iterations = validateIterations(settings.iterations || MIN_ITERATIONS);
    var salt = randomBytes(cryptoObj, SALT_BYTES);
    var iv = randomBytes(cryptoObj, IV_BYTES);
    var key = await deriveKey(passphrase, salt, iterations, cryptoObj);
    var plaintext = ENCODER.encode(JSON.stringify({ entries: canonicalEntries(entries) }));
    var encrypted = await cryptoObj.subtle.encrypt(
      { name: 'AES-GCM', iv: iv, tagLength: TAG_BITS },
      key,
      plaintext
    );
    return {
      version: VERSION,
      kdf: {
        name: KDF_NAME,
        iterations: iterations,
        salt: bytesToBase64(salt)
      },
      cipher: {
        name: CIPHER_NAME,
        iv: bytesToBase64(iv)
      },
      ciphertext: bytesToBase64(new Uint8Array(encrypted)),
      updated_at: nowIso()
    };
  }

  /** Decrypt a vault record. A wrong passphrase and tampered ciphertext both
   * fail with the same message: the codec must not reveal which one it was. */
  async function decryptVaultRecord(record, passphrase, options) {
    var settings = options || {};
    var cryptoObj = resolveCrypto(settings.crypto);
    if (typeof passphrase !== 'string' || !passphrase) fail('a passphrase is required');
    var parts = validateRecord(record);
    var key = await deriveKey(passphrase, parts.salt, record.kdf.iterations, cryptoObj);
    var decrypted;
    try {
      decrypted = await cryptoObj.subtle.decrypt(
        { name: 'AES-GCM', iv: parts.iv, tagLength: TAG_BITS },
        key,
        parts.ciphertext
      );
    } catch (err) {
      fail('Cannot decrypt the vault: wrong passphrase or damaged data.');
    }
    var data;
    try {
      data = JSON.parse(DECODER.decode(decrypted));
    } catch (err) {
      fail('Cannot decrypt the vault: the payload is not valid JSON.');
    }
    if (!data || typeof data !== 'object' || !Array.isArray(data.entries)) {
      fail('Cannot decrypt the vault: the payload has no entries array.');
    }
    return { entries: canonicalEntries(data.entries) };
  }

  /** Export exactly the encrypted record. No plaintext or derived data is
   * included. The result is base64 text so it survives files and chat apps. */
  function exportVaultBlob(record) {
    validateRecord(record);
    return bytesToBase64(ENCODER.encode(JSON.stringify(record)));
  }

  /** Import an exported blob. Plaintext JSON is rejected: only an encrypted
   * version-1 record with the required KDF/cipher parameters is accepted. */
  function importVaultBlob(blob) {
    if (typeof blob !== 'string' || !blob.trim()) fail('the backup is empty');
    var text;
    try {
      text = DECODER.decode(base64ToBytes(blob.replace(/\s+/g, '')));
    } catch (err) {
      fail('the backup is not an encrypted vault blob');
    }
    var record;
    try {
      record = JSON.parse(text);
    } catch (err) {
      fail('the backup is not an encrypted vault blob');
    }
    validateRecord(record);
    return record;
  }

  return {
    VERSION: VERSION,
    MIN_ITERATIONS: MIN_ITERATIONS,
    MAX_ITERATIONS: MAX_ITERATIONS,
    validateRecord: validateRecord,
    createVaultRecord: createVaultRecord,
    decryptVaultRecord: decryptVaultRecord,
    exportVaultBlob: exportVaultBlob,
    importVaultBlob: importVaultBlob
  };
});
