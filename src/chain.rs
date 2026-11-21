//! Chain descriptor registry and family-based address derivation.
//!
//! One table is the single source of truth for the 18 networks the site
//! exposes. The engine calls [`ChainDescriptor::derive`] on a found key; the
//! address encoders live in [`crate::address`].

use crate::address;

pub use crate::address::{DerivedAddress, KeyMaterial};

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
    /// TON user-friendly form: base64url(flags || workchain || hash || CRC16).
    TonUserFriendly,
}

/// One network the desktop tool can search.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
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
    },
];

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

/// Every descriptor, in site order.
pub fn all() -> &'static [ChainDescriptor] {
    &CHAINS
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

    /// True when the chain's target is the keccak account (EVM and TRON).
    pub fn uses_keccak(&self) -> bool {
        matches!(self.family, Family::EvmKeccak | Family::TronKeccak)
    }

    /// Bytes compared by the search target.
    ///
    /// `secp-hash160`, `evm-keccak` and `tron-keccak` compare a 20-byte
    /// hash160/account; `ed25519` compares a 32-byte public key and TON a
    /// 32-byte StateInit hash. Target files must match this width.
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
