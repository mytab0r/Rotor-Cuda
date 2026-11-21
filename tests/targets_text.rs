//! Target loader fixtures: text addresses per chain and `.bin` record widths.
//!
//! Addresses are the published key-1 vectors from `tests/chain.rs` (the site's
//! WASM `derive_report`); hash160/keccak expectations are recomputed here with
//! the public secp helpers so the loader is checked end to end.

use std::io::Cursor;
use std::path::PathBuf;

use rotor::chain;
use rotor::cli::SearchMode;
use rotor::filter::TargetSet;
use rotor::scalar::Scalar;
use rotor::secp::{self, mul_g};
use rotor::{base58, targets_text};

fn chain(id: &str) -> &'static chain::ChainDescriptor {
    chain::by_id(id).unwrap_or_else(|| panic!("descriptor for {id}"))
}

/// Key-1 addresses for every 20-byte-target family member.
const KEY1_ADDRESSES: &[(&str, &str)] = &[
    ("bitcoin", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
    ("litecoin", "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ"),
    ("dogecoin", "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE"),
    ("bitcoin-cash", "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH"),
    ("zcash", "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs"),
    ("xrp", "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH"),
    ("ethereum", "0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf"),
    ("tron", "TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC"),
];

fn key1_hash160() -> [u8; 20] {
    secp::hash160(&mul_g(&Scalar::from_u64(1)), true)
}

fn key1_account() -> [u8; 20] {
    secp::eth_address(&mul_g(&Scalar::from_u64(1)))
}

fn load_text(text: &str, id: &str) -> Result<TargetSet, String> {
    targets_text::load(Cursor::new(text), chain(id), SearchMode::Addresses)
}

fn temp_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rotor_targets_{tag}_{}_{nanos}.bin",
        std::process::id()
    ))
}

#[test]
fn text_targets_decode_for_every_twenty_byte_chain() {
    for (id, address) in KEY1_ADDRESSES {
        let set = load_text(address, id).unwrap_or_else(|err| panic!("{id}: {err}"));

        let expected = match chain(id).family {
            chain::Family::EvmKeccak | chain::Family::TronKeccak => key1_account(),
            _ => key1_hash160(),
        };
        assert_eq!(set.record_len(), 20, "{id}");
        assert_eq!(set.len(), 1, "{id}");
        assert!(
            set.contains(&expected),
            "{id} did not decode to the key-1 target"
        );
    }
}

#[test]
fn an_address_of_another_chain_is_an_error_not_a_fallback() {
    let (_, litecoin) = KEY1_ADDRESSES[1];
    let (_, ethereum) = KEY1_ADDRESSES[6];

    for (selected, text, foreign) in [
        ("bitcoin", litecoin, "litecoin"),
        ("bitcoin", ethereum, "ethereum"),
        ("litecoin", KEY1_ADDRESSES[0].1, "bitcoin"),
    ] {
        let err = load_text(text, selected)
            .err()
            .unwrap_or_else(|| panic!("{selected}: foreign address must be rejected"));
        assert!(err.starts_with("line 1: "), "{selected}: {err}");
        assert!(err.contains(foreign), "{selected}: {err}");
        assert!(err.contains(selected), "{selected}: {err}");
        assert!(err.contains("mixed chains"), "{selected}: {err}");
    }
}

#[test]
fn mixed_text_file_reports_line_number_and_both_chains() {
    let text = format!("{}\n{}\n", KEY1_ADDRESSES[0].1, KEY1_ADDRESSES[1].1);

    let err = load_text(&text, "bitcoin")
        .err()
        .expect("a mixed file must be rejected");

    assert!(err.starts_with("line 2: "), "unexpected error: {err}");
    assert!(err.contains("bitcoin"), "selected chain missing: {err}");
    assert!(err.contains("litecoin"), "offending chain missing: {err}");
}

#[test]
fn wrong_payload_length_error_names_the_chain_and_both_lengths() {
    // A checksum-valid 0x00 Base58Check address carrying 19 hash bytes decodes
    // to a 20-byte payload. It matches no chain, so the length error is the
    // only useful explanation.
    let mut payload = [0u8; 20];
    payload[0] = 0x00;
    let address = base58::encode_check(&payload);

    let err = load_text(&address, "bitcoin")
        .err()
        .expect("a 20-byte payload must be rejected for Bitcoin");
    assert!(err.starts_with("line 1: "), "unexpected error: {err}");
    assert!(err.contains("Bitcoin"), "chain missing: {err}");
    assert!(err.contains("20-byte"), "received length missing: {err}");
    assert!(err.contains("21 bytes"), "expected length missing: {err}");
}

#[test]
fn thirty_two_byte_chains_reject_text_targets_loudly() {
    // Key-1/seed-1 fixtures from `tests/chain.rs`: the address decodes as the
    // chain's own 32-byte form, which the text loader does not implement yet.
    let fixtures = [
        ("solana", "6ASf5EcmmEHTgDJ4X4ZT5vT6iHVJBXPg5AN5YoTCpGWt"),
        (
            "sui",
            "0xd0c2c91eda34bbfbaec6cfb9c7bb913e57dab3cbec4018a4b3f5e55531cd63af",
        ),
        ("ton", "EQAkxuybaeBflbgYW3vgQvcFgyAQVcLtXZwdrpeLNqzZ000c"),
    ];
    for (id, address) in fixtures {
        let err = load_text(address, id)
            .err()
            .expect("text target must be rejected");
        assert!(err.contains(id), "{id}: {err}");
        assert!(err.contains("32-byte"), "{id}: {err}");
        assert!(err.contains("not implemented yet"), "{id}: {err}");
    }
}

#[test]
fn valid_bin_file_is_chain_agnostic_and_follows_the_cli_chain() {
    let path = temp_path("key1");
    std::fs::write(&path, key1_hash160()).expect("write temp file");

    let loaded: Vec<TargetSet> = ["bitcoin", "litecoin", "dogecoin", "zcash"]
        .iter()
        .map(|id| {
            TargetSet::load_for_chain(&path, chain(id), 20)
                .unwrap_or_else(|err| panic!("{id}: {err}"))
        })
        .collect();
    let _ = std::fs::remove_file(&path);

    for set in &loaded {
        assert_eq!(set.len(), 1);
        assert_eq!(set.record_len(), 20);
        assert!(set.contains(&key1_hash160()));
    }
}

#[test]
fn wrong_length_bin_file_reports_bytes_and_record_width() {
    let path = temp_path("nineteen");
    std::fs::write(&path, vec![0u8; 19]).expect("write temp file");

    let err = TargetSet::load_for_chain(&path, chain("bitcoin"), 20)
        .err()
        .expect("a 19-byte file must be rejected");
    let _ = std::fs::remove_file(&path);

    assert!(
        err.contains("has 19 bytes"),
        "received length missing: {err}"
    );
    assert!(
        err.contains("20-byte record length"),
        "record width missing: {err}"
    );
}

#[test]
fn twenty_byte_bin_file_is_rejected_for_thirty_two_byte_chains() {
    let path = temp_path("solana");
    std::fs::write(&path, key1_hash160()).expect("write temp file");

    for id in ["solana", "sui", "ton"] {
        let err = TargetSet::load_for_chain(&path, chain(id), 20)
            .err()
            .expect("20-byte records must be rejected for a 32-byte target");
        assert!(err.contains(id), "{id}: {err}");
        assert!(err.contains("32-byte"), "{id}: {err}");
        assert!(err.contains("20-byte"), "{id}: {err}");
    }
    let _ = std::fs::remove_file(&path);
}
