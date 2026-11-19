// Tests for the client-side transaction decoders: Bitcoin legacy and SegWit
// vectors, EIP-155 legacy and EIP-1559 type-2 vectors (the latter are pinned
// against ethers output in crates/rotor-wasm/src/evm.rs), a type-1 access-list
// vector built with canonical RLP, and malformed inputs.
//
// Usage: node apps/site/tx-test.mjs

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const decoders = require("./tx-decoders.js");

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}\n  expected: ${JSON.stringify(expected)}\n  actual:   ${JSON.stringify(actual)}`);
  }
}

function assertError(fn, needle, message) {
  let error = null;
  try {
    fn();
  } catch (err) {
    error = err;
  }
  assert(error, `${message}: expected an error`);
  assert(
    error.message.toLowerCase().includes(needle.toLowerCase()),
    `${message}: expected "${needle}" in "${error.message}"`,
  );
  return error.message;
}

function hexBytes(hex) {
  return Uint8Array.from(Buffer.from(hex.replace(/^0x/i, ""), "hex"));
}

function bytesHex(bytes) {
  return Buffer.from(bytes).toString("hex");
}

/* Minimal canonical RLP encoder for the type-1 fixture. The decoder is tested
 * independently with the published legacy and type-2 vectors above. */
function rlpLength(length, shortBase, longBase) {
  if (length <= 55) return Uint8Array.of(shortBase + length);
  let hex = length.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  const bytes = hexBytes(hex);
  return Uint8Array.of(longBase + bytes.length, ...bytes);
}

function rlpBytes(bytes) {
  if (bytes.length === 1 && bytes[0] < 0x80) return Uint8Array.of(bytes[0]);
  return Uint8Array.from([...rlpLength(bytes.length, 0x80, 0xb7), ...bytes]);
}

function rlpList(items) {
  const payload = items.reduce((out, item) => out.concat([...item]), []);
  return Uint8Array.from([...rlpLength(payload.length, 0xc0, 0xf7), ...payload]);
}

function rlpInt(value) {
  if (value === 0n) return rlpBytes(new Uint8Array(0));
  let hex = value.toString(16);
  if (hex.length % 2) hex = "0" + hex;
  return rlpBytes(hexBytes(hex));
}

function concatBytes(parts) {
  return Uint8Array.from(parts.reduce((out, part) => out.concat([...part]), []));
}

// ---------------------------------------------------------------- Bitcoin

const BTC_LEGACY =
  "0100000001c997a5e56e104102fa209c6a852dd90660a20b2d9c352423edce25857fcd3704" +
  "000000004847304402204e45e16932b8af514961a1d3a1a25fdf3f4f7732e9d624c6c61548ab5fb8cd41" +
  "0220181522ec8eca07de4860a4acdd12909d831cc56cbbac4622082221a8768d1d0901ffffffff" +
  "0200ca9a3b00000000434104ae1a62fe09c5f51b13905f07f06b99a2f7159b2225f374cd378d71302fa28414e7aab37397f554a7df5f142c21c1b7303b8a0626f1baded5c72a704f7e6cd84cac" +
  "00286bee0000000043410411db93e1dcdb8a016b49840f8c53bc1eb68a382e97b1482ecad7b148a6909a5cb2e0eaddfb84ccf9744464f82e160bfa9b8b64f9d4c03f999b8643f656b412a3ac" +
  "00000000";

const legacy = decoders.decodeBitcoin(BTC_LEGACY);
assertEqual(legacy.encoding, "legacy", "BTC legacy encoding");
assertEqual(legacy.version, 1, "BTC legacy version");
assertEqual(legacy.marker, null, "BTC legacy marker");
assertEqual(legacy.inputCount, 1, "BTC legacy input count");
assertEqual(legacy.inputs[0].txid, "0437cd7f8525ceed2324359c2d0ba26006d92d856a9c20fa0241106ee5a597c9", "BTC legacy txid");
assertEqual(legacy.inputs[0].vout, 0, "BTC legacy vout");
assertEqual(legacy.inputs[0].sequence, 4294967295, "BTC legacy sequence");
assertEqual(legacy.inputs[0].scriptSigLength, 72, "BTC legacy scriptSig length");
assertEqual(legacy.inputs[0].witness.length, 0, "BTC legacy has no witness");
assertEqual(legacy.outputCount, 2, "BTC legacy output count");
assertEqual(legacy.outputs[0].valueSats, "1000000000", "BTC legacy output 0 sats");
assertEqual(legacy.outputs[0].valueBtc, "10", "BTC legacy output 0 BTC");
assertEqual(legacy.outputs[0].scriptType, "p2pk", "BTC legacy output 0 script type");
assertEqual(legacy.outputs[0].address, null, "P2PK has no address");
assertEqual(legacy.outputs[0].pubkey.startsWith("04"), true, "P2PK pubkey is uncompressed");
assertEqual(legacy.outputs[1].valueSats, "4000000000", "BTC legacy output 1 sats");
assertEqual(legacy.outputs[1].valueBtc, "40", "BTC legacy output 1 BTC");
assertEqual(legacy.totalOutSats, "5000000000", "BTC legacy total output");
assertEqual(legacy.locktime, 0, "BTC legacy locktime");
assertEqual(legacy.size, 275, "BTC legacy size");
assertEqual(legacy.weight, 1100, "BTC legacy weight");
assertEqual(legacy.vsize, 275, "BTC legacy vsize");
assertEqual(legacy.feeSats, null, "BTC legacy fee is unknown without prevouts");
assertEqual(legacy.feeNote, "fee unavailable without prevouts", "BTC legacy fee note");
assert(typeof JSON.stringify(legacy) === "string", "BTC legacy report is JSON-serialisable");

const withFee = decoders.decodeBitcoin(BTC_LEGACY, "5000000001");
assertEqual(withFee.feeSats, "1", "BTC fee from prevouts");
assertEqual(withFee.feeBtc, "0.00000001", "BTC fee in BTC");
assertEqual(withFee.feeNote, null, "BTC fee note is cleared");
assertError(() => decoders.decodeBitcoin(BTC_LEGACY, "1 2"), "2 value(s) for 1 input(s)", "prevout count mismatch");
assertError(() => decoders.decodeBitcoin(BTC_LEGACY, "1"), "below the output total", "prevout total below outputs");
assertError(() => decoders.decodeBitcoin(BTC_LEGACY, "x"), "whole number of satoshis", "prevout value validation");

const BTC_SEGWIT =
  "01000000000102" +
  "fff7f7881a8099afa6940d42d1e7f6362bec38171ea3edf433541db4e4ad969f00000000" +
  "494830450221008b9d1dc26ba6a9cb62127b02742fa9d754cd3bebf337f7a55d114c8e5cdd30be" +
  "022040529b194ba3f9281a99f2b1c0a19c0489bc22ede944ccf4ecbab4cc618ef3ed01eeffffff" +
  "ef51e1b804cc89d182d279655c3aa89e815b1b309fe287d9b2b55d57b90ec68a0100000000ffffffff" +
  "02202cb206000000001976a9148280b37df378db99f66f85c95a783a76ac7a6d5988ac" +
  "9093510d000000001976a9143bde42dbee7e4dbe6a21b2d50ce2f0167faa815988ac" +
  "00" +
  "0247304402203609e17b84f6a7d30c80bfa610b5b4542f32a8a0d5447a12fb1366d7f01cc44a" +
  "0220573a954c4518331561406f90300e8f3358f51928d43c212a8caed02de67eebee01" +
  "21025476c2e83188368da1ff3e292e7acafcdb3566bb0ad253f62fc70f07aeee6357" +
  "11000000";

const segwit = decoders.decodeBitcoin("0x" + BTC_SEGWIT.toUpperCase());
assertEqual(segwit.encoding, "segwit", "BTC segwit encoding");
assertEqual(segwit.marker, 0, "BTC segwit marker");
assertEqual(segwit.flag, 1, "BTC segwit flag");
assertEqual(segwit.inputCount, 2, "BTC segwit input count");
assertEqual(segwit.outputs[0].valueSats, "112340000", "BTC segwit output 0 sats");
assertEqual(segwit.outputs[0].valueBtc, "1.1234", "BTC segwit output 0 BTC");
assertEqual(segwit.outputs[0].scriptType, "p2pkh", "BTC segwit output 0 type");
assert(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(segwit.outputs[0].address), "BTC segwit output 0 address");
assertEqual(segwit.outputs[1].valueSats, "223450000", "BTC segwit output 1 sats");
assertEqual(segwit.outputs[1].valueBtc, "2.2345", "BTC segwit output 1 BTC");
assert(/^1[1-9A-HJ-NP-Za-km-z]{25,34}$/.test(segwit.outputs[1].address), "BTC segwit output 1 address");
assertEqual(segwit.inputs[0].witness.length, 0, "BTC segwit input 0 empty witness");
assertEqual(segwit.inputs[1].witness.length, 2, "BTC segwit input 1 witness items");
assertEqual(segwit.inputs[1].witness[0].length, 142, "BTC segwit witness signature length");
assertEqual(segwit.inputs[1].witness[1].length, 66, "BTC segwit witness pubkey length");
assertEqual(segwit.size, 343, "BTC segwit size");
assertEqual(segwit.weight, 1042, "BTC segwit weight");
assertEqual(segwit.vsize, 261, "BTC segwit vsize");
assertEqual(segwit.locktime, 17, "BTC segwit locktime");

// BIP173/BIP350 address vectors and the genesis P2PKH hash160.
assertEqual(
  decoders.scriptInfo("76a91462e907b15cbf27d5425399ebf6f0fb50ebb88f1888ac").address,
  "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
  "P2PKH base58check vector",
);
assertEqual(
  decoders.scriptInfo("0014751e76e8199196d454941c45d1b3a323f1433bd6").address,
  "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
  "P2WPKH bech32 vector",
);
assertEqual(
  decoders.scriptInfo("00201863143c14c5166804bd19203356da136c985678cd4d27a1b8c6329604903262").address,
  "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
  "P2WSH bech32 vector",
);
assertEqual(
  decoders.scriptInfo("512079be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798").address,
  "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
  "P2TR bech32m vector",
);
assertEqual(decoders.scriptInfo("6a0b68656c6c6f20776f726c64").type, "op_return", "OP_RETURN script");
assertEqual(decoders.scriptInfo("").type, "empty", "empty script");
assertEqual(decoders.scriptInfo("deadbeef").type, "unknown", "unknown script");

assertError(() => decoders.decodeBitcoin("010"), "odd number of digits", "odd hex");
assertError(() => decoders.decodeBitcoin("01000000zz"), "invalid hex character", "non-hex input");
assertError(() => decoders.decodeBitcoin("01000000"), "truncated", "truncated transaction");
assertError(() => decoders.decodeBitcoin(BTC_LEGACY + "00"), "trailing byte", "trailing bytes");
assertError(() => decoders.decodeBitcoin("01000000000200000000"), "segwit flag", "unsupported segwit flag");
assertError(() => decoders.decodeBitcoin(""), "paste a raw bitcoin transaction", "empty transaction");

// ---------------------------------------------------------------- Ethereum

// EIP-155 example transaction (chain id 1, nonce 9, 1 ETH to 0x3535...).
const EVM_LEGACY =
  "f86c098504a817c800825208943535353535353535353535353535353535353535880de0b6b3a764000080" +
  "25a028ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276" +
  "a067cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83";

const evmLegacy = decoders.decodeEthereum("0x" + EVM_LEGACY);
assertEqual(evmLegacy.type, "legacy", "EVM legacy type");
assertEqual(evmLegacy.chainId, "1", "EVM legacy chain id from v");
assertEqual(evmLegacy.chainIdHex, "0x1", "EVM legacy chain id hex");
assertEqual(evmLegacy.nonce, "9", "EVM legacy nonce");
assertEqual(evmLegacy.gasPrice, "20000000000", "EVM legacy gas price");
assertEqual(evmLegacy.gasLimit, "21000", "EVM legacy gas limit");
assertEqual(evmLegacy.to, "0x3535353535353535353535353535353535353535", "EVM legacy to");
assertEqual(evmLegacy.contractCreation, false, "EVM legacy not a creation");
assertEqual(evmLegacy.valueWei, "1000000000000000000", "EVM legacy value wei");
assertEqual(evmLegacy.valueEth, "1", "EVM legacy value ETH");
assertEqual(evmLegacy.dataLength, 0, "EVM legacy data length");
assertEqual(evmLegacy.dataHex, "0x", "EVM legacy data");
assertEqual(evmLegacy.selector, null, "EVM legacy selector");
assertEqual(evmLegacy.accessList.length, 0, "EVM legacy access list");
assertEqual(evmLegacy.signature.v, "37", "EVM legacy v");
assertEqual(evmLegacy.signature.yParity, 0, "EVM legacy y parity");
assertEqual(
  evmLegacy.signature.r,
  "0x28ef61340bd939bc2195fe537567866003e1a15d3c71ff63e1590620aa636276",
  "EVM legacy r",
);
assertEqual(
  evmLegacy.signature.s,
  "0x67cbe9d8997f761aecb703304b3800ccf555c9f3dc64214b297fb1966a3b6d83",
  "EVM legacy s",
);
assert(typeof JSON.stringify(evmLegacy) === "string", "EVM legacy report is JSON-serialisable");

// EIP-1559 transfer pinned in crates/rotor-wasm/src/evm.rs (ethers 6.17.0).
const EVM_TYPE2 =
  "02f87483aa36a780843b9aca008477359400825208943535353535353535353535353535353535353535" +
  "87038d7ea4c6800080c080" +
  "a0d02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263" +
  "a012a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147";

const type2 = decoders.decodeEthereum(EVM_TYPE2);
assertEqual(type2.type, "eip1559", "EVM type 2 type");
assertEqual(type2.chainId, "11155111", "EVM type 2 chain id");
assertEqual(type2.nonce, "0", "EVM type 2 nonce");
assertEqual(type2.maxPriorityFeePerGas, "1000000000", "EVM type 2 priority fee");
assertEqual(type2.maxFeePerGas, "2000000000", "EVM type 2 max fee");
assertEqual(type2.gasPrice, null, "EVM type 2 has no gas price");
assertEqual(type2.gasLimit, "21000", "EVM type 2 gas limit");
assertEqual(type2.to, "0x3535353535353535353535353535353535353535", "EVM type 2 to");
assertEqual(type2.valueWei, "1000000000000000", "EVM type 2 value wei");
assertEqual(type2.valueEth, "0.001", "EVM type 2 value ETH");
assertEqual(type2.dataLength, 0, "EVM type 2 data length");
assertEqual(type2.accessList.length, 0, "EVM type 2 access list");
assertEqual(type2.signature.yParity, 0, "EVM type 2 y parity");
assertEqual(type2.signature.v, null, "EVM type 2 has no v");
assertEqual(
  type2.signature.r,
  "0xd02b933531d628f5d2251fbf58903a4d720f9bd6c7c51f7578f7cf301f761263",
  "EVM type 2 r",
);
assertEqual(
  type2.signature.s,
  "0x12a7d571860bb8d7e71bcb6c63d265bc6fc57b250b9381cbc18c1543c282b147",
  "EVM type 2 s",
);

// Contract creation from the same pinned ethers vectors.
const EVM_CREATION =
  "02f85f827a690380843b9aca00830186a080808a600160005260206000f3c001" +
  "a00e6f0062e21a326d11170fcffdc9ec1e1cf27c5562687a1a23657c27f364dcc5" +
  "a0756eca5f06fc7526fd8530fc749c089985c017e745329b20284ab5df0a663f56";
const creation = decoders.decodeEthereum(EVM_CREATION);
assertEqual(creation.chainId, "31337", "EVM creation chain id");
assertEqual(creation.contractCreation, true, "EVM creation flag");
assertEqual(creation.to, null, "EVM creation has no to");
assertEqual(creation.dataLength, 10, "EVM creation data length");
assertEqual(creation.selector, "0x60016000", "EVM creation selector");
assertEqual(creation.firstBytes, "0x600160005260206000f3", "EVM creation first bytes");
assertEqual(creation.signature.yParity, 1, "EVM creation y parity");

// EIP-2930 type 1 with a non-empty access list, built with canonical RLP.
const STORAGE_KEY = hexBytes("0x" + "00".repeat(31) + "01");
const ACCESS_ADDRESS = hexBytes("0x3535353535353535353535353535353535353535");
const TO_ADDRESS = hexBytes("0x3535353535353535353535353535353535353535");
const TYPE1_PAYLOAD = rlpList([
  rlpInt(1n),
  rlpInt(2n),
  rlpInt(3n),
  rlpInt(21000n),
  rlpBytes(TO_ADDRESS),
  rlpInt(7n),
  rlpBytes(hexBytes("deadbeef")),
  rlpList([rlpList([rlpBytes(ACCESS_ADDRESS), rlpList([rlpBytes(STORAGE_KEY)])])]),
  rlpInt(1n),
  rlpInt(1n),
  rlpInt(2n),
]);
const type1 = decoders.decodeEthereum(bytesHex(concatBytes([Uint8Array.of(1), TYPE1_PAYLOAD])));
assertEqual(type1.type, "access-list", "EVM type 1 type");
assertEqual(type1.chainId, "1", "EVM type 1 chain id");
assertEqual(type1.nonce, "2", "EVM type 1 nonce");
assertEqual(type1.gasPrice, "3", "EVM type 1 gas price");
assertEqual(type1.gasLimit, "21000", "EVM type 1 gas limit");
assertEqual(type1.to, "0x3535353535353535353535353535353535353535", "EVM type 1 to");
assertEqual(type1.valueWei, "7", "EVM type 1 value");
assertEqual(type1.valueEth, "0.000000000000000007", "EVM type 1 ETH value");
assertEqual(type1.dataLength, 4, "EVM type 1 data length");
assertEqual(type1.selector, "0xdeadbeef", "EVM type 1 selector");
assertEqual(type1.accessList.length, 1, "EVM type 1 access list length");
assertEqual(type1.accessList[0].address, "0x3535353535353535353535353535353535353535", "EVM type 1 access address");
assertEqual(type1.accessList[0].storageKeys.length, 1, "EVM type 1 storage key count");
assertEqual(
  type1.accessList[0].storageKeys[0],
  "0x" + "00".repeat(31) + "01",
  "EVM type 1 storage key",
);
assertEqual(type1.signature.yParity, 1, "EVM type 1 y parity");
assertEqual(type1.signature.r, "0x01", "EVM type 1 r");
assertEqual(type1.signature.s, "0x02", "EVM type 1 s");

assertError(() => decoders.decodeEthereum("0x123"), "odd number of digits", "EVM odd hex");
assertError(() => decoders.decodeEthereum("0xzz"), "invalid hex character", "EVM non-hex");
assertError(() => decoders.decodeEthereum("03c0"), "EIP-4844", "EVM type 3 is explicit");
assertError(() => decoders.decodeEthereum("04c0"), "unsupported eip-2718 transaction type", "EVM unknown type");
assertError(() => decoders.decodeEthereum("02c0"), "expected 12", "EVM type 2 field count");
assertError(() => decoders.decodeEthereum(EVM_TYPE2 + "00"), "trailing byte", "EVM trailing bytes");
assertError(() => decoders.decodeEthereum("01" + bytesHex(rlpList([rlpInt(1n)]))), "expected 11", "EVM type 1 field count");

// A non-canonical single-byte string and a leading-zero integer are rejected.
const nonCanonicalString = concatBytes([
  Uint8Array.of(1),
  rlpList([
    rlpInt(1n), rlpInt(2n), rlpInt(3n), rlpInt(21000n),
    Uint8Array.of(0x81, 0x01), // to: one byte encoded with the string prefix
    rlpInt(0n), rlpBytes(new Uint8Array(0)), rlpList([]), rlpInt(0n), rlpInt(1n), rlpInt(1n),
  ]),
]);
assertError(
  () => decoders.decodeEthereum(bytesHex(nonCanonicalString)),
  "not canonical",
  "EVM non-canonical RLP string",
);

const leadingZeroPayload = rlpList([
  Uint8Array.of(0x82, 0x00, 0x01), // nonce: 1 with a leading zero byte
  rlpInt(1n), rlpInt(21000n), rlpBytes(TO_ADDRESS), rlpInt(0n),
  rlpBytes(new Uint8Array(0)), rlpInt(27n), rlpInt(1n), rlpInt(1n),
]);
assertError(
  () => decoders.decodeEthereum(bytesHex(leadingZeroPayload)),
  "leading zero",
  "EVM non-canonical integer",
);

// Wrong address length and an out-of-range y parity are named precisely.
const shortTo = rlpList([
  rlpInt(1n), rlpInt(2n), rlpInt(3n), rlpInt(21000n),
  rlpBytes(hexBytes("0x" + "35".repeat(19))),
  rlpInt(0n), rlpBytes(new Uint8Array(0)), rlpList([]), rlpInt(0n), rlpInt(1n), rlpInt(1n),
]);
assertError(
  () => decoders.decodeEthereum(bytesHex(concatBytes([Uint8Array.of(1), shortTo]))),
  "20 bytes",
  "EVM to length",
);

const badY = rlpList([
  rlpInt(1n), rlpInt(2n), rlpInt(3n), rlpInt(4n), rlpInt(21000n),
  rlpBytes(TO_ADDRESS), rlpInt(0n), rlpBytes(new Uint8Array(0)), rlpList([]),
  rlpInt(2n), rlpInt(1n), rlpInt(1n),
]);
assertError(
  () => decoders.decodeEthereum(bytesHex(concatBytes([Uint8Array.of(2), badY]))),
  "y parity must be 0 or 1",
  "EVM y parity",
);

const shortKey = rlpList([
  rlpInt(1n), rlpInt(2n), rlpInt(3n), rlpInt(21000n), rlpBytes(TO_ADDRESS),
  rlpInt(0n), rlpBytes(new Uint8Array(0)),
  rlpList([rlpList([rlpBytes(ACCESS_ADDRESS), rlpList([rlpBytes(hexBytes("00".repeat(31)))])])]),
  rlpInt(0n), rlpInt(1n), rlpInt(1n),
]);
assertError(
  () => decoders.decodeEthereum(bytesHex(concatBytes([Uint8Array.of(1), shortKey]))),
  "storage key 0 must be 32 bytes",
  "EVM storage key length",
);

console.log(
  "tx decoders ok: BTC legacy (block 170) + SegWit (BIP143), P2PKH/P2WPKH/P2WSH/P2TR vectors, " +
    "EVM legacy (EIP-155) + type 2 (ethers) + type 1 access list, malformed hex/RLP",
);
