//! Chain descriptor registry and family-based address derivation.
//!
//! Identity (id, name, symbol, color, decimals, display order, explorer) comes
//! from `data/chains.json` through the generated tables in
//! [`crate::generated::chains`]. This module adds only the derivation
//! behaviour (family, curve, address encoding, HD path, WIF version) keyed by
//! the same slugs. The engine calls [`ChainDescriptor::derive`] on a found
//! key; the address encoders live in [`crate::address`].

use std::sync::LazyLock;

use crate::address;
use crate::generated::chains as generated;

pub use crate::address::{DerivedAddress, KeyMaterial, TonWalletVersion};

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
    /// ed25519 key → the named wallet contract's StateInit hash.
    Ton,
}

impl Family {
    /// Stable lowercase label used by `--list-chains` and error messages.
    pub const fn label(self) -> &'static str {
        match self {
            Family::SecpHash160 => "secp-hash160",
            Family::EvmKeccak => "evm-keccak",
            Family::TronKeccak => "tron-keccak",
            Family::Ed25519 => "ed25519",
            Family::Ton => "ton-v4",
        }
    }
}

/// Curve the chain's keys live on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Curve {
    Secp256k1,
    Ed25519,
}

impl Curve {
    /// Stable lowercase label used by `--list-chains`.
    pub const fn label(self) -> &'static str {
        match self {
            Curve::Secp256k1 => "secp256k1",
            Curve::Ed25519 => "ed25519",
        }
    }
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
    /// TON user-friendly form for the named wallet contract:
    /// base64url(flags || workchain || hash || CRC16).
    TonUserFriendly(TonWalletVersion),
}

/// One network the desktop tool can search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChainDescriptor {
    /// Site slug, e.g. `bitcoin` or `bitcoin-cash`.
    pub id: &'static str,
    /// Human-readable name.
    pub name: &'static str,
    /// Native unit ticker shown by the site and CLI.
    pub symbol: &'static str,
    /// Canonical `#rrggbb` accent color.
    pub color: &'static str,
    /// Canonical display position from `data/chains.json`.
    pub order: u16,
    /// Decimal places of the chain's native unit.
    pub decimals: u8,
    pub family: Family,
    pub curve: Curve,
    pub encoding: AddressEncoding,
    /// BIP44/BIP32 default path, where the chain defines one.
    pub hd_path: Option<&'static str>,
    /// WIF version byte for chains that export WIF; `None` otherwise.
    pub wif_version: Option<u8>,
    /// Explorer URL template containing `{address}`.
    pub explorer: &'static str,
}

/// Derivation-only metadata keyed by the canonical slug. Identity fields are
/// looked up from the generated tables instead of being repeated here.
struct Derivation {
    id: &'static str,
    family: Family,
    curve: Curve,
    encoding: AddressEncoding,
    hd_path: Option<&'static str>,
    wif_version: Option<u8>,
}

/// Derivation metadata for all 18 production chains. The order here is not
/// significant; `chain::all()` iterates the canonical generated order.
const DERIVATIONS: &[Derivation] = &[
    Derivation {
        id: "bitcoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x00]),
        hd_path: Some("m/44'/0'/0'/0/0"),
        wif_version: Some(0x80),
    },
    Derivation {
        id: "ethereum",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "bnb",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "arbitrum",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "optimism",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "base",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "polygon",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "avalanche",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "zksync",
        family: Family::EvmKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::EvmHex,
        hd_path: Some("m/44'/60'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "solana",
        family: Family::Ed25519,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::SolanaBase58,
        hd_path: Some("m/44'/501'/0'/0'"),
        wif_version: None,
    },
    Derivation {
        id: "tron",
        family: Family::TronKeccak,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::TronBase58,
        hd_path: Some("m/44'/195'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "xrp",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::RippleBase58,
        hd_path: Some("m/44'/144'/0'/0/0"),
        wif_version: None,
    },
    Derivation {
        id: "litecoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x30]),
        hd_path: Some("m/44'/2'/0'/0/0"),
        wif_version: Some(0xb0),
    },
    Derivation {
        id: "bitcoin-cash",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x00]),
        hd_path: Some("m/44'/145'/0'/0/0"),
        wif_version: Some(0x80),
    },
    Derivation {
        id: "dogecoin",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x1e]),
        hd_path: Some("m/44'/3'/0'/0/0"),
        wif_version: Some(0x9e),
    },
    Derivation {
        id: "zcash",
        family: Family::SecpHash160,
        curve: Curve::Secp256k1,
        encoding: AddressEncoding::Base58Check(&[0x1c, 0xb8]),
        hd_path: Some("m/44'/133'/0'/0/0"),
        wif_version: Some(0x80),
    },
    Derivation {
        id: "sui",
        family: Family::Ed25519,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::SuiHex,
        hd_path: Some("m/44'/784'/0'/0'/0'"),
        wif_version: None,
    },
    Derivation {
        id: "ton",
        family: Family::Ton,
        curve: Curve::Ed25519,
        encoding: AddressEncoding::TonUserFriendly(TonWalletVersion::V4R2),
        hd_path: Some("m/44'/607'/0'/0/0"),
        wif_version: None,
    },
];

fn text(table: &'static [(&'static str, &'static str)], id: &str) -> &'static str {
    table
        .iter()
        .find(|(slug, _)| *slug == id)
        .map(|(_, value)| *value)
        .unwrap_or_else(|| panic!("generated chain table is missing {id}"))
}

fn number<T>(table: &'static [(&'static str, T)], id: &str) -> T
where
    T: Copy,
{
    table
        .iter()
        .find(|(slug, _)| *slug == id)
        .map(|(_, value)| *value)
        .unwrap_or_else(|| panic!("generated chain table is missing {id}"))
}

fn descriptor(derivation: &Derivation) -> ChainDescriptor {
    let id = derivation.id;
    ChainDescriptor {
        id,
        name: text(generated::CHAIN_NAMES, id),
        symbol: text(generated::CHAIN_SYMBOLS, id),
        color: text(generated::CHAIN_COLORS, id),
        order: number(generated::CHAIN_ORDERS, id),
        decimals: number(generated::CHAIN_DECIMALS, id),
        family: derivation.family,
        curve: derivation.curve,
        encoding: derivation.encoding,
        hd_path: derivation.hd_path,
        wif_version: derivation.wif_version,
        explorer: text(generated::CHAIN_EXPLORERS, id),
    }
}

/// All 18 production chains, in the canonical order from `data/chains.json`.
static CHAINS: LazyLock<Vec<ChainDescriptor>> = LazyLock::new(|| {
    generated::CHAINS_MAINNET
        .iter()
        .map(|id| {
            let derivation = DERIVATIONS
                .iter()
                .find(|derivation| derivation.id == *id)
                .unwrap_or_else(|| panic!("no derivation metadata for chain {id}"));
            descriptor(derivation)
        })
        .collect()
});

/// Ticker aliases accepted by `--chain` besides the site slug itself.
///
/// `--coin BTC|ETH` is a deprecated alias for the first two entries.
pub const ALIASES: &[(&str, &str)] = &[
    ("btc", "bitcoin"),
    ("eth", "ethereum"),
    ("bnb", "bnb"),
    ("arb", "arbitrum"),
    ("op", "optimism"),
    ("base", "base"),
    ("matic", "polygon"),
    ("avax", "avalanche"),
    ("zksync", "zksync"),
    ("sol", "solana"),
    ("trx", "tron"),
    ("xrp", "xrp"),
    ("ltc", "litecoin"),
    ("bch", "bitcoin-cash"),
    ("doge", "dogecoin"),
    ("zec", "zcash"),
    ("sui", "sui"),
    ("ton", "ton"),
];

/// Every descriptor, in canonical order.
pub fn all() -> &'static [ChainDescriptor] {
    CHAINS.as_slice()
}

/// Look up a descriptor by site slug.
pub fn by_id(id: &str) -> Option<&'static ChainDescriptor> {
    CHAINS.iter().find(|chain| chain.id == id)
}

/// Look up a descriptor by site slug or ticker alias, case-insensitively.
pub fn by_alias(text: &str) -> Option<&'static ChainDescriptor> {
    let lowered = text.to_ascii_lowercase();
    by_id(&lowered).or_else(|| {
        ALIASES
            .iter()
            .find(|(alias, _)| *alias == lowered)
            .and_then(|(_, id)| by_id(id))
    })
}

/// Ticker aliases for a site slug (empty when the slug is also the ticker).
pub fn aliases_for(id: &str) -> Vec<&'static str> {
    ALIASES
        .iter()
        .filter(|(alias, slug)| *slug == id && *alias != id)
        .map(|(alias, _)| *alias)
        .collect()
}

impl ChainDescriptor {
    /// Explorer link for a derived address.
    pub fn explorer_url(&self, address: &str) -> String {
        self.explorer.replace("{address}", address)
    }

    /// Explorer link prefix before the address, as the coordinator used to
    /// keep in its own table.
    pub fn explorer_prefix(&self) -> &'static str {
        self.explorer
            .strip_suffix("{address}")
            .unwrap_or(self.explorer)
    }

    /// Icon id in `/icons.svg` for this chain.
    pub fn icon(&self) -> &'static str {
        text(generated::CHAIN_ICONS, self.id)
    }

    /// True when the chain's target is the keccak account (EVM and TRON).
    pub fn uses_keccak(&self) -> bool {
        matches!(self.family, Family::EvmKeccak | Family::TronKeccak)
    }

    /// Bytes compared by the search target.
    ///
    /// `secp-hash160`, `evm-keccak` and `tron-keccak` compare a 20-byte
    /// hash160/account; `ed25519` compares a 32-byte account (the public key on
    /// Solana, its BLAKE2b-256 digest on Sui) and TON a 32-byte StateInit hash.
    /// Target files must match this width.
    pub const fn target_len(&self) -> usize {
        match self.family {
            Family::SecpHash160 | Family::EvmKeccak | Family::TronKeccak => 20,
            Family::Ed25519 | Family::Ton => 32,
        }
    }

    /// Derive this chain's address from key material.
    ///
    /// # Errors
    ///
    /// Returns an error when the material does not match the chain's curve or
    /// a family/encoding pair is unsupported.
    pub fn derive(&self, material: KeyMaterial<'_>) -> Result<DerivedAddress, String> {
        address::derive(self, material)
    }
}
