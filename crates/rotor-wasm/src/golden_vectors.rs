//! P0 golden vectors for the wasm-only operations.
//!
//! The data lives in `tests/vectors/` and is shared with `tests/golden_vectors.rs`
//! (root crate). This module covers what the root public API cannot reach on
//! current `main`: P2WPKH/P2SH/P2TR reports, TON W5, keystore decryption, the
//! BIP143 and TRON signers, and the scan/samples result blobs. Everything is
//! deterministic: fixed keys, fixed jobs, no clock, no randomness, no network.

use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;

use serde_json::Value;

use crate::{Session, derive, keystore, scalar::Scalar};

fn vectors(name: &str) -> Value {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/vectors")
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
    let bytes = hex_bytes(value);
    bytes
        .try_into()
        .unwrap_or_else(|_| panic!("expected 32-byte hex, got {}", value.len() / 2))
}

fn hex_bytes(value: &str) -> Vec<u8> {
    assert!(value.len().is_multiple_of(2), "odd-length hex");
    (0..value.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&value[index..index + 2], 16)
                .unwrap_or_else(|_| panic!("invalid hex at byte {index}"))
        })
        .collect()
}

fn scalar(value: &str) -> Scalar {
    Scalar::from_u64(value.parse().expect("decimal scalar"))
}

fn addresses(report: &Value) -> HashMap<&str, &str> {
    report["addresses"]
        .as_array()
        .expect("addresses array")
        .iter()
        .map(|entry| {
            (
                entry["id"].as_str().expect("address id"),
                entry["address"].as_str().expect("address value"),
            )
        })
        .collect()
}

fn report(key: &[u8; 32], curve: u32) -> Value {
    let json = derive::report(key, curve).expect("derivation report");
    serde_json::from_str(&json).expect("report JSON")
}

fn assert_addresses(report: &Value, expected: &serde_json::Map<String, Value>) {
    let by_id = addresses(report);
    for (id, value) in expected {
        assert_eq!(
            by_id.get(id.as_str()),
            Some(&value.as_str().expect("string address")),
            "{id}"
        );
    }
}

#[test]
fn secp256k1_reports_match_vectors() {
    let vector = vectors("secp256k1.json");
    let key = hex32(text(&vector, "key"));
    let wasm = &vector["wasm"];

    let report = report(&key, 0);
    assert_addresses(&report, wasm["derive_report"].as_object().expect("rows"));
    assert_eq!(
        text(&report, "wif_compressed"),
        text(wasm, "wif_compressed")
    );

    let public =
        derive::pubkey_report(text(&vector, "pubkey_compressed")).expect("public key report");
    let public: Value = serde_json::from_str(&public).expect("public key JSON");
    assert_addresses(
        &public,
        wasm["public_key_report"].as_object().expect("rows"),
    );
}

#[test]
fn ed25519_reports_match_vectors() {
    let vector = vectors("ed25519.json");

    for case_name in ["seed_1", "rfc8032_test1"] {
        let case = &vector[case_name];
        let seed = hex32(text(case, "seed"));
        let report = report(&seed, 1);

        assert_eq!(
            text(&report, "ed_pubkey"),
            text(case, "public"),
            "{case_name}"
        );
        let by_id = addresses(&report);
        for field in ["solana", "sui", "ton_w5"] {
            assert_eq!(
                by_id.get(field),
                Some(&text(case, field)),
                "{case_name} {field}"
            );
        }
    }
}

#[test]
fn keystore_frames_decrypt_to_the_vector_key() {
    let vector = vectors("keystore.json");

    for case in vector["cases"].as_array().expect("cases") {
        let salt = hex_bytes(text(case, "salt"));
        let iv = hex_bytes(text(case, "iv"));
        let ciphertext = hex_bytes(text(case, "ciphertext"));
        let mac = hex_bytes(text(case, "mac"));
        let request = keystore::Request {
            kdf: match text(case, "kdf") {
                "scrypt" => 0,
                "pbkdf2" => 1,
                other => panic!("unknown kdf {other}"),
            },
            n: case["n"].as_u64().expect("n") as u32,
            r: case["r"].as_u64().expect("r") as u32,
            p: case["p"].as_u64().expect("p") as u32,
            c: case["c"].as_u64().expect("c") as u32,
            dklen: case["dklen"].as_u64().expect("dklen") as u32,
            salt: &salt,
            iv: &iv,
            ciphertext: &ciphertext,
            mac: &mac,
            password: text(case, "password").as_bytes(),
        };

        let key = keystore::decrypt(&request).expect("keystore decrypts");
        assert_eq!(
            derive::hex(&key),
            text(case, "private_key"),
            "{}",
            text(case, "id")
        );

        let report = report(&key, 0);
        assert_eq!(
            addresses(&report).get("evm"),
            Some(&text(case, "ethereum")),
            "{}",
            text(case, "id")
        );
    }
}

#[test]
fn signing_vectors_reproduce() {
    let vector = vectors("signing.json");
    let mut session = Session::new();

    let eip191 = &vector["eip191"];
    assert_eq!(
        session.evm_sign_message(
            &hex32(text(eip191, "key")),
            text(eip191, "message").as_bytes()
        ),
        0
    );
    assert_eq!(result_text(&session), text(eip191, "signature"));

    let btc = &vector["btc_bip143_p2wpkh"];
    assert_eq!(session.btc_unsigned_tx(text(btc, "unsigned_request")), 0);
    assert_eq!(result_text(&session), text(btc, "unsigned_hex"));
    assert_eq!(session.btc_sign_tx(text(btc, "signed_request")), 0);
    assert_eq!(result_text(&session), text(btc, "signed_hex"));

    let tron = &vector["tron_transfer"];
    assert_eq!(session.tron_unsigned_tx(text(tron, "unsigned_request")), 0);
    let unsigned = result_json(&session);
    assert_eq!(text(&unsigned, "txID"), text(tron, "tx_id"));
    assert_eq!(text(&unsigned, "raw_data_hex"), text(tron, "raw_data_hex"));
    assert!(
        unsigned.get("signature").is_none(),
        "unsigned review has no signature"
    );

    assert_eq!(session.tron_sign_tx(text(tron, "signed_request")), 0);
    let signed = result_json(&session);
    assert_eq!(text(&signed, "txID"), text(tron, "tx_id"));
    assert_eq!(text(&signed, "raw_data_hex"), text(tron, "raw_data_hex"));
    assert_eq!(text(&signed, "signature"), text(tron, "signature"));
}

#[test]
fn scan_and_samples_blobs_reproduce() {
    let vector = vectors("scan.json");
    let job = &vector["job"];
    let mut session = Session::new();

    assert_eq!(
        session.set_job(
            job["mode"].as_u64().expect("mode") as u32,
            job["comp"].as_u64().expect("comp") as u32,
            text(job, "targets"),
        ),
        0
    );

    let scan = &vector["scan"];
    assert_eq!(
        session.scan(&scalar(text(scan, "start")), &scalar(text(scan, "end"))),
        0
    );
    assert_eq!(derive::hex(&session.result), text(scan, "result_hex"));

    let samples = &vector["samples"];
    let offsets: Vec<u32> = samples["offsets"]
        .as_array()
        .expect("offsets")
        .iter()
        .map(|value| value.as_u64().expect("offset") as u32)
        .collect();
    assert_eq!(
        session.samples(&scalar(text(samples, "start")), &offsets),
        0
    );
    assert_eq!(derive::hex(&session.result), text(samples, "result_hex"));
}

/// Last result buffer as text. `result` is private to the crate; this test
/// module is a descendant of that module and reads it without an ABI call.
fn result_text(session: &Session) -> &str {
    std::str::from_utf8(&session.result).expect("result is UTF-8")
}

fn result_json(session: &Session) -> Value {
    serde_json::from_str(result_text(session)).expect("result JSON")
}
