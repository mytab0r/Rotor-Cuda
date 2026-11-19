//! Chain descriptor registry and family-based address derivation.
//!
//! One table is the single source of truth for the 18 networks the site
//! exposes. The engine calls [`ChainDescriptor::derive`] on a found key; the
//! chain family dispatches to the shared secp/keccak/ed25519 encoders.
//!
//! Scope note: this module only derives addresses. TON wallet v4R2 needs
//! StateInit cell serialization and is an explicit unsupported error here
//! rather than a silently wrong address.

use blake2::digest::consts::U32;
use blake2::{Blake2b, Digest as _};
use ed25519_dalek::SigningKey;

use crate::base58;
use crate::hashes;
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

/// Search primitive a chain shares with its siblings.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Family {
    /// scalar → point → SHA256/RIPEMD160, 20-byte target.
    SecpHash160,
    /// scalar → point → keccak256, last 20 bytes (EIP-55 display).
    EvmKeccak,
    /// Same keccak target as EVM, 0x41 Base58Check display.
    TronKeccak,
    /// 32-byte seed → ed25519 public key (SUI hashes it with BLAKE2b-256).
    Ed25519,
    /// ed25519 key → wallet v4R2 StateInit hash.
    Ton,
}

/// Curve the chain's keys live on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Curve {
    Secp256k1,
    Ed25519,
}

/// Address encoding applied to the family's derived bytes.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AddressEncoding {
    /// Base58Check with the supplied version prefix; Zcash needs two bytes.
    Base58Check(&'static [u8]),
    /// Ripple's base58 alphabet with a double-SHA256 checksum.
    RippleBase58,
    /// EIP-55 mixed-case `0x` hex.
    EvmHex,
    /// Base58Check with the 0x41 TRON prefix.
    TronBase58,
    /// base58 of the raw 32-byte ed25519 public key.
    SolanaBase58,
    /// `0x` + BLAKE2b-256(0x00 || ed25519 public key).
    SuiHex,
    /// TON user-friendly form (not implemented yet).
    TonUserFriendly,
}

/// One network the desktop tool can search.
#[derive(Debug, Clone, Copy)]
pub struct ChainDescriptor {
    /// Site slug, e.g. `bitcoin` or `bitcoin-cash`.
    pub id: &'static str,
    /// Human-readable name.
    pub name: &'static str,
    pub family: Family,
    pub curve: Curve,
    pub encoding: AddressEncoding,
    /// BIP44/BIP32 default path, where the chain defines one.
    pub hd_path: Option<&'static str>,
    /// WIF version byte for chains that export WIF; `None` otherwise.
    pub wif_version: Option<u8>,
    /// Explorer URL template containing `{address}`.
    pub explorer: &'static str,
    /// False when the descriptor exists but derivation is not implemented.
    pub enabled: bool,
}

/// Key material accepted by [`ChainDescriptor::derive`].
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

/// All 18 chains, ordered as on the site.
pub const CHAINS: [ChainDescriptor; 18] = [
    ChainDescriptor {
        id: "bitcoin",
        name: "Bitcoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x00]),
        hd_path: Some("m/44'/0'/0'/0/0"),
        wif_version: Some(0x80),
        explorer: "https://mempool.space/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "ethereum",
        name: "Ethereum",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://etherscan.io/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "bnb",
        name: "BNB Chain",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://bscscan.com/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "arbitrum",
        name: "Arbitrum",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://arbiscan.io/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "optimism",
        name: "Optimism",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://optimistic.etherscan.io/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "base",
        name: "Base",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://basescan.org/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "polygon",
        name: "Polygon",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://polygonscan.com/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "avalanche",
        name: "Avalanche",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://snowtrace.io/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "zksync",
        name: "zkSync Era",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
        explorer: "https://explorer.zksync.io/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "solana",
        name: "Solana",
        family: Family::Ed25519,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::SolanaBase58,
        hd_path: Some("m/44'/501'/0'/0'"),
        wif_version: None,
        explorer: "https://solscan.io/account/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "tron",
        name: "TRON",
        family: Family::TronKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::TronBase58,
        hd_path: Some("m/44'/195'/0'/0/0"),
        wif_version: None,
        explorer: "https://tronscan.org/#/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "xrp",
        name: "XRP",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::RippleBase58,
        hd_path: Some("m/44'/144'/0'/0/0"),
        wif_version: None,
        explorer: "https://xrpscan.com/account/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "litecoin",
        name: "Litecoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x30]),
        hd_path: Some("m/44'/2'/0'/0/0"),
        wif_version: Some(0xb0),
        explorer: "https://blockchair.com/litecoin/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "bitcoin-cash",
        name: "Bitcoin Cash",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x00]),
        hd_path: Some("m/44'/145'/0'/0/0"),
        wif_version: Some(0x80),
        explorer: "https://blockchair.com/bitcoin-cash/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "dogecoin",
        name: "Dogecoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x1e]),
        hd_path: Some("m/44'/3'/0'/0/0"),
        wif_version: Some(0x9e),
        explorer: "https://blockchair.com/dogecoin/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "zcash",
        name: "Zcash",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x1c, 0xb8]),
        hd_path: Some("m/44'/133'/0'/0/0"),
        wif_version: Some(0x80),
        explorer: "https://blockchair.com/zcash/address/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "sui",
        name: "Sui",
        family: Family::Ed25519,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::SuiHex,
        hd_path: Some("m/44'/784'/0'/0'/0'"),
        wif_version: None,
        explorer: "https://suiscan.xyz/mainnet/account/{address}",
        enabled: true,
    },
    ChainDescriptor {
        id: "ton",
        name: "TON",
        family: Family::Ton,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::TonUserFriendly,
        hd_path: Some("m/44'/607'/0'/0/0"),
        wif_version: None,
        explorer: "https://tonviewer.com/{address}",
        // v4R2 StateInit serialization is not implemented yet; see tasks.md.
        enabled: false,
    },
];

/// Every descriptor, in site order.
pub fn all() -> &'static [ChainDescriptor] {
    &CHAINS
}

/// Look up a descriptor by site slug.
pub fn by_id(id: &str) -> Option<&'static ChainDescriptor> {
    CHAINS.iter().find(|chain| chain.id == id)
}

impl ChainDescriptor {
    /// Explorer link for a derived address.
    pub fn explorer_url(&self, address: &str) -> String {
        self.explorer.replace("{address}", address)
    }

    /// Derive this chain's address from key material.
    ///
    /// # Errors
    ///
    /// Returns an error when the material does not match the chain's curve, a
    /// family/encoding pair is unsupported, or TON (v4R2) is requested.
    pub fn derive(&self, material: KeyMaterial<'_>) -> Result<DerivedAddress, String> {
        match self.family {
            Family::SecpHash160 => self.derive_secp_hash160(material),
            Family::EvmKeccak | Family::TronKeccak => self.derive_keccak(material),
            Family::Ed25519 => self.derive_ed25519(material),
            Family::Ton => Err(format!(
                "{} address derivation is not implemented yet: TON wallet v4R2 \
                 StateInit serialization is required",
                self.name
            )),
        }
    }

    fn derive_secp_hash160(&self, material: KeyMaterial<'_>) -> Result<DerivedAddress, String> {
        let KeyMaterial::Secp {
            key,
            point,
            compressed,
        } = material
        else {
            return Err(format!("{} needs a secp256k1 key", self.name));
        };
        let hash = secp::hash160(point, compressed);
        let address = match self.encoding {
            AddressEncoding::Base58Check(version) => {
                let mut payload = Vec::with_capacity(version.len() + hash.len());
                payload.extend_from_slice(version);
                payload.extend_from_slice(&hash);
                base58::encode_check(&payload)
            }
            AddressEncoding::RippleBase58 => {
                let mut payload = [0u8; 21];
                payload[1..].copy_from_slice(&hash);
                let checksum = hashes::sha256d(&payload);
                let mut data = [0u8; 25];
                data[..21].copy_from_slice(&payload);
                data[21..].copy_from_slice(&checksum[..4]);
                base58::encode_ripple(&data)
            }
            other => {
                return Err(format!(
                    "{} does not support {other:?} in the secp-hash160 family",
                    self.name
                ));
            }
        };
        let secret = self
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

    fn derive_keccak(&self, material: KeyMaterial<'_>) -> Result<DerivedAddress, String> {
        let KeyMaterial::Secp { point, .. } = material else {
            return Err(format!("{} needs a secp256k1 key", self.name));
        };
        let account = secp::eth_address(point);
        let address = match self.family {
            Family::EvmKeccak => eip55(&account),
            Family::TronKeccak => {
                let mut payload = [0u8; 21];
                payload[0] = 0x41;
                payload[1..].copy_from_slice(&account);
                base58::encode_check(&payload)
            }
            _ => {
                return Err(format!("{} is not a keccak chain", self.name));
            }
        };
        let uncompressed = secp::uncompress(point);
        Ok(DerivedAddress {
            address,
            secret: None,
            public_hex: hex_upper(&uncompressed[1..]),
        })
    }

    fn derive_ed25519(&self, material: KeyMaterial<'_>) -> Result<DerivedAddress, String> {
        let KeyMaterial::Seed(seed) = material else {
            return Err(format!("{} needs a 32-byte ed25519 seed", self.name));
        };
        let public = SigningKey::from_bytes(seed).verifying_key().to_bytes();
        let address = match self.encoding {
            AddressEncoding::SolanaBase58 => bs58::encode(public).into_string(),
            AddressEncoding::SuiHex => {
                let mut input = [0u8; 33];
                input[1..].copy_from_slice(&public);
                let mut hasher = Blake2b::<U32>::new();
                hasher.update(input);
                format!("0x{}", hex_lower(&hasher.finalize()))
            }
            other => {
                return Err(format!(
                    "{} does not support {other:?} in the ed25519 family",
                    self.name
                ));
            }
        };
        Ok(DerivedAddress {
            address,
            secret: None,
            public_hex: hex_upper(&public),
        })
    }
}

/// EIP-55 mixed-case checksum form of a 20-byte EVM account.
fn eip55(address: &[u8; 20]) -> String {
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
