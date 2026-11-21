//! Address encoders shared by the chain descriptor, the engines and tests.
//!
//! Every chain family derives one canonical address from a key:
//!
//! - [`Family::SecpHash160`](crate::chain::Family::SecpHash160): Public key →
//!   SHA-256 → RIPEMD-160, displayed as Base58Check or Ripple Base58.
//! - [`Family::EvmKeccak`](crate::chain::Family::EvmKeccak): Public key →
//!   keccak256 → last 20 bytes, displayed as EIP-55 hex.
//! - [`Family::TronKeccak`](crate::chain::Family::TronKeccak): the same keccak
//!   account, displayed with the 0x41 prefix and Base58Check.
//! - [`Family::Ed25519`](crate::chain::Family::Ed25519): 32-byte seed →
//!   ed25519 public key; Solana keeps the key, Sui hashes it with BLAKE2b-256.
//! - [`Family::Ton`](crate::chain::Family::Ton): ed25519 key → wallet v4R2
//!   StateInit hash → user-friendly base64url with CRC16.
//!
//! Fixtures for these encoders live in `tests/chain.rs`; they are copied from
//! the site's WASM `derive_report` output and never embedded in production.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
use ed25519_dalek::SigningKey;

use crate::base58;
use crate::chain::{AddressEncoding, ChainDescriptor, Family};
use crate::hashes;
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

/// Key material accepted by [`derive`].
pub enum KeyMaterial<'a> {
    /// A secp256k1 private key with its point and the target compression.
    Secp {
        key: &'a Scalar,
        point: &'a Affine,
        compressed: bool,
    },
    /// A 32-byte ed25519 seed.
    Seed(&'a [u8; 32]),
}

/// Result of a family derivation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DerivedAddress {
    /// Canonical address for the chain.
    pub address: String,
    /// WIF secret when the chain defines one.
    pub secret: Option<String>,
    /// Uppercase public key as displayed by the desktop key report.
    pub public_hex: String,
}

/// Derive `descriptor`'s address from key material.
///
/// # Errors
///
/// Returns an error when the material does not match the chain's curve or a
/// family/encoding pair is unsupported.
pub fn derive(
    descriptor: &ChainDescriptor,
    material: KeyMaterial<'_>,
) -> Result<DerivedAddress, String> {
    match descriptor.family {
        Family::SecpHash160 => derive_secp_hash160(descriptor, material),
        Family::EvmKeccak | Family::TronKeccak => derive_keccak(descriptor, material),
        Family::Ed25519 => derive_ed25519(descriptor, material),
        Family::Ton => derive_ton(descriptor, material),
    }
}

fn derive_secp_hash160(
    descriptor: &ChainDescriptor,
    material: KeyMaterial<'_>,
) -> Result<DerivedAddress, String> {
    let KeyMaterial::Secp {
        key,
        point,
        compressed,
    } = material
    else {
        return Err(format!("{} needs a secp256k1 key", descriptor.name));
    };
    let hash = secp::hash160(point, compressed);
    let address = match descriptor.encoding {
        AddressEncoding::Base58Check(version) => base58check(version, &hash),
        AddressEncoding::RippleBase58 => ripple_base58(&hash),
        other => {
            return Err(format!(
                "{} does not support {other:?} in the secp-hash160 family",
                descriptor.name
            ));
        }
    };
    let secret = descriptor
        .wif_version
        .map(|version| base58::wif_encode_with_version(key, compressed, version));
    let public_hex = if compressed {
        hex_upper(&secp::compress(point))
    } else {
        hex_upper(&secp::uncompress(point))
    };
    Ok(DerivedAddress {
        address,
        secret,
        public_hex,
    })
}

fn derive_keccak(
    descriptor: &ChainDescriptor,
    material: KeyMaterial<'_>,
) -> Result<DerivedAddress, String> {
    let KeyMaterial::Secp { point, .. } = material else {
        return Err(format!("{} needs a secp256k1 key", descriptor.name));
    };
    let account = secp::eth_address(point);
    let address = match descriptor.family {
        Family::EvmKeccak => evm_hex(&account),
        Family::TronKeccak => tron_base58(&account),
        _ => {
            return Err(format!("{} is not a keccak chain", descriptor.name));
        }
    };
    let uncompressed = secp::uncompress(point);
    Ok(DerivedAddress {
        address,
        secret: None,
        public_hex: hex_upper(&uncompressed[1..]),
    })
}

fn derive_ed25519(
    descriptor: &ChainDescriptor,
    material: KeyMaterial<'_>,
) -> Result<DerivedAddress, String> {
    let KeyMaterial::Seed(seed) = material else {
        return Err(format!("{} needs a 32-byte ed25519 seed", descriptor.name));
    };
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    let address = match descriptor.encoding {
        AddressEncoding::SolanaBase58 => solana_base58(&public),
        AddressEncoding::SuiHex => sui_hex(&public),
        other => {
            return Err(format!(
                "{} does not support {other:?} in the ed25519 family",
                descriptor.name
            ));
        }
    };
    Ok(DerivedAddress {
        address,
        secret: None,
        public_hex: hex_upper(&public),
    })
}

fn derive_ton(
    descriptor: &ChainDescriptor,
    material: KeyMaterial<'_>,
) -> Result<DerivedAddress, String> {
    let KeyMaterial::Seed(seed) = material else {
        return Err(format!("{} needs a 32-byte ed25519 seed", descriptor.name));
    };
    if descriptor.encoding != AddressEncoding::TonUserFriendly {
        return Err(format!(
            "{} does not support {:?} in the TON family",
            descriptor.name, descriptor.encoding
        ));
    }
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    Ok(DerivedAddress {
        address: ton_v4r2_address(&public),
        secret: None,
        public_hex: hex_upper(&public),
    })
}

/// Base58Check with the chain's version prefix.
pub fn base58check(version: &[u8], payload: &[u8]) -> String {
    let mut data = Vec::with_capacity(version.len() + payload.len());
    data.extend_from_slice(version);
    data.extend_from_slice(payload);
    base58::encode_check(&data)
}

/// Ripple's classic address form: a 0x00 prefix byte and Base58 alphabet with
/// a double-SHA256 checksum.
pub fn ripple_base58(hash: &[u8; 20]) -> String {
    let mut payload = [0u8; 21];
    payload[1..].copy_from_slice(hash);
    let checksum = hashes::sha256d(&payload);
    let mut data = [0u8; 25];
    data[..21].copy_from_slice(&payload);
    data[21..].copy_from_slice(&checksum[..4]);
    base58::encode_ripple(&data)
}

/// EIP-55 mixed-case `0x` hex form of a 20-byte EVM account.
pub fn evm_hex(address: &[u8; 20]) -> String {
    let lower = hex_lower(address);
    let digest = hashes::keccak256(lower.as_bytes());
    let mut out = String::with_capacity(42);
    out.push_str("0x");
    for (index, character) in lower.bytes().enumerate() {
        let nibble = if index % 2 == 0 {
            digest[index / 2] >> 4
        } else {
            digest[index / 2] & 0x0f
        };
        if character.is_ascii_alphabetic() && nibble >= 8 {
            out.push(char::from(character.to_ascii_uppercase()));
        } else {
            out.push(char::from(character));
        }
    }
    out
}

/// TRON's Base58Check form: the 0x41 prefix plus the keccak account.
pub fn tron_base58(address: &[u8; 20]) -> String {
    let mut payload = [0u8; 21];
    payload[0] = 0x41;
    payload[1..].copy_from_slice(address);
    base58::encode_check(&payload)
}

/// Solana keeps the raw 32-byte ed25519 public key as Base58.
pub fn solana_base58(public: &[u8; 32]) -> String {
    bs58::encode(public).into_string()
}

/// Sui's account is `0x` + BLAKE2b-256(0x00 || ed25519 public key).
pub fn sui_hex(public: &[u8; 32]) -> String {
    let mut input = [0u8; 33];
    input[1..].copy_from_slice(public);
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(input);
    format!("0x{}", hex_lower(&hasher.finalize()))
}

/// Representation hash of the standard wallet v4R2 code cell.
///
/// Provenance: this is the `WalletV4ContractR2` code cell shipped by tonweb and
/// bundled in `apps/site/ton.js` (MIT, see `apps/site/ton.LICENSE.txt`); the
/// hash and depth were reproduced independently with `@ton/ton` 16.3.0
/// (`WalletContractV4`). The StateInit cell commits to the code cell's hash and
/// depth, so pinning both is equivalent to pinning the code cell for address
/// derivation. Note: `feb5ff68…` is v4R2, not v3R2 or v4R1 — their code hash
/// and depth differ, and substituting one would break the known-vector test.
const TON_V4R2_CODE_HASH: [u8; 32] = [
    0xfe, 0xb5, 0xff, 0x68, 0x20, 0xe2, 0xff, 0x0d, 0x94, 0x83, 0xe7, 0xe0, 0xd6, 0x2c, 0x81, 0x7d,
    0x84, 0x67, 0x89, 0xfb, 0x4a, 0xe5, 0x80, 0xc8, 0x78, 0x86, 0x6d, 0x95, 0x9d, 0xab, 0xd5, 0xc0,
];

/// Max Merkle depth of the v4R2 code cell, serialized in the StateInit refs.
const TON_V4R2_CODE_DEPTH: u16 = 7;

/// `wallet_id` written into the v4R2 data cell: `698983191 + workchain`.
const TON_V4R2_SUBWALLET_ID: u32 = 698_983_191;

/// User-friendly TON address of the v4R2 wallet whose StateInit holds `public`.
///
/// Matches `apps/site`'s tonweb output: bounceable, non-testnet, workchain 0,
/// base64url (`Address.toString(true, true, true)`).
pub fn ton_v4r2_address(public: &[u8; 32]) -> String {
    // Data cell: seqno = 0, wallet_id, public key, empty plugins dict (1 bit).
    // That is 321 bits; TON top-ups to 41 bytes with a `1` bit followed by
    // zeros, which is the 0x40 last byte (bit 320 is the empty plugins dict).
    let mut data = [0u8; 41];
    data[4..8].copy_from_slice(&TON_V4R2_SUBWALLET_ID.to_be_bytes());
    data[8..40].copy_from_slice(public);
    data[40] = 0x40;

    // Cell representation: refs descriptor, bits descriptor, top-upped data.
    let mut data_repr = [0u8; 43];
    data_repr[0] = 0x00; // no refs, ordinary cell, level 0
    data_repr[1] = 0x51; // ceil(321 / 8) + floor(321 / 8) = 41 + 40
    data_repr[2..].copy_from_slice(&data);
    let data_hash = hashes::sha256(&data_repr);

    // StateInit cell: bits `0 0 1 1 0` (no split depth, no ticktock, code and
    // data present), top-upped to 0x34, with code then data as two refs.
    let mut state_init = [0u8; 7 + 32 + 32];
    state_init[..3].copy_from_slice(&[0x02, 0x01, 0x34]);
    state_init[3..5].copy_from_slice(&TON_V4R2_CODE_DEPTH.to_be_bytes());
    // state_init[5..7] stay zero: the data cell has no refs, so its depth is 0.
    state_init[7..39].copy_from_slice(&TON_V4R2_CODE_HASH);
    state_init[39..].copy_from_slice(&data_hash);
    let address_hash = hashes::sha256(&state_init);

    let mut payload = [0u8; 34];
    payload[0] = 0x11; // bounceable, non-testnet
    payload[1] = 0x00; // workchain 0
    payload[2..].copy_from_slice(&address_hash);
    base64url_ton(&payload)
}

/// Append the CRC16-XMODEM checksum (big-endian) and base64url-encode.
fn base64url_ton(payload: &[u8]) -> String {
    let checksum = crc16_xmodem(payload);
    let mut data = Vec::with_capacity(payload.len() + 2);
    data.extend_from_slice(payload);
    data.extend_from_slice(&checksum.to_be_bytes());
    base64url_encode(&data)
}

/// CRC16-XMODEM (polynomial 0x1021, initial value 0, no reflection).
fn crc16_xmodem(data: &[u8]) -> u16 {
    let mut crc = 0u16;
    for &byte in data {
        crc ^= u16::from(byte) << 8;
        for _ in 0..8 {
            crc = if crc & 0x8000 != 0 {
                (crc << 1) ^ 0x1021
            } else {
                crc << 1
            };
        }
    }
    crc
}

/// Unpadded base64url encoding, as used by TON user-friendly addresses.
fn base64url_encode(data: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let first = u32::from(chunk[0]);
        let second = chunk.get(1).copied().map(u32::from);
        let third = chunk.get(2).copied().map(u32::from);
        let triple = (first << 16) | (second.unwrap_or(0) << 8) | third.unwrap_or(0);
        out.push(char::from(ALPHABET[(triple >> 18) as usize & 0x3f]));
        out.push(char::from(ALPHABET[(triple >> 12) as usize & 0x3f]));
        if second.is_some() {
            out.push(char::from(ALPHABET[(triple >> 6) as usize & 0x3f]));
        }
        if third.is_some() {
            out.push(char::from(ALPHABET[triple as usize & 0x3f]));
        }
    }
    out
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

fn hex_upper(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02X}"));
    }
    out
}
