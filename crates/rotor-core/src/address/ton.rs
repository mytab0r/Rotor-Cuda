//! TON wallet-address derivation for every supported wallet contract version.
//!
//! A TON address is `workchain (1 byte) || StateInit hash (32 bytes)` with a
//! CRC16 suffix, rendered as base64url. The StateInit commits to a wallet
//! contract code cell and a data cell holding the ed25519 public key, so the
//! contract version is an explicit input, never an implicit default.
//!
//! Supported versions:
//!
//! - [`TonWalletVersion::V3R2`] — `wallet_v3r2` code cell, data
//!   `seqno:uint32, wallet_id:uint32, public_key:uint256` (320 bits).
//! - [`TonWalletVersion::V4R2`] — `wallet_v4r2` code cell, data
//!   `seqno:uint32, wallet_id:uint32, public_key:uint256, plugins:empty` (321
//!   bits). This is the desktop product's current TON output.
//! - [`TonWalletVersion::W5`] — `wallet_v5` code cell, data
//!   `is_signature_allowed:1, seqno:uint32, wallet_id:uint32,
//!   public_key:uint256, extensions:empty` (322 bits). This is the WASM/site
//!   product's current TON output.
//!
//! The v5 code cell is embedded as the BoC published in
//! `ton-blockchain/wallet-contract-v5` (commit
//! `4fab977f4fae3a37c1aac216ed2b7e611a9bc2af`,
//! `build/wallet_v5.compiled.json`); its representation hash and depth are
//! derived from those bytes. The v3R2 and v4R2 code hashes come from the
//! `WalletV3ContractR2` and `WalletV4ContractR2` cells bundled by tonweb in
//! `apps/site/ton.js`, cross-checked against `@ton/ton`.
//!
//! Adding a wallet version is a new [`TonWalletVersion`] variant and one code
//! cell; the entry point does not change.

use crate::hashes;

/// TON wallet contract version whose StateInit defines an address.
///
/// The enum is non-exhaustive so a new contract version can be added without
/// breaking a caller's match.
#[non_exhaustive]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TonWalletVersion {
    /// Wallet v3R2 (320-bit data cell, no plugins dictionary).
    V3R2,
    /// Wallet v4R2 (321-bit data cell with an empty plugins dictionary).
    V4R2,
    /// Wallet v5 / W5R1 (signature flag, 322-bit data cell, empty extensions).
    W5,
}

impl TonWalletVersion {
    /// Stable lowercase label for reports and error messages.
    pub const fn label(self) -> &'static str {
        match self {
            TonWalletVersion::V3R2 => "v3R2",
            TonWalletVersion::V4R2 => "v4R2",
            TonWalletVersion::W5 => "v5r1",
        }
    }
}

/// A derived TON address with the hashes that produced it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TonAddress {
    pub address: String,
    pub state_init_hash: [u8; 32],
    pub data_hash: [u8; 32],
    pub code_hash: [u8; 32],
    pub code_depth: u16,
}

/// Serialized BoC of the official wallet v5 code cell (657 bytes).
const W5_CODE_BOC_HEX: &str = "b5ee9c7241021401000281000114ff00f4a413f4bcf2c80b01020120020d020148030402dcd020d749c120915b8f6320d70b1f2082106578746ebd21821073696e74bdb0925f03e082106578746eba8eb48020d72101d074d721fa4030fa44f828fa443058bd915be0ed44d0810141d721f4058307f40e6fa1319130e18040d721707fdb3ce03120d749810280b99130e070e2100f020120050c020120060902016e07080019adce76a2684020eb90eb85ffc00019af1df6a2684010eb90eb858fc00201480a0b0017b325fb51341c75c875c2c7e00011b262fb513435c280200019be5f0f6a2684080a0eb90fa02c0102f20e011e20d70b1f82107369676ebaf2e08a7f0f01e68ef0eda2edfb218308d722028308d723208020d721d31fd31fd31fed44d0d200d31f20d31fd3ffd70a000af90140ccf9109a28945f0adb31e1f2c087df02b35007b0f2d0845125baf2e0855036baf2e086f823bbf2d0882292f800de01a47fc8ca00cb1f01cf16c9ed542092f80fde70db3cd81003f6eda2edfb02f404216e926c218e4c0221d73930709421c700b38e2d01d72820761e436c20d749c008f2e09320d74ac002f2e09320d71d06c712c2005230b0f2d089d74cd7393001a4e86c128407bbf2e093d74ac000f2e093ed55e2d20001c000915be0ebd72c08142091709601d72c081c12e25210b1e30f20d74a111213009601fa4001fa44f828fa443058baf2e091ed44d0810141d718f405049d7fc8ca0040048307f453f2e08b8e14038307f45bf2e08c22d70a00216e01b3b0f2d090e2c85003cf1612f400c9ed54007230d72c08248e2d21f2e092d200ed44d0d2005113baf2d08f54503091319c01810140d721d70a00f2e08ee2c8ca0058cf16c9ed5493f2c08de20010935bdb31e1d74cd0b4d6c35e";

/// Default W5 wallet id: mainnet network global id -239 XOR the v5r1 client
/// context (workchain 0, subwallet 0), exactly as `@ton/ton` serializes it.
const W5_WALLET_ID: u32 = 0x7fff_ff11;

/// `wallet_id` written into the v3R2/v4R2 data cell: `698983191 + workchain`.
const WALLET_ID: u32 = 698_983_191;

/// Representation hash of the `wallet_v3r2` code cell (tonweb
/// `WalletV3ContractR2`).
const V3R2_CODE_HASH: [u8; 32] = [
    0x84, 0xda, 0xfa, 0x44, 0x9f, 0x98, 0xa6, 0x98, 0x77, 0x89, 0xba, 0x23, 0x23, 0x58, 0x07, 0x2b,
    0xc0, 0xf7, 0x6d, 0xc4, 0x52, 0x40, 0x02, 0xa5, 0xd0, 0x91, 0x8b, 0x9a, 0x75, 0xd2, 0xd5, 0x99,
];

/// Max Merkle depth of the v3R2 code cell (one ordinary cell).
const V3R2_CODE_DEPTH: u16 = 0;

/// Representation hash of the `wallet_v4r2` code cell. Provenance: the
/// `WalletV4ContractR2` cell shipped by tonweb and bundled in `apps/site/ton.js`
/// (MIT, see `apps/site/ton.LICENSE.txt`); reproduced independently with
/// `@ton/ton` 16.3.0 (`WalletContractV4`). Note: `feb5ff68…` is v4R2, not v3R2
/// or v4R1.
const V4R2_CODE_HASH: [u8; 32] = [
    0xfe, 0xb5, 0xff, 0x68, 0x20, 0xe2, 0xff, 0x0d, 0x94, 0x83, 0xe7, 0xe0, 0xd6, 0x2c, 0x81, 0x7d,
    0x84, 0x67, 0x89, 0xfb, 0x4a, 0xe5, 0x80, 0xc8, 0x78, 0x86, 0x6d, 0x95, 0x9d, 0xab, 0xd5, 0xc0,
];

/// Max Merkle depth of the v4R2 code cell, serialized in the StateInit refs.
const V4R2_CODE_DEPTH: u16 = 7;

/// Derive the default mainnet address for `public_key` on `version`.
///
/// # Errors
///
/// The W5 code cell is parsed from its embedded BoC; a malformed embedded cell
/// is reported instead of producing a wrong address. The v3R2 and v4R2 code
/// cells are pinned constants and cannot fail.
pub fn ton_address(public_key: &[u8; 32], version: TonWalletVersion) -> Result<TonAddress, String> {
    let (code_hash, code_depth) = match version {
        TonWalletVersion::V3R2 => (V3R2_CODE_HASH, V3R2_CODE_DEPTH),
        TonWalletVersion::V4R2 => (V4R2_CODE_HASH, V4R2_CODE_DEPTH),
        TonWalletVersion::W5 => w5_code_cell()?,
    };

    let (data_bytes, data_bits) = data_cell(public_key, version);
    let (data_hash, data_depth) = ordinary_cell_hash(&data_bytes, data_bits, &[]);
    let state_init_hash = state_init_hash(code_hash, code_depth, data_hash, data_depth);

    Ok(TonAddress {
        address: friendly_address(&state_init_hash),
        state_init_hash,
        data_hash,
        code_hash,
        code_depth,
    })
}

/// Wallet v3R2 address for an ed25519 public key.
pub fn ton_v3r2_address(public_key: &[u8; 32]) -> String {
    ton_address(public_key, TonWalletVersion::V3R2)
        .expect("v3R2 uses a pinned code cell")
        .address
}

/// Wallet v4R2 address for an ed25519 public key.
pub fn ton_v4r2_address(public_key: &[u8; 32]) -> String {
    ton_address(public_key, TonWalletVersion::V4R2)
        .expect("v4R2 uses a pinned code cell")
        .address
}

/// Wallet v5 (W5) address for an ed25519 public key.
pub fn ton_w5_address(public_key: &[u8; 32]) -> Result<TonAddress, String> {
    ton_address(public_key, TonWalletVersion::W5)
}

/// Data cell bits and bytes for a wallet version.
fn data_cell(public_key: &[u8; 32], version: TonWalletVersion) -> (Vec<u8>, usize) {
    let mut data = BitBuilder::default();
    match version {
        TonWalletVersion::V3R2 => {
            data.push(0, 32); // seqno
            data.push(u64::from(WALLET_ID), 32);
            for byte in public_key {
                data.push(u64::from(*byte), 8);
            }
        }
        TonWalletVersion::V4R2 => {
            data.push(0, 32); // seqno
            data.push(u64::from(WALLET_ID), 32);
            for byte in public_key {
                data.push(u64::from(*byte), 8);
            }
            data.push(0, 1); // empty plugins dictionary
        }
        TonWalletVersion::W5 => {
            data.push(1, 1); // is_signature_allowed
            data.push(0, 32); // seqno
            data.push(u64::from(W5_WALLET_ID), 32);
            for byte in public_key {
                data.push(u64::from(*byte), 8);
            }
            data.push(0, 1); // empty extensions dictionary
        }
    }
    data.finish()
}

/// StateInit representation hash for a code and data cell pair.
fn state_init_hash(
    code_hash: [u8; 32],
    code_depth: u16,
    data_hash: [u8; 32],
    data_depth: u16,
) -> [u8; 32] {
    // No split depth, no special cell, code and data present, no libraries.
    let mut init = BitBuilder::default();
    for bit in [0, 0, 1, 1, 0] {
        init.push(bit, 1);
    }
    let (init_bytes, init_bits) = init.finish();
    ordinary_cell_hash(
        &init_bytes,
        init_bits,
        &[(code_hash, code_depth), (data_hash, data_depth)],
    )
    .0
}

/// User-friendly mainnet address: tag 0x11, workchain 0, hash, CRC16.
fn friendly_address(state_init_hash: &[u8; 32]) -> String {
    let mut payload = [0u8; 34];
    payload[0] = 0x11; // bounceable, non-testnet
    payload[2..].copy_from_slice(state_init_hash);
    base64url_ton(&payload)
}

/// Representation hash and depth of the embedded wallet v5 code cell.
fn w5_code_cell() -> Result<([u8; 32], u16), String> {
    let boc = decode_hex(W5_CODE_BOC_HEX)?;
    let (cells, roots) = parse_boc(&boc)?;
    let root = *roots
        .first()
        .ok_or_else(|| "wallet v5 code BoC has no root cell".to_owned())?;
    let mut memo = vec![None; cells.len()];
    cell_hash(&cells, root, &mut memo)
}

/// Representation hash and depth of an ordinary, level-zero cell.
fn ordinary_cell_hash(data: &[u8], bit_len: usize, refs: &[([u8; 32], u16)]) -> ([u8; 32], u16) {
    debug_assert_eq!(data.len(), bit_len.div_ceil(8));
    let mut repr = Vec::with_capacity(2 + data.len() + 34 * refs.len());
    repr.push(refs.len() as u8);
    repr.push(((bit_len / 8) * 2 + usize::from(!bit_len.is_multiple_of(8))) as u8);
    repr.extend_from_slice(data);
    for (_, depth) in refs {
        repr.push((depth >> 8) as u8);
        repr.push(*depth as u8);
    }
    for (hash, _) in refs {
        repr.extend_from_slice(hash);
    }
    let depth = refs
        .iter()
        .map(|(_, depth)| *depth)
        .max()
        .map_or(0, |d| d + 1);
    (hashes::sha256(&repr), depth)
}

/// One cell parsed from a BoC, kept in its serialized form.
struct ParsedCell {
    refs_descriptor: u8,
    bits_descriptor: u8,
    data: Vec<u8>,
    refs: Vec<usize>,
    exotic: bool,
    level: u8,
}

/// Representation hash and depth of a cell tree parsed from a BoC.
fn cell_hash(
    cells: &[ParsedCell],
    index: usize,
    memo: &mut [Option<([u8; 32], u16)>],
) -> Result<([u8; 32], u16), String> {
    if let Some(value) = memo[index] {
        return Ok(value);
    }
    let cell = &cells[index];
    if cell.exotic || cell.level != 0 {
        return Err(format!("wallet v5 code cell {index} is exotic or levelled"));
    }
    let mut refs = Vec::with_capacity(cell.refs.len());
    for &child in &cell.refs {
        refs.push(cell_hash(cells, child, memo)?);
    }
    let mut repr = Vec::with_capacity(2 + cell.data.len() + 34 * refs.len());
    repr.push(cell.refs_descriptor);
    repr.push(cell.bits_descriptor);
    repr.extend_from_slice(&cell.data);
    for (_, depth) in &refs {
        repr.push((depth >> 8) as u8);
        repr.push(*depth as u8);
    }
    for (hash, _) in &refs {
        repr.extend_from_slice(hash);
    }
    let depth = refs
        .iter()
        .map(|(_, depth)| *depth)
        .max()
        .map_or(0, |d| d + 1);
    let value = (hashes::sha256(&repr), depth);
    memo[index] = Some(value);
    Ok(value)
}

/// Parse a bag of cells: header, root indices and every cell descriptor.
fn parse_boc(bytes: &[u8]) -> Result<(Vec<ParsedCell>, Vec<usize>), String> {
    if bytes.len() < 6 || &bytes[..4] != b"\xb5\xee\x9c\x72" {
        return Err("wallet v5 code is not a bag of cells".to_owned());
    }
    let flags = bytes[4];
    let has_index = flags & 0x80 != 0;
    let size_bytes = usize::from(flags & 0x07);
    let offset_bytes = usize::from(bytes[5]);
    let mut position = 6;
    let cells_count = read_be(bytes, &mut position, size_bytes)?;
    let roots_count = read_be(bytes, &mut position, size_bytes)?;
    let _absent = read_be(bytes, &mut position, size_bytes)?;
    let _total = read_be(bytes, &mut position, offset_bytes)?;
    let mut roots = Vec::with_capacity(roots_count);
    for _ in 0..roots_count {
        roots.push(read_be(bytes, &mut position, size_bytes)?);
    }
    if has_index {
        position = position
            .checked_add(cells_count * offset_bytes)
            .ok_or_else(|| "wallet v5 code BoC index overflows".to_owned())?;
    }
    if position > bytes.len() || roots.iter().any(|&root| root >= cells_count) {
        return Err("wallet v5 code BoC header is truncated".to_owned());
    }

    let mut cells = Vec::with_capacity(cells_count);
    for _ in 0..cells_count {
        let refs_descriptor = *bytes
            .get(position)
            .ok_or_else(|| "wallet v5 code BoC is truncated".to_owned())?;
        let bits_descriptor = *bytes
            .get(position + 1)
            .ok_or_else(|| "wallet v5 code BoC is truncated".to_owned())?;
        position += 2;
        let refs_count = usize::from(refs_descriptor & 0x07);
        let data_len = usize::from(bits_descriptor >> 1) + usize::from(bits_descriptor & 1);
        let data = bytes
            .get(position..position + data_len)
            .ok_or_else(|| "wallet v5 code BoC cell data is truncated".to_owned())?
            .to_vec();
        position += data_len;
        let mut refs = Vec::with_capacity(refs_count);
        for _ in 0..refs_count {
            refs.push(read_be(bytes, &mut position, size_bytes)?);
            if refs.last().copied().unwrap_or(0) >= cells_count {
                return Err("wallet v5 code BoC ref is out of range".to_owned());
            }
        }
        cells.push(ParsedCell {
            refs_descriptor,
            bits_descriptor,
            data,
            refs,
            exotic: refs_descriptor & 0x08 != 0,
            level: refs_descriptor >> 5,
        });
    }
    Ok((cells, roots))
}

fn read_be(bytes: &[u8], position: &mut usize, size: usize) -> Result<usize, String> {
    let slice = bytes
        .get(*position..*position + size)
        .ok_or_else(|| "wallet v5 code BoC is truncated".to_owned())?;
    *position += size;
    let mut value = 0usize;
    for byte in slice {
        value = (value << 8) | usize::from(*byte);
    }
    Ok(value)
}

/// MSB-first bit builder. [`finish`](Self::finish) appends the TON completion
/// tag (`1` then zeros) when the length is not byte-aligned.
#[derive(Default)]
struct BitBuilder {
    bytes: Vec<u8>,
    len: usize,
}

impl BitBuilder {
    fn push(&mut self, value: u64, count: usize) {
        for shift in (0..count).rev() {
            if self.len.is_multiple_of(8) {
                self.bytes.push(0);
            }
            let bit = ((value >> shift) & 1) as u8;
            *self.bytes.last_mut().expect("byte exists") |= bit << (7 - self.len % 8);
            self.len += 1;
        }
    }

    fn finish(mut self) -> (Vec<u8>, usize) {
        let remainder = self.len % 8;
        if remainder != 0 {
            *self.bytes.last_mut().expect("partial byte exists") |= 1 << (7 - remainder);
        }
        (self.bytes, self.len)
    }
}

fn crc16(data: &[u8]) -> [u8; 2] {
    let mut register = 0u32;
    for byte in data.iter().chain(&[0u8, 0u8]) {
        let mut mask = 0x80u8;
        while mask > 0 {
            register <<= 1;
            if *byte & mask != 0 {
                register += 1;
            }
            mask >>= 1;
            if register > 0xffff {
                register &= 0xffff;
                register ^= 0x1021;
            }
        }
    }
    [(register / 256) as u8, (register % 256) as u8]
}

fn base64url_ton(payload: &[u8]) -> String {
    let checksum = crc16(payload);
    let mut data = Vec::with_capacity(payload.len() + 2);
    data.extend_from_slice(payload);
    data.extend_from_slice(&checksum);
    base64url(&data)
}

fn base64url(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let a = u32::from(chunk[0]);
        let b = u32::from(chunk.get(1).copied().unwrap_or(0));
        let c = u32::from(chunk.get(2).copied().unwrap_or(0));
        let value = (a << 16) | (b << 8) | c;
        out.push(char::from(ALPHABET[(value >> 18) as usize]));
        out.push(char::from(ALPHABET[((value >> 12) & 63) as usize]));
        if chunk.len() > 1 {
            out.push(char::from(ALPHABET[((value >> 6) & 63) as usize]));
        }
        if chunk.len() > 2 {
            out.push(char::from(ALPHABET[(value & 63) as usize]));
        }
    }
    out
}

fn decode_hex(text: &str) -> Result<Vec<u8>, String> {
    let bytes = text.as_bytes();
    if !bytes.len().is_multiple_of(2) {
        return Err("wallet code has an odd hex length".to_owned());
    }
    let mut out = Vec::with_capacity(bytes.len() / 2);
    for pair in bytes.chunks(2) {
        let high = nibble(pair[0]).ok_or_else(|| "wallet code is not hex".to_owned())?;
        let low = nibble(pair[1]).ok_or_else(|| "wallet code is not hex".to_owned())?;
        out.push((high << 4) | low);
    }
    Ok(out)
}

fn nibble(byte: u8) -> Option<u8> {
    match byte {
        b'0'..=b'9' => Some(byte - b'0'),
        b'a'..=b'f' => Some(byte - b'a' + 10),
        b'A'..=b'F' => Some(byte - b'A' + 10),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serialized BoC of tonweb's `WalletV3ContractR2` code cell.
    const V3R2_CODE_BOC_HEX: &str = "B5EE9C724101010100710000DEFF0020DD2082014C97BA218201339CBAB19F71B0ED44D0D31FD31F31D70BFFE304E0A4F2608308D71820D31FD31FD31FF82313BBF263ED44D0D31FD31FD3FFD15132BAF2A15144BAF2A204F901541055F910F2A3F8009320D74A96D307D402FB00E8D101A4C8CB1FCB1FCBFFC9ED5410BD6DAD";

    fn public_key(hex: &str) -> [u8; 32] {
        decode_hex(hex).unwrap().try_into().unwrap()
    }

    fn hex(bytes: &[u8]) -> String {
        let mut out = String::with_capacity(bytes.len() * 2);
        for byte in bytes {
            out.push_str(&format!("{byte:02x}"));
        }
        out
    }

    fn code_cell(boc_hex: &str) -> ([u8; 32], u16) {
        let boc = decode_hex(boc_hex).unwrap();
        let (cells, roots) = parse_boc(&boc).unwrap();
        let mut memo = vec![None; cells.len()];
        cell_hash(&cells, roots[0], &mut memo).unwrap()
    }

    /// The embedded v5 BoC must be the published wallet v5 code cell.
    #[test]
    fn embedded_w5_code_cell_matches_official_hash_and_depth() {
        let (hash, depth) = code_cell(W5_CODE_BOC_HEX);
        assert_eq!(
            hex(&hash),
            "20834b7b72b112147e1b2fb457b84e74d1a30f04f737d4f62a668e9552d2b72f"
        );
        assert_eq!(depth, 6);
    }

    /// The pinned v3R2 hash and depth must match tonweb's code cell.
    #[test]
    fn v3r2_code_cell_matches_tonweb_bundle() {
        let (hash, depth) = code_cell(V3R2_CODE_BOC_HEX);
        assert_eq!(hash, V3R2_CODE_HASH);
        assert_eq!(depth, V3R2_CODE_DEPTH);
    }

    /// Tonkeeper's official sign snapshots
    /// (`tonkeeper/tonkeeper-web`,
    /// `packages/core/src/__tests__/snapshots/sign/*__V5R1__MAINNET.json`)
    /// pin these public key -> default mainnet W5 address pairs.
    #[test]
    fn w5_matches_official_tonkeeper_vectors() {
        for (key, expected) in [
            (
                "eda1888c122359f57027b8f7172fc2561ab13d596b64ad1c963acfaaba5c1ae7",
                "EQBpx5YKLspJ8tiBnrLAkIH2u5R1IdDtoCXhvDqbanjIpvuQ",
            ),
            (
                "7952e94118f34607c75e23258dd9220d66ccac5a3ee074125c25068e8107bfbf",
                "EQBHyu-oZVDHRYQ1-rKlGqpHy5yAqanPBirEQNMNOmfHLotW",
            ),
            (
                "207a067892821e25d770f1fba0c47c11ff4b813e54162ece9eb839e076231ab6",
                "EQCVNn1xdEuZ72J56_JGilZn8xyzObj0tE9aU-NaWzJDpTAs",
            ),
            (
                "aaaaaaaabbbbbbbbccccccccddddddddeeeeeeeeffffffff0000000011111111",
                "EQBmk7Vk5CPOZeWo-mBejI6h7AczhuMc2H3iEPMyHUTwE6ft",
            ),
            (
                "8c34aba42e4d9df88597b49f66140e6a26b430f323311c22881795cd42245df8",
                "EQBL2XqWErpY695_7VfwYHnKcy7DR6xjEjGySPWUPkYwqny_",
            ),
        ] {
            assert_eq!(
                ton_w5_address(&public_key(key)).unwrap().address,
                expected,
                "{key}"
            );
        }
    }

    /// The bundled tonweb `WalletV3ContractR2` / `WalletV4ContractR2` classes
    /// produce these addresses for the same public keys (an independent
    /// implementation, not this code).
    #[test]
    fn v3r2_and_v4r2_match_tonweb_vectors() {
        for (key, v3r2, v4r2) in [
            (
                "D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A",
                "EQB3V1d93mD6v4qWoRPnlm0UrYpcHZz2lCD_10u84NHWuX1P",
                "EQDNrJfJFisuFBrURjgosqcO_fh2K5foNWPzUr7PkC6Ipopv",
            ),
            (
                "4CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA29",
                "EQCmIF9iG5IVwOWUPmPELRcJ09QTolmd6ETbwpbqhokjHG2U",
                "EQAkxuybaeBflbgYW3vgQvcFgyAQVcLtXZwdrpeLNqzZ000c",
            ),
        ] {
            let public = public_key(key);
            assert_eq!(ton_v3r2_address(&public), v3r2, "v3R2 {key}");
            assert_eq!(ton_v4r2_address(&public), v4r2, "v4R2 {key}");
        }
    }

    /// The versioned entry point is the one implementation for every version.
    #[test]
    fn versioned_entry_point_matches_specific_wrappers() {
        let public = public_key("eda1888c122359f57027b8f7172fc2561ab13d596b64ad1c963acfaaba5c1ae7");
        assert_eq!(
            ton_address(&public, TonWalletVersion::V3R2)
                .unwrap()
                .address,
            ton_v3r2_address(&public)
        );
        assert_eq!(
            ton_address(&public, TonWalletVersion::V4R2)
                .unwrap()
                .address,
            ton_v4r2_address(&public)
        );
        assert_eq!(
            ton_address(&public, TonWalletVersion::W5).unwrap(),
            ton_w5_address(&public).unwrap()
        );
    }

    /// Intermediate hashes for the first official W5 vector, cross-checked
    /// with `@ton/ton` 15.3.1 (`WalletContractV5R1`).
    #[test]
    fn w5_intermediate_hashes_match_ton_ton() {
        let address = ton_w5_address(&public_key(
            "eda1888c122359f57027b8f7172fc2561ab13d596b64ad1c963acfaaba5c1ae7",
        ))
        .unwrap();
        assert_eq!(
            hex(&address.data_hash),
            "091a899a39c1bf54340bb28648761b3b5007a46e36c15d070b61dd4edbf7d90d"
        );
        assert_eq!(
            hex(&address.state_init_hash),
            "69c7960a2eca49f2d8819eb2c09081f6bb947521d0eda025e1bc3a9b6a78c8a6"
        );
        assert_eq!(address.data_hash.len(), 32);
    }
}
