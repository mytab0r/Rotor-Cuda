//! Integration proof for the ed25519 derivation report.
//!
//! This file lives under `tests/`, so the revert-mutation gate leaves it in
//! place: reverting the source hunks that add the TON rows must make this
//! suite fail.

use serde_json::Value;

/// RFC 8032 test seed from section 7.1 ("TEST 1").
const RFC8032_SEED: &str = "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60";

const TON_V3R2: &str = "EQB3V1d93mD6v4qWoRPnlm0UrYpcHZz2lCD_10u84NHWuX1P";
const TON_V4R2: &str = "EQDNrJfJFisuFBrURjgosqcO_fh2K5foNWPzUr7PkC6Ipopv";
const TON_W5: &str = "EQCUp64SJJ505dIdcgHDG1oD8JKMLXpQzu5W6lLFdQGtA5Td";

fn seed_bytes() -> [u8; 32] {
    let mut out = [0u8; 32];
    for (index, byte) in out.iter_mut().enumerate() {
        let pair = &RFC8032_SEED[index * 2..index * 2 + 2];
        *byte = u8::from_str_radix(pair, 16).expect("RFC 8032 seed is valid hex");
    }
    out
}

fn report() -> Value {
    let json = rotor_wasm::derive_report_json(&seed_bytes(), 1)
        .expect("ed25519 report must build for the RFC 8032 seed");
    serde_json::from_str(&json).expect("derivation report must be valid JSON")
}

#[test]
fn ed25519_report_lists_solana_sui_and_every_ton_version() {
    let report = report();
    let addresses = report["addresses"]
        .as_array()
        .expect("addresses must be an array");

    let ids: Vec<&str> = addresses
        .iter()
        .map(|entry| entry["id"].as_str().expect("every entry has a string id"))
        .collect();
    assert_eq!(
        ids,
        ["solana", "sui", "ton_v3r2", "ton_v4r2", "ton_w5"],
        "the ed25519 report lists solana, sui and the TON rows in order"
    );

    let ton = |index: usize, expected: &str| {
        let address = addresses[index]["address"]
            .as_str()
            .expect("every entry has a string address");
        assert_eq!(
            address, expected,
            "row {} ({}) must carry the TON wallet address",
            index, ids[index]
        );
    };
    ton(2, TON_V3R2);
    ton(3, TON_V4R2);
    ton(4, TON_W5);
}

#[test]
fn ton_rows_prove_distinct_contracts_and_state_init_hash() {
    let report = report();
    let addresses = report["addresses"]
        .as_array()
        .expect("addresses must be an array");

    for (index, entry) in addresses.iter().enumerate().take(5).skip(2) {
        let state_init_hash = entry["steps"]["state_init_hash"]
            .as_str()
            .expect("each TON row carries a state_init_hash step");
        assert_eq!(
            state_init_hash.len(),
            64,
            "row {} ({}) state_init_hash must be 64 hex characters, got {:?}",
            index,
            entry["id"],
            state_init_hash
        );
        assert!(
            state_init_hash.bytes().all(|byte| byte.is_ascii_hexdigit()),
            "row {} state_init_hash must be hex, got {:?}",
            index,
            state_init_hash
        );
    }

    let ton_addresses: Vec<&str> = addresses[2..5]
        .iter()
        .map(|entry| {
            entry["address"]
                .as_str()
                .expect("TON rows have a string address")
        })
        .collect();
    for first in 0..ton_addresses.len() {
        for second in (first + 1)..ton_addresses.len() {
            assert_ne!(
                ton_addresses[first], ton_addresses[second],
                "TON wallet contract versions must derive distinct addresses"
            );
        }
    }
}
