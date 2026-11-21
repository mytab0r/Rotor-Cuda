//! Chain descriptor registry and family derivation fixtures.
//!
//! The expected addresses are the site's WASM `derive_report` output for key 1
//! (`apps/site/rotor_wasm.wasm`, curve 0) and for ed25519 seed 1 (`curve 1`),
//! plus the RFC8032 ed25519 vector and the tonweb v4R2 vectors for TON. A
//! desktop change that drifts from the site fails here.
//!
//! Note: the current site report exposes TON wallet **W5**
//! (`EQCcCUPw6Gl_Q9MuCKaOFkqCJAnwNqDO-Tt_y4sIUdpyT_5l` for seed 1), while this
//! descriptor implements wallet **v4R2** (`task 6` of the change). TON parity
//! with the site's W5 row is therefore a separate task, not a fixture typo.

use std::collections::HashSet;

use rotor::address;
use rotor::chain::{self, AddressEncoding, Curve, Family, KeyMaterial};
use rotor::scalar::Scalar;
use rotor::secp;

fn secp_derive(id: &str, key: &Scalar, compressed: bool) -> chain::DerivedAddress {
    let descriptor = chain::by_id(id).expect("known chain");
    let point = secp::mul_g(key);
    descriptor
        .derive(KeyMaterial::Secp {
            key,
            point: &point,
            compressed,
        })
        .expect("secp derivation")
}

fn parse_seed(hex: &str) -> [u8; 32] {
    let mut seed = [0u8; 32];
    for (index, byte) in seed.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("hex byte");
    }
    seed
}

/// Test-side base64url decoder, used only to verify the TON checksum.
fn base64url_decode(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = Vec::with_capacity(text.len() * 3 / 4);
    let mut buffer = 0u32;
    let mut bits = 0;
    for byte in text.bytes() {
        let value = ALPHABET
            .iter()
            .position(|candidate| *candidate == byte)
            .expect("base64url character") as u32;
        buffer = (buffer << 6) | value;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
            buffer &= (1 << bits) - 1;
        }
    }
    out
}

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

#[test]
fn registry_covers_all_eighteen_site_networks() {
    let ids: Vec<&str> = chain::all()
        .iter()
        .map(|descriptor| descriptor.id)
        .collect();
    assert_eq!(ids.len(), 18, "one descriptor per site network");

    let unique: HashSet<&str> = ids.iter().copied().collect();
    assert_eq!(unique.len(), ids.len(), "chain ids must be unique");

    for expected in [
        "bitcoin",
        "ethereum",
        "bnb",
        "arbitrum",
        "optimism",
        "base",
        "polygon",
        "avalanche",
        "zksync",
        "solana",
        "tron",
        "xrp",
        "litecoin",
        "bitcoin-cash",
        "dogecoin",
        "zcash",
        "sui",
        "ton",
    ] {
        assert!(unique.contains(expected), "missing chain {expected}");
    }
}

#[test]
fn family_mapping_is_explicit() {
    let expected: &[(&str, Family)] = &[
        ("bitcoin", Family::SecpHash160),
        ("litecoin", Family::SecpHash160),
        ("dogecoin", Family::SecpHash160),
        ("bitcoin-cash", Family::SecpHash160),
        ("zcash", Family::SecpHash160),
        ("xrp", Family::SecpHash160),
        ("ethereum", Family::EvmKeccak),
        ("bnb", Family::EvmKeccak),
        ("arbitrum", Family::EvmKeccak),
        ("optimism", Family::EvmKeccak),
        ("base", Family::EvmKeccak),
        ("polygon", Family::EvmKeccak),
        ("avalanche", Family::EvmKeccak),
        ("zksync", Family::EvmKeccak),
        ("tron", Family::TronKeccak),
        ("solana", Family::Ed25519),
        ("sui", Family::Ed25519),
        ("ton", Family::Ton),
    ];
    assert_eq!(expected.len(), chain::all().len());

    for (id, family) in expected {
        let descriptor = chain::by_id(id).expect("known chain");
        assert_eq!(descriptor.family, *family, "{id}");
    }
}

#[test]
fn descriptor_fields_are_populated() {
    for descriptor in chain::all() {
        assert!(!descriptor.id.is_empty());
        assert!(!descriptor.name.is_empty());
        assert!(
            descriptor.explorer.contains("{address}"),
            "{} explorer must be a template",
            descriptor.id
        );
        assert!(
            descriptor.hd_path.is_some(),
            "{} needs an HD path",
            descriptor.id
        );

        let expected_curve = match descriptor.family {
            Family::SecpHash160 | Family::EvmKeccak | Family::TronKeccak => Curve::Secp256k1,
            Family::Ed25519 | Family::Ton => Curve::Ed25519,
        };
        assert_eq!(descriptor.curve, expected_curve, "{}", descriptor.id);

        let encoding_matches_family = match descriptor.family {
            Family::SecpHash160 => matches!(
                descriptor.encoding,
                AddressEncoding::Base58Check(_) | AddressEncoding::RippleBase58
            ),
            Family::EvmKeccak => descriptor.encoding == AddressEncoding::EvmHex,
            Family::TronKeccak => descriptor.encoding == AddressEncoding::TronBase58,
            Family::Ed25519 => matches!(
                descriptor.encoding,
                AddressEncoding::SolanaBase58 | AddressEncoding::SuiHex
            ),
            Family::Ton => descriptor.encoding == AddressEncoding::TonUserFriendly,
        };
        assert!(
            encoding_matches_family,
            "{} encoding does not match its family",
            descriptor.id
        );
    }

    let bitcoin = chain::by_id("bitcoin").expect("known chain");
    assert_eq!(
        bitcoin.explorer_url("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
        "https://mempool.space/address/1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    );
}

#[test]
fn bitcoin_and_ethereum_key_one_vectors() {
    let key = Scalar::from_u64(1);

    let bitcoin = secp_derive("bitcoin", &key, true);
    assert_eq!(bitcoin.address, "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH");
    assert_eq!(
        bitcoin.secret.as_deref(),
        Some("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn")
    );
    assert_eq!(
        bitcoin.public_hex,
        "0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"
    );

    let uncompressed = secp_derive("bitcoin", &key, false);
    assert_eq!(uncompressed.address, "1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm");

    let ethereum = secp_derive("ethereum", &key, true);
    assert_eq!(
        ethereum.address,
        "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
    );
    assert_eq!(ethereum.secret, None);
    assert_eq!(
        ethereum.public_hex,
        "79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798\
         483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"
    );
}

#[test]
fn secp_hash160_and_keccak_family_vectors() {
    let key = Scalar::from_u64(1);

    // Site fixtures for key 1, one per non-BTC family member.
    let vectors: &[(&str, &str)] = &[
        ("litecoin", "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ"),
        ("dogecoin", "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE"),
        ("bitcoin-cash", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
        ("xrp", "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH"),
        ("zcash", "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs"),
        ("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"),
    ];

    for (id, address) in vectors {
        assert_eq!(&secp_derive(id, &key, true).address, address, "{id}");
    }

    // Every EVM chain shares the account; only the explorer differs.
    for id in [
        "bnb",
        "arbitrum",
        "optimism",
        "base",
        "polygon",
        "avalanche",
        "zksync",
    ] {
        assert_eq!(
            secp_derive(id, &key, true).address,
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
            "{id}"
        );
    }

    // XRP is the one secp-hash160 chain without a WIF secret.
    assert_eq!(secp_derive("xrp", &key, true).secret, None);
    assert!(secp_derive("litecoin", &key, true).secret.is_some());
}

#[test]
fn wasm_report_key_one_secp_fixtures_cover_all_fifteen_secp_chains() {
    // Source: `apps/site/rotor_wasm.wasm` `derive_report(key 1, curve 0)`.
    // The EVM chains share one account, so only `ethereum` owns the row in the
    // report; every EVM descriptor must return the same address.
    let key = Scalar::from_u64(1);
    let fixtures: &[(&str, &str)] = &[
        ("bitcoin", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
        ("litecoin", "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ"),
        ("dogecoin", "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE"),
        ("bitcoin-cash", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
        ("zcash", "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs"),
        ("xrp", "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH"),
        ("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"),
    ];
    for (id, expected) in fixtures {
        assert_eq!(&secp_derive(id, &key, true).address, expected, "{id}");
    }

    for id in [
        "ethereum",
        "bnb",
        "arbitrum",
        "optimism",
        "base",
        "polygon",
        "avalanche",
        "zksync",
    ] {
        assert_eq!(
            secp_derive(id, &key, true).address,
            "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf",
            "{id}"
        );
    }

    assert_eq!(fixtures.len() + 8, 15, "all secp-hash160 and EVM chains");
}

#[test]
fn wasm_report_ed25519_seed_one_fixtures_match_solana_and_sui() {
    // Source: `apps/site/rotor_wasm.wasm` `derive_report(seed 1, curve 1)`.
    let seed = parse_seed("0000000000000000000000000000000000000000000000000000000000000001");

    let solana = chain::by_id("solana")
        .expect("known chain")
        .derive(KeyMaterial::Seed(&seed))
        .expect("solana derivation");
    assert_eq!(
        solana.address,
        "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt"
    );
    assert_eq!(
        solana.public_hex,
        "4CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA29"
    );

    let sui = chain::by_id("sui")
        .expect("known chain")
        .derive(KeyMaterial::Seed(&seed))
        .expect("sui derivation");
    assert_eq!(
        sui.address,
        "0xd0c2c91eda34bbfbaec6cfb9c7bb913e57dab3cbec4018a4b3f5e55531cd63af"
    );
}

#[test]
fn encoders_live_in_the_address_module_and_match_the_report() {
    let key = Scalar::from_u64(1);
    let point = secp::mul_g(&key);
    let hash = secp::hash160(&point, true);

    assert_eq!(
        address::base58check(&[0x00], &hash),
        "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"
    );
    assert_eq!(
        address::ripple_base58(&hash),
        "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH"
    );
    assert_eq!(
        address::evm_hex(&secp::eth_address(&point)),
        "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"
    );
    assert_eq!(
        address::tron_base58(&secp::eth_address(&point)),
        "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"
    );
}

#[test]
fn ed25519_family_uses_the_rfc8032_vector() {
    let seed = parse_seed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");

    let solana = chain::by_id("solana").expect("known chain");
    let derived = solana
        .derive(KeyMaterial::Seed(&seed))
        .expect("solana derivation");
    assert_eq!(
        derived.address,
        "FVen3X669xLzsi6N2V91DoiyzHzg1uAgqiT8jZ9nS96Z"
    );
    assert_eq!(
        derived.public_hex,
        "D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A"
    );

    let sui = chain::by_id("sui").expect("known chain");
    let derived = sui
        .derive(KeyMaterial::Seed(&seed))
        .expect("sui derivation");
    assert_eq!(
        derived.address,
        "0x304af458e90e97c841685b8cbbc59b909f3e2cf150df590ada4c81452c29737d"
    );
    assert_eq!(derived.secret, None);
}

#[test]
fn ton_v4r2_matches_tonweb_and_ton_core() {
    // Independently produced vectors: the tonweb `WalletV4ContractR2` bundled
    // in `apps/site/ton.js` (the site's own TON output) and `@ton/ton` 16.3.0
    // (`WalletContractV4`) both return these addresses for these seeds.
    let vectors: &[(&str, &str, &str)] = &[
        // RFC 8032 ed25519 test-vector seed.
        (
            "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60",
            "D75A980182B10AB7D54BFED3C964073A0EE172F3DAA62325AF021A68F707511A",
            "EQDNrJfJFisuFBrURjgosqcO_fh2K5foNWPzUr7PkC6Ipopv",
        ),
        // ed25519 seed 1.
        (
            "0000000000000000000000000000000000000000000000000000000000000001",
            "4CB5ABF6AD79FBF5ABBCCAFCC269D85CD2651ED4B885B5869F241AEDF0A5BA29",
            "EQAkxuybaeBflbgYW3vgQvcFgyAQVcLtXZwdrpeLNqzZ000c",
        ),
    ];

    let ton = chain::by_id("ton").expect("known chain");
    assert!(ton.enabled, "TON is enabled once v4R2 derives addresses");
    for (seed_hex, public_hex, address) in vectors {
        let seed = parse_seed(seed_hex);
        let derived = ton
            .derive(KeyMaterial::Seed(&seed))
            .expect("ton derivation");
        assert_eq!(derived.address, *address, "{seed_hex}");
        assert_eq!(derived.public_hex, *public_hex);
        assert_eq!(derived.secret, None);
    }

    // Every descriptor is enabled now that TON derives addresses.
    for descriptor in chain::all() {
        assert!(descriptor.enabled, "{} should be enabled", descriptor.id);
    }
}

#[test]
fn ton_address_is_user_friendly_base64url_with_crc16() {
    let seed = parse_seed("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60");
    let address = chain::by_id("ton")
        .expect("known chain")
        .derive(KeyMaterial::Seed(&seed))
        .expect("ton derivation")
        .address;

    assert_eq!(address.len(), 48, "34 payload bytes + 2 checksum bytes");
    assert!(address.starts_with("EQ"), "bounceable workchain-0 tag");
    assert!(
        address
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_'),
        "unpadded base64url alphabet: {address}"
    );

    let raw = base64url_decode(&address);
    assert_eq!(raw.len(), 36);
    assert_eq!(raw[0], 0x11, "bounceable, non-testnet");
    assert_eq!(raw[1], 0x00, "workchain 0");
    let expected = crc16_xmodem(&raw[..34]).to_be_bytes();
    assert_eq!(&raw[34..], &expected, "CRC16-XMODEM checksum");
}

#[test]
fn ton_rejects_secp_material() {
    let ton = chain::by_id("ton").expect("known chain");
    let key = Scalar::from_u64(1);
    let point = secp::mul_g(&key);
    assert!(
        ton.derive(KeyMaterial::Secp {
            key: &key,
            point: &point,
            compressed: true,
        })
        .is_err()
    );
    assert!(ton.derive(KeyMaterial::Seed(&[0u8; 32])).is_ok());
}

#[test]
fn wrong_key_material_is_rejected() {
    let seed = [0u8; 32];
    let bitcoin = chain::by_id("bitcoin").expect("known chain");
    assert!(bitcoin.derive(KeyMaterial::Seed(&seed)).is_err());

    let key = Scalar::from_u64(1);
    let point = secp::mul_g(&key);
    let solana = chain::by_id("solana").expect("known chain");
    assert!(
        solana
            .derive(KeyMaterial::Secp {
                key: &key,
                point: &point,
                compressed: true,
            })
            .is_err()
    );
}
