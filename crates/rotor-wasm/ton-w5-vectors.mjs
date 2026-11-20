// Independent check of the TON wallet v5 (W5) address computation.
//
// Pure Node.js stdlib: it does not import the wasm core or any npm package.
// It recomputes the address from each public key using TON cell representation
// hashing and asserts the official vector. Run:
//
//   node crates/rotor-wasm/ton-w5-vectors.mjs
//
// Vectors: tonkeeper/tonkeeper-web, packages/core/src/__tests__/snapshots/sign/
//   mnemonic-ton__V5R1__MAINNET.json
//   mnemonic-bip39__V5R1__MAINNET.json
//   sk__V5R1__MAINNET.json
//   ton-only__V5R1__MAINNET.json
//   mam__V5R1__MAINNET.json
// Code cell: ton-blockchain/wallet-contract-v5,
// commit 4fab977f4fae3a37c1aac216ed2b7e611a9bc2af,
// build/wallet_v5.compiled.json.
import { createHash } from "node:crypto";

const CODE_BOC = Buffer.from(
  "b5ee9c7241021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0b4d6c35e",
  "hex",
);

const WALLET_ID = 0x7fffff11; // mainnet -239 XOR v5r1 client context (0:0:0)

function sha256(data) {
  return createHash("sha256").update(data).digest();
}

function parseBoc(bytes) {
  const flags = bytes[4];
  const sizeBytes = flags & 0x07;
  const offsetBytes = bytes[5];
  let p = 6;
  const read = (n) => {
    let value = 0;
    for (let i = 0; i < n; i += 1) value = value * 256 + bytes[p++];
    return value;
  };
  const count = read(sizeBytes);
  const rootCount = read(sizeBytes);
  read(sizeBytes);
  read(offsetBytes);
  const roots = Array.from({ length: rootCount }, () => read(sizeBytes));
  if (flags & 0x80) p += count * offsetBytes;
  const cells = [];
  for (let i = 0; i < count; i += 1) {
    const d1 = bytes[p++];
    const d2 = bytes[p++];
    const dataLength = (d2 >> 1) + (d2 & 1);
    const data = bytes.subarray(p, p + dataLength);
    p += dataLength;
    const refs = Array.from({ length: d1 & 0x07 }, () => read(sizeBytes));
    cells.push({ d1, d2, data, refs });
  }
  return { cells, roots };
}

function cellHash(cells, index, memo = new Map()) {
  if (memo.has(index)) return memo.get(index);
  const cell = cells[index];
  const refs = cell.refs.map((ref) => cellHash(cells, ref, memo));
  const parts = [Buffer.from([cell.d1, cell.d2]), Buffer.from(cell.data)];
  for (const { depth } of refs) parts.push(Buffer.from([depth >> 8, depth & 0xff]));
  for (const { hash } of refs) parts.push(hash);
  const depth = refs.length ? 1 + Math.max(...refs.map((ref) => ref.depth)) : 0;
  const hash = sha256(Buffer.concat(parts));
  const value = { hash, depth };
  memo.set(index, value);
  return value;
}

function bitsToCell(bits) {
  const padded = bits.slice();
  padded.push(1);
  while (padded.length % 8) padded.push(0);
  const bytes = Buffer.alloc(padded.length / 8);
  padded.forEach((bit, index) => {
    if (bit) bytes[index >> 3] |= 1 << (7 - (index & 7));
  });
  return { bytes, bitLength: bits.length };
}

function cellHashWithRefs(bits, refs) {
  const { bytes, bitLength } = bitsToCell(bits);
  const d2 = (bitLength >> 3) * 2 + (bitLength % 8 ? 1 : 0);
  const parts = [Buffer.from([refs.length, d2]), bytes];
  for (const { depth } of refs) parts.push(Buffer.from([depth >> 8, depth & 0xff]));
  for (const { hash } of refs) parts.push(hash);
  return sha256(Buffer.concat(parts));
}

function crc16(data) {
  let reg = 0;
  for (const byte of Buffer.concat([data, Buffer.alloc(2)])) {
    for (let mask = 0x80; mask > 0; mask >>= 1) {
      reg = (reg << 1) + ((byte & mask) !== 0 ? 1 : 0);
      if (reg > 0xffff) reg = (reg & 0xffff) ^ 0x1021;
    }
  }
  return Buffer.from([Math.floor(reg / 256), reg % 256]);
}

export function w5Address(publicKey) {
  const { cells, roots } = parseBoc(CODE_BOC);
  const { hash: codeHash, depth: codeDepth } = cellHash(cells, roots[0]);

  const bits = [1];
  for (let i = 0; i < 32; i += 1) bits.push(0); // seqno
  for (let i = 31; i >= 0; i -= 1) bits.push((WALLET_ID >>> i) & 1);
  for (const byte of publicKey) {
    for (let i = 7; i >= 0; i -= 1) bits.push((byte >> i) & 1);
  }
  bits.push(0);
  const dataHash = cellHashWithRefs(bits, []);

  const initHash = cellHashWithRefs([0, 0, 1, 1, 0], [
    { hash: codeHash, depth: codeDepth },
    { hash: dataHash, depth: 0 },
  ]);
  const raw = Buffer.concat([Buffer.from([0x11, 0x00]), initHash]);
  return Buffer.concat([raw, crc16(raw)])
    .toString("base64url")
    .replace(/=+$/, "");
}

const vectors = [
  [
    "eda1888c122359f57027b8f7172fc2561ab13d596b64ad1c963acfaaba5c1ae7",
    "EQBpx5YKLspJ8tiBnrLAkIH2u5R1IdDtoCXhvDqbanjIpvuQ",
  ],
  [
    "7952e94118f34607c75e23258dd9220d66ccac5a3ee074125c25068e8107bfbf",
    "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW",
  ],
  [
    "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6",
    "EQCVNn1xdEuZ72J56_JGilZn8xyzObj0tE9aU-NaWzJDpTAs",
  ],
  [
    "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111",
    "EQBmk7Vk5CPOZeWo-mBejI6h7AczhuMc2H3iEPMyHUTwE6ft",
  ],
  [
    "8c34aba42e4d9df88597b49f66140e6a26b430f323311c22881795cd42245df8",
    "EQBL2XqWErpY695_7VfwYHnKcy7DR6xjEjGySPWUPkYwqny_",
  ],
];

for (const [key, expected] of vectors) {
  const actual = w5Address(Buffer.from(key, "hex"));
  if (actual !== expected) {
    throw new Error(`${key}: got ${actual}, expected ${expected}`);
  }
  console.log(`${key.slice(0, 8)} ${actual} ok`);
}
