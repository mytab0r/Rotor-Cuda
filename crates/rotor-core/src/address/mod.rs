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
//! - [`Family::Ton`](crate::chain::Family::Ton): ed25519 key → the wallet
//!   contract named by [`TonWalletVersion`] (v3R2, v4R2 or W5) → user-friendly
//!   base64url with CRC16.
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

pub mod ton;
pub use ton::{
    TonAddress, TonWalletVersion, ton_address, ton_v3r2_address, ton_v4r2_address, ton_w5_address,
};

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
    let version = match descriptor.encoding {
        AddressEncoding::TonUserFriendly(version) => version,
        other => {
            return Err(format!(
                "{} does not support {:?} in the TON family",
                descriptor.name, other
            ));
        }
    };
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    Ok(DerivedAddress {
        address: ton_address(&public, version)?.address,
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

/// Sui's account digest: BLAKE2b-256(0x00 || ed25519 public key).
pub fn sui_account(public: &[u8; 32]) -> [u8; 32] {
    let mut input = [0u8; 33];
    input[1..].copy_from_slice(public);
    let mut hasher = Blake2b::<U32>::new();
    hasher.update(input);
    hasher.finalize().into()
}

/// Sui's account is `0x` + [`sui_account`].
pub fn sui_hex(public: &[u8; 32]) -> String {
    format!("0x{}", hex_lower(&sui_account(public)))
}

/// Raw 32-byte account the search compares for an ed25519-family target:
/// the public key itself on Solana, its BLAKE2b-256 digest on Sui.
///
/// This is the same value the chain's address encodes, so an address target
/// and a `.bin` record compare the same bytes.
pub fn ed25519_account(descriptor: &ChainDescriptor, seed: &[u8; 32]) -> Result<[u8; 32], String> {
    let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
    match descriptor.encoding {
        AddressEncoding::SolanaBase58 => Ok(public),
        AddressEncoding::SuiHex => Ok(sui_account(&public)),
        other => Err(format!(
            "{} does not support {other:?} in the ed25519 family",
            descriptor.name
        )),
    }
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
