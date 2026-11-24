//! P0 golden vectors for the root product crate.
//!
//! Every value reproduces from the current public API on `main`; the vectors
//! live in `tests/vectors/` as data so later phases can diff against them. The
//! wasm-only operations (P2WPKH/P2SH/P2TR, TON W5, keystore, transaction
//! signing and scan blobs) are asserted by `crates/rotor-wasm/src/golden_vectors.rs`
//! and recorded as gaps in `openspec/changes/product-split/baseline.md`; they
//! are not reachable from this integration test without a new production API.

use std::fs;
use std::path::PathBuf;

use rotor::address::DerivedAddress;
use rotor::chain::{self, KeyMaterial};
use rotor::scalar::Scalar;
use rotor::secp;
use serde_json::Value;

fn vectors(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("tests/vectors")
        .join(name);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_else(|| panic!("missing string field {key}"))
}

fn hex32(value: &str) -> [u8; 32] {
    let mut out = [0u8; 32];
    assert_eq!(value.len(), 64, "expected 32-byte hex");
    for (index, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&value[index * 2..index * 2 + 2], 16)
            .unwrap_or_else(|_| panic!("invalid hex at byte {index}"));
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

fn derive(id: &str, material: KeyMaterial<'_>) -> DerivedAddress {
    chain::by_id(id)
        .unwrap_or_else(|| panic!("unknown chain {id}"))
        .derive(material)
        .unwrap_or_else(|error| panic!("{id} derivation: {error}"))
}

#[test]
fn secp256k1_key_one_matches_desktop_vectors() {
    let vector = vectors("secp256k1.json");
    let key_bytes = hex32(text(&vector, "key"));
    let key = Scalar::from_bytes_be(&key_bytes).expect("valid scalar");
    let point = secp::mul_g(&key);

    assert_eq!(
        hex_upper(&secp::compress(&point)),
        text(&vector, "pubkey_compressed").to_uppercase()
    );
    assert_eq!(
        hex_upper(&secp::uncompress(&point)),
        text(&vector, "pubkey_uncompressed").to_uppercase()
    );

    let desktop = &vector["desktop"];
    let compressed = derive(
        "bitcoin",
        KeyMaterial::Secp {
            key: &key,
            point: &point,
            compressed: true,
        },
    );
    assert_eq!(compressed.address, text(desktop, "bitcoin_p2pkh"));
    assert_eq!(
        compressed.secret.as_deref(),
        Some(text(&vector["wasm"], "wif_compressed"))
    );

    let uncompressed = derive(
        "bitcoin",
        KeyMaterial::Secp {
            key: &key,
            point: &point,
            compressed: false,
        },
    );
    assert_eq!(
        uncompressed.address,
        text(desktop, "bitcoin_p2pkh_uncompressed")
    );

    for (chain_id, field) in [("ethereum", "ethereum"), ("tron", "tron")] {
        let derived = derive(
            chain_id,
            KeyMaterial::Secp {
                key: &key,
                point: &point,
                compressed: true,
            },
        );
        assert_eq!(derived.address, text(desktop, field), "{chain_id}");
    }

    // The same 32 bytes are a valid ed25519 seed on the ed25519 chains.
    for (chain_id, field) in [("solana", "solana"), ("sui", "sui"), ("ton", "ton_v4r2")] {
        let derived = derive(chain_id, KeyMaterial::Seed(&key_bytes));
        assert_eq!(derived.address, text(desktop, field), "{chain_id}");
    }
}

#[test]
fn ed25519_seeds_match_desktop_vectors() {
    let vector = vectors("ed25519.json");

    for case_name in ["seed_1", "rfc8032_test1"] {
        let case = &vector[case_name];
        let seed = hex32(text(case, "seed"));

        let solana = derive("solana", KeyMaterial::Seed(&seed));
        assert_eq!(solana.address, text(case, "solana"), "{case_name}");
        assert_eq!(
            solana.public_hex,
            text(case, "public").to_uppercase(),
            "{case_name}"
        );

        assert_eq!(
            derive("sui", KeyMaterial::Seed(&seed)).address,
            text(case, "sui"),
            "{case_name}"
        );
        assert_eq!(
            derive("ton", KeyMaterial::Seed(&seed)).address,
            text(case, "ton_v4r2"),
            "{case_name}"
        );
    }
}

#[test]
fn eip191_signature_recovers_the_key_one_address() {
    let vector = vectors("signing.json");
    let case = &vector["eip191"];

    let recovered =
        rotor::monitor::auth::recover_address(text(case, "message"), text(case, "signature"))
            .expect("EIP-191 signature recovers");

    assert_eq!(
        recovered.to_lowercase(),
        text(case, "address").to_lowercase()
    );
}
