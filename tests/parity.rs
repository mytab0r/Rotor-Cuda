//! P0 behaviour-parity baseline: desktop vectors.
//!
//! This test recomputes the desktop core's output for every fixed key in
//! `tests/parity/keys.json` and every chain in `data/chains.json`, and compares
//! it with the committed `tests/parity/desktop-vectors.json` baseline. The wasm
//! side of the same baseline lives in `tests/parity/wasm-vectors.json` and is
//! produced by `tests/parity/generate-wasm.mjs`; `tests/parity/parity-test.mjs`
//! compares the two and fails on any mismatch that is not explicitly
//! allowlisted.
//!
//! Regenerate after an intentional desktop change:
//!
//! ```sh
//! ROTOR_PARITY_WRITE=1 cargo test --release --test parity
//! node tests/parity/generate-wasm.mjs
//! node tests/parity/parity-test.mjs
//! ```
//!
//! This is a test-only fixture generator: it adds no production behaviour and
//! writes nothing unless `ROTOR_PARITY_WRITE=1`.

use std::fs;
use std::path::{Path, PathBuf};

use rotor::address::ton::{TonWalletVersion, ton_addresses};
use rotor::chain::{self, ChainDescriptor, KeyMaterial};
use rotor::mnemonic;
use rotor::scalar::Scalar;
use rotor::secp;
use serde_json::{Value, json};

fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join(relative)
}

fn read_json(relative: &str) -> Value {
    let path = repo_path(relative);
    let text = fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("cannot read {}: {error}", path.display()));
    serde_json::from_str(&text)
        .unwrap_or_else(|error| panic!("cannot parse {}: {error}", path.display()))
}

fn hex_to_32(text: &str) -> [u8; 32] {
    assert_eq!(text.len(), 64, "expected a 32-byte hex string: {text}");
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&text[index * 2..index * 2 + 2], 16)
            .unwrap_or_else(|_| panic!("invalid hex in {text}"));
    }
    bytes
}

fn hex_lower(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        out.push_str(&format!("{byte:02x}"));
    }
    out
}

struct ChainEntry {
    slug: String,
    family: String,
    testnet: bool,
}

fn data_chains() -> Vec<ChainEntry> {
    let data = read_json("data/chains.json");
    data["chains"]
        .as_array()
        .expect("data/chains.json chains array")
        .iter()
        .map(|chain| ChainEntry {
            slug: chain["slug"].as_str().expect("chain slug").to_owned(),
            family: chain["family"].as_str().expect("chain family").to_owned(),
            testnet: chain["testnet"].as_bool().unwrap_or(false),
        })
        .collect()
}

fn curve_family(family: &str) -> &'static str {
    match family {
        "solana" | "sui" | "ton" => "ed25519",
        _ => "secp256k1",
    }
}

/// One desktop vector for a supported mainnet chain.
fn desktop_vector(
    key_id: &str,
    key_kind: &str,
    material: &[u8; 32],
    descriptor: &ChainDescriptor,
    format: &str,
) -> Value {
    let mut key_bytes = *material;
    let mut key_source = "direct-private-key";
    let mut path_applied = false;
    let path = descriptor.hd_path;

    if descriptor.curve == chain::Curve::Secp256k1 {
        if key_kind == "seed" {
            let master = mnemonic::master_from_seed(material)
                .unwrap_or_else(|error| panic!("{key_id}/{}: {error}", descriptor.id));
            let path_text = descriptor
                .hd_path
                .unwrap_or_else(|| panic!("{} has no HD path", descriptor.id));
            let derived = mnemonic::derive_path(&master, path_text)
                .unwrap_or_else(|error| panic!("{key_id}/{}: {error}", descriptor.id));
            key_bytes = derived.key.to_bytes_be();
            key_source = "bip32-path";
            path_applied = true;
        }
    } else if key_kind == "seed" {
        key_source = "ed25519-seed";
    } else {
        key_source = "raw-32-byte-ed25519-seed";
    }

    let derived = if descriptor.curve == chain::Curve::Secp256k1 {
        let scalar = Scalar::from_bytes_be(&key_bytes)
            .unwrap_or_else(|| panic!("{key_id}/{}: private key is not below n", descriptor.id));
        let point = secp::mul_g(&scalar);
        descriptor
            .derive(KeyMaterial::Secp {
                key: &scalar,
                point: &point,
                compressed: true,
            })
            .unwrap_or_else(|error| panic!("{key_id}/{}: {error}", descriptor.id))
    } else {
        descriptor
            .derive(KeyMaterial::Seed(&key_bytes))
            .unwrap_or_else(|error| panic!("{key_id}/{}: {error}", descriptor.id))
    };

    // TON has no single canonical address: the wallet contract version selects
    // the StateInit, so the vector carries the whole version set. Every other
    // chain keeps one entry under its chain-map format.
    let mut addresses = serde_json::Map::new();
    if descriptor.family == chain::Family::Ton {
        let public = hex_to_32(&derived.public_hex);
        for (version, address) in ton_addresses(&public)
            .unwrap_or_else(|error| panic!("{key_id}/{}: {error}", descriptor.id))
        {
            let id = match version {
                TonWalletVersion::V3R2 => "ton_v3r2",
                TonWalletVersion::V4R2 => "ton_v4r2",
                TonWalletVersion::W5 => "ton_w5",
                other => panic!(
                    "{key_id}/{}: unsupported TON wallet version {} in the parity vector",
                    descriptor.id,
                    other.label()
                ),
            };
            addresses.insert(id.to_owned(), Value::String(address.address));
        }
    } else {
        addresses.insert(format.to_owned(), Value::String(derived.address.clone()));
    }

    json!({
        "key_id": key_id,
        "chain": descriptor.id,
        "supported": true,
        "curve": descriptor.curve.label(),
        "family": descriptor.family.label(),
        "key_kind": key_kind,
        "key_source": key_source,
        "path": path,
        "path_applied": path_applied,
        "input_material": hex_lower(material),
        "private_key": hex_lower(&key_bytes),
        "public_key": derived.public_hex.to_ascii_lowercase(),
        "address": derived.address,
        "addresses": addresses,
        "format": format,
        "wif": derived.secret,
        "wif_version": descriptor.wif_version,
    })
}

fn build_vectors() -> Value {
    let keys = read_json("tests/parity/keys.json");
    let map = read_json("tests/parity/chain-map.json");
    let chains = data_chains();
    let mut vectors = Vec::new();

    for key in keys["keys"].as_array().expect("keys array") {
        let key_id = key["id"].as_str().expect("key id");
        let key_kind = key["kind"].as_str().expect("key kind");
        let material = hex_to_32(key["material"].as_str().expect("key material"));

        for chain_entry in &chains {
            let mapping = &map["chains"][&chain_entry.slug];
            let format = mapping["format"]
                .as_str()
                .unwrap_or_else(|| panic!("{} has no chain-map format", chain_entry.slug));

            if chain_entry.testnet || mapping["desktop"].as_bool() == Some(false) {
                vectors.push(json!({
                    "key_id": key_id,
                    "chain": chain_entry.slug,
                    "supported": false,
                    "reason": "the desktop chain descriptor table registers mainnet chains only",
                    "curve": curve_family(&chain_entry.family),
                    "key_kind": key_kind,
                    "input_material": hex_lower(&material),
                    "format": format,
                }));
                continue;
            }

            let descriptor = chain::by_id(&chain_entry.slug).unwrap_or_else(|| {
                panic!(
                    "{} is in data/chains.json but not in the desktop chain table",
                    chain_entry.slug
                )
            });
            vectors.push(desktop_vector(
                key_id, key_kind, &material, descriptor, format,
            ));
        }
    }

    let chain_meta: Vec<Value> = chains
        .iter()
        .map(|chain| {
            json!({
                "slug": chain.slug,
                "family": chain.family,
                "testnet": chain.testnet,
            })
        })
        .collect();

    json!({
        "schema": 1,
        "generated_by": "cargo test --release --test parity (ROTOR_PARITY_WRITE=1)",
        "keys": keys["keys"],
        "chains": chain_meta,
        "vectors": vectors,
    })
}

fn first_difference(live: &Value, golden: &Value) -> String {
    let live_vectors = live["vectors"].as_array().expect("live vectors");
    let golden_vectors = golden["vectors"].as_array().expect("golden vectors");
    if live_vectors.len() != golden_vectors.len() {
        return format!(
            "vector count differs: live={} golden={}",
            live_vectors.len(),
            golden_vectors.len()
        );
    }
    for (index, (live_vector, golden_vector)) in
        live_vectors.iter().zip(golden_vectors.iter()).enumerate()
    {
        if live_vector == golden_vector {
            continue;
        }
        let name = format!(
            "{}/{}",
            golden_vector["key_id"].as_str().unwrap_or("?"),
            golden_vector["chain"].as_str().unwrap_or("?")
        );
        let mut fields = Vec::new();
        if let (Some(live_object), Some(golden_object)) =
            (live_vector.as_object(), golden_vector.as_object())
        {
            let mut names: Vec<&String> = live_object.keys().collect();
            for name in golden_object.keys() {
                if !live_object.contains_key(name) {
                    names.push(name);
                }
            }
            names.sort();
            names.dedup();
            for field in names {
                if live_object.get(field) != golden_object.get(field) {
                    fields.push(format!(
                        "{field}: live={} golden={}",
                        live_object
                            .get(field)
                            .map_or_else(|| "<missing>".to_owned(), Value::to_string),
                        golden_object
                            .get(field)
                            .map_or_else(|| "<missing>".to_owned(), Value::to_string),
                    ));
                }
            }
        }
        return format!("vector {index} ({name}) differs: {}", fields.join("; "));
    }
    for field in ["schema", "keys", "chains"] {
        if live[field] != golden[field] {
            return format!("metadata field {field} differs");
        }
    }
    "objects differ outside vectors and metadata".to_owned()
}

#[test]
fn desktop_vectors_match_the_committed_baseline() {
    let live = build_vectors();
    let path = repo_path("tests/parity/desktop-vectors.json");

    if std::env::var("ROTOR_PARITY_WRITE").ok().as_deref() == Some("1") {
        let text = serde_json::to_string_pretty(&live).expect("serialize vectors");
        fs::write(&path, format!("{text}\n")).expect("write desktop-vectors.json");
        eprintln!("wrote {}", path.display());
        return;
    }

    let text = fs::read_to_string(&path).unwrap_or_else(|error| {
        panic!(
            "cannot read {}: {error}; run ROTOR_PARITY_WRITE=1 cargo test --release --test parity",
            path.display()
        )
    });
    let golden: Value = serde_json::from_str(&text).expect("parse desktop-vectors.json");
    assert!(
        live == golden,
        "desktop parity baseline drifted: {}\nRegenerate intentionally with \
         ROTOR_PARITY_WRITE=1 cargo test --release --test parity and review the diff.",
        first_difference(&live, &golden)
    );

    let vectors = live["vectors"].as_array().expect("vectors");
    let supported = vectors
        .iter()
        .filter(|vector| vector["supported"] == Value::Bool(true))
        .count();
    let skipped = vectors.len() - supported;
    assert_eq!(
        live["chains"].as_array().expect("chains").len(),
        data_chains().len(),
        "the fixture must cover every chain in data/chains.json"
    );
    eprintln!(
        "desktop parity baseline: {supported} supported vectors, {skipped} testnet/skipped, \
         {} chains",
        live["chains"].as_array().expect("chains").len()
    );
}
