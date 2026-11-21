use std::fs::File;
use std::path::{Path, PathBuf};

use rotor::chain;
use rotor::checkpoint;
use rotor::cli::{CompMode, Config, Range, SearchMode, U256};
use rotor::engine;
use rotor::filter::TargetSet;
use rotor::point::Affine;
use rotor::scalar::Scalar;
use rotor::{base58, secp, secp::mul_g};

fn bitcoin() -> &'static chain::ChainDescriptor {
    chain::by_id("bitcoin").expect("bitcoin descriptor")
}

fn ethereum() -> &'static chain::ChainDescriptor {
    chain::by_id("ethereum").expect("ethereum descriptor")
}

fn temp_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rotor_engine_{tag}_{}_{nanos}.tmp",
        std::process::id()
    ))
}

/// Temp directory used as the checkpoint location; removed on drop.
struct TempDir(PathBuf);

impl TempDir {
    fn new(tag: &str) -> Self {
        let dir = temp_path(tag);
        std::fs::create_dir_all(&dir).expect("create temp dir");
        Self(dir)
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn config() -> Config {
    Config {
        threads: 1,
        display: 0,
        chain: bitcoin(),
        ..Config::default()
    }
}

fn hex(value: &str) -> U256 {
    U256::from_hex(value).expect("valid test hex")
}

fn range(start: &str, end: &str) -> Range {
    Range {
        start: hex(start),
        end: hex(end),
    }
}

fn output_text(path: &Path) -> String {
    std::fs::read_to_string(path).expect("output file should be readable")
}

fn decode_hex(text: &str) -> Vec<u8> {
    (0..text.len())
        .step_by(2)
        .map(|index| {
            u8::from_str_radix(&text[index..index + 2], 16).expect("valid hexadecimal test vector")
        })
        .collect()
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn address_config(address: &str, start: &str, end: &str, output: &Path) -> Config {
    let mut config = config();
    config.mode = Some(SearchMode::Address);
    config.range = Some(range(start, end));
    config.operands = vec![address.to_owned()];
    config.output_file = output.to_string_lossy().into_owned();
    config
}

#[test]
fn readme_range_finds_documented_key() {
    let output = temp_path("readme");
    let config = address_config(
        "14iXhn8bGajVWegZHJ18vJLHhntcpL4dex",
        "1757756A90",
        "1757756A95",
        &output,
    );

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);

    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 6);
    assert!(
        text.contains("Priv (HEX): 1757756A93"),
        "missing private key block:\n{text}"
    );
    assert!(
        text.contains(
            "PubK (HEX): 027D2C03C3EF0AEC70F2C7E1E75454A5DFDD0E1ADEA670C1B3A4643C48AD0F1255"
        ),
        "missing public key block:\n{text}"
    );
    assert!(
        text.contains("Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9NRuiZFAX6XciCX"),
        "missing WIF block:\n{text}"
    );
}

#[test]
fn key_one_compressed_address_is_found() {
    let output = temp_path("key1_compressed");
    let config = address_config("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "1", "2", &output);

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);

    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 2);
    assert!(
        text.contains("Priv (HEX): 1\n"),
        "missing trimmed hexadecimal key:\n{text}"
    );
}

#[test]
fn secp_hash160_chains_find_key_one_with_chain_display() {
    // Published key-1 fixtures: addresses from `tests/chain.rs` (site WASM
    // report), WIFs from the descriptor's version byte. XRP defines no WIF.
    let fixtures: &[(&str, &str, Option<&str>)] = &[
        (
            "bitcoin",
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
            Some("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"),
        ),
        (
            "litecoin",
            "LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ",
            Some("T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjV"),
        ),
        (
            "dogecoin",
            "DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE",
            Some("QNcdLVw8fHkixm6NNyN6nVwxKek4u7qrioRbQmjxac5TVoTtZuot"),
        ),
        (
            "bitcoin-cash",
            "1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
            Some("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"),
        ),
        (
            "zcash",
            "t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs",
            Some("KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn"),
        ),
        ("xrp", "rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH", None),
    ];

    for (id, address, wif) in fixtures {
        let output = temp_path(id);
        let mut config = address_config(address, "1", "2", &output);
        config.chain = chain::by_id(id).expect("known chain");

        let outcome = engine::run(&config).expect("search should run");
        let text = output_text(&output);
        let _ = std::fs::remove_file(&output);

        assert_eq!(outcome.found, 1, "{id}");
        assert_eq!(outcome.scanned, 2, "{id}");
        assert!(
            text.contains(&format!("PubAddress: {address}")),
            "{id} chain display:\n{text}"
        );
        assert!(text.contains("Priv (HEX): 1\n"), "{id}:\n{text}");
        match wif {
            Some(wif) => assert!(
                text.contains(&format!("Priv (WIF): {wif}")),
                "{id} WIF:\n{text}"
            ),
            None => assert!(
                !text.contains("Priv (WIF)"),
                "{id} has no WIF in its descriptor:\n{text}"
            ),
        }
    }
}

#[test]
fn litecoin_multi_address_mode_uses_chain_encoding() {
    let hash = secp::hash160(&mul_g(&Scalar::from_u64(1)), true);
    let targets = temp_path("ltc_targets");
    std::fs::write(&targets, hash).expect("write target file");
    let output = temp_path("ltc_multi");

    let mut config = config();
    config.chain = chain::by_id("litecoin").expect("litecoin descriptor");
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("1", "2"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&targets);

    assert_eq!(outcome.found, 1);
    assert!(
        text.contains("PubAddress: LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ"),
        "missing Litecoin display:\n{text}"
    );
    assert!(
        text.contains("Priv (WIF): T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjV"),
        "missing Litecoin WIF:\n{text}"
    );
}

#[test]
fn key_one_uncompressed_address_is_found() {
    let output = temp_path("key1_uncompressed");
    let mut config = address_config("1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm", "1", "2", &output);
    config.comp_mode = CompMode::Uncompressed;

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);

    assert_eq!(outcome.found, 1);
    assert!(
        text.contains("PubAddress: 1EHNa6Q4Jz2uvNExL497mE43ikXhwF6kZm"),
        "missing uncompressed address:\n{text}"
    );
}

#[test]
fn multi_address_mode_finds_key_five_from_bin_file() {
    let hash = decode_hex("4747e8746cddb33b0f7f95a90f89f89fb387cbb6");
    let set = TargetSet::from_records(std::slice::from_ref(&hash), 20);
    assert!(set.contains(&hash));

    let targets = temp_path("targets");
    std::fs::write(&targets, &set.records()[0]).expect("write target file");
    let output = temp_path("multi");
    let mut config = config();
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("4", "6"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&targets);

    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 3);
    assert!(
        text.contains("Priv (HEX): 5\n"),
        "missing key 5 block:\n{text}"
    );
    assert!(
        text.contains("PubAddress: 17Vu7st1U1KwymUKU4jJheHHGRVNqrcfLD"),
        "missing multi-address block:\n{text}"
    );
}

/// Compressed BTC P2PKH address for a private key.
fn btc_address(key: u64) -> String {
    let hash = secp::hash160(&mul_g(&Scalar::from_u64(key)), true);
    base58::address_from_hash160(&hash, true)
}

#[test]
fn multi_address_mode_reads_text_target_list() {
    let targets = temp_path("addresses_txt");
    let list = format!("{}\n{}\n", btc_address(5), btc_address(7));
    std::fs::write(&targets, list).expect("write text target file");

    let output = temp_path("multi_text");
    let mut config = config();
    config.mode = Some(SearchMode::Addresses);
    config.targets_text = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("4", "8"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&targets);

    assert_eq!(outcome.found, 2);
    assert_eq!(outcome.scanned, 5);
    assert!(
        text.contains("Priv (HEX): 5\n"),
        "missing key 5 block:\n{text}"
    );
    assert!(
        text.contains("Priv (HEX): 7\n"),
        "missing key 7 block:\n{text}"
    );
}

#[test]
fn missing_range_is_rejected() {
    let mut config = config();
    config.mode = Some(SearchMode::Address);
    config.operands = vec!["14iXhn8bGajVWegZHJ18vJLHhntcpL4dex".to_owned()];

    let err = engine::run(&config).expect_err("missing range must fail");
    assert!(err.contains("--range"), "unexpected error: {err}");
}

#[test]
fn range_end_at_or_above_curve_order_is_rejected() {
    let mut config = config();
    config.mode = Some(SearchMode::Address);
    config.operands = vec!["14iXhn8bGajVWegZHJ18vJLHhntcpL4dex".to_owned()];
    config.range = Some(range(
        "1",
        "FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
    ));

    let err = engine::run(&config).expect_err("end == n must fail");
    assert!(err.contains("curve order"), "unexpected error: {err}");
}

#[test]
fn xpoint_mode_finds_key_seven() {
    let x = mul_g(&Scalar::from_u64(7)).x.to_bytes_be();

    let output = temp_path("xpoint_single");
    let mut config = config();
    config.mode = Some(SearchMode::XPoint);
    config.range = Some(range("6", "8"));
    config.operands = vec![hex_upper(&x)];
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("xpoint search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);

    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 3);
    assert!(
        text.contains("Priv (HEX): 7\n"),
        "missing xpoint key block:\n{text}"
    );
}

#[test]
fn multi_xpoint_mode_finds_key_nine_from_bin_file() {
    let x = mul_g(&Scalar::from_u64(9)).x.to_bytes_be();
    let targets = temp_path("xpoints");
    std::fs::write(&targets, x).expect("write xpoints file");

    let output = temp_path("xpoints_multi");
    let mut config = config();
    config.mode = Some(SearchMode::XPoints);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("8", "A"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("multi xpoint search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&targets);

    assert_eq!(outcome.found, 1);
    assert_eq!(outcome.scanned, 3);
    assert!(
        text.contains("Priv (HEX): 9\n"),
        "missing multi-xpoint key block:\n{text}"
    );
}

#[test]
fn eth_single_address_finds_key_one() {
    let output = temp_path("eth_single");
    let mut config = config();
    config.chain = ethereum();
    config.mode = Some(SearchMode::Address);
    config.range = Some(range("1", "2"));
    config.operands = vec!["0x7e5f4552091a69125d5dfcb7b8c2659029395bdf".to_owned()];
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("ETH search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);

    assert_eq!(outcome.found, 1);
    assert!(
        text.contains("PubAddress: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
        "missing ETH address block:\n{text}"
    );
    assert!(
        text.contains("Priv (HEX): 1\n"),
        "missing ETH private key:\n{text}"
    );
    assert!(
        !text.contains("Priv (WIF)"),
        "ETH output must not contain a WIF line:\n{text}"
    );
    assert!(
        text.contains(
            "PubK (HEX): 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"
        ),
        "missing ETH public key:\n{text}"
    );
}

#[test]
fn eth_multi_address_finds_key_one_from_bin_file() {
    let hash = secp::eth_address(&mul_g(&Scalar::from_u64(1)));
    let targets = temp_path("eth_targets");
    std::fs::write(&targets, hash).expect("write ETH target file");

    let output = temp_path("eth_multi");
    let mut config = config();
    config.chain = ethereum();
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("1", "2"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("ETH multi search should run");
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    let _ = std::fs::remove_file(&targets);

    assert_eq!(outcome.found, 1);
    assert!(
        text.contains("Priv (HEX): 1\n"),
        "missing ETH multi key block:\n{text}"
    );
    assert!(
        text.contains("PubAddress: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf"),
        "missing ETH multi address:\n{text}"
    );
}

#[test]
fn found_txt_writes_chain_specific_secrets_only_where_defined() {
    let key = Scalar::from_u64(1);
    let point = mul_g(&key);

    // Exact blocks the writer must produce for key 1, compressed. Addresses
    // are the site fixtures; LTC/DOGE WIFs are the published vectors from
    // `apps/site/key-tools-test.mjs`. BCH and ZEC share Bitcoin's 0x80 WIF
    // version byte, XRP/ETH/TRON define no WIF version at all.
    let cases: &[(&str, &[&str])] = &[
        (
            "bitcoin",
            &[
                "PubAddress: 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                "Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "litecoin",
            &[
                "PubAddress: LVuDpNCSSj6pQ7t9Pv6d6sUkLKoqDEVUnJ",
                "Priv (WIF): T33ydQRKp4FCW5LCLLUB7deioUMoveiwekdwUwyfRDeGZm76aUjV",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "dogecoin",
            &[
                "PubAddress: DFpN6QqFfUm3gKNaxN6tNcab1FArL9cZLE",
                "Priv (WIF): QNcdLVw8fHkixm6NNyN6nVwxKek4u7qrioRbQmjxac5TVoTtZuot",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "bitcoin-cash",
            &[
                "PubAddress: 1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH",
                "Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "zcash",
            &[
                "PubAddress: t1UYsZVJkLPeMjxEtACvSxfWuNmddpWfxzs",
                "Priv (WIF): KwDiBf89QgGbjEhKnhXJuH7LrciVrZi3qYjgd9M7rFU73sVHnoWn",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "xrp",
            &[
                "PubAddress: rBgGZ9tc4him9KBzD8fKFiQz3fSZpaSwMH",
                "Priv (HEX): 1",
                "PubK (HEX): 0279BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798",
            ],
        ),
        (
            "ethereum",
            &[
                "PubAddress: 0x7e5f4552091a69125d5dfcb7b8c2659029395bdf",
                "Priv (HEX): 1",
                "PubK (HEX): 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798\
                 483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8",
            ],
        ),
        (
            "tron",
            &[
                "PubAddress: TMVQGm1qAQYVdetCeGRRkTWYYrLXuHK2HC",
                "Priv (HEX): 1",
                "PubK (HEX): 79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798\
                 483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8",
            ],
        ),
    ];

    for (id, lines) in cases {
        let expected = format!("{}\n{}\n", lines.join("\n"), "=".repeat(86));
        assert_eq!(write_hit(id, &key, &point), expected, "{id}");
    }
}

/// Writes one hit through the public writer and returns the file contents.
fn write_hit(id: &str, key: &Scalar, point: &Affine) -> String {
    let output = temp_path(&format!("found_{id}"));
    let mut file = File::create(&output).expect("create Found.txt");
    let descriptor = chain::by_id(id).expect("known chain");
    engine::emit_hit(&mut file, key, point, true, descriptor).expect("hit should be written");
    drop(file);
    let text = output_text(&output);
    let _ = std::fs::remove_file(&output);
    text
}

/// Base58 token of a compressed mainnet WIF's shape/length.
fn looks_like_wif_token(text: &str) -> bool {
    const BASE58: &str = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    text.split_whitespace().any(|token| {
        (token.len() == 51 || token.len() == 52) && token.chars().all(|c| BASE58.contains(c))
    })
}

#[test]
fn evm_and_tron_hits_contain_no_wif_shaped_string() {
    let key = Scalar::from_u64(1);
    let point = mul_g(&key);

    for id in ["ethereum", "tron"] {
        let text = write_hit(id, &key, &point);
        assert!(!text.contains("Priv (WIF)"), "{id}:\n{text}");
        assert!(
            !looks_like_wif_token(&text),
            "{id} wrote a WIF-shaped token:\n{text}"
        );
    }

    // The detector is not vacuous: a WIF chain still trips it.
    assert!(looks_like_wif_token(&write_hit("bitcoin", &key, &point)));
}

#[test]
fn a_chain_without_an_implemented_path_cannot_write_a_hit() {
    let key = Scalar::from_u64(1);
    let point = mul_g(&key);
    let output = temp_path("found_unimplemented");
    let mut file = File::create(&output).expect("create Found.txt");

    // A secp-hash160 descriptor cannot encode an EVM address.
    let unsupported = chain::ChainDescriptor {
        id: "synthetic",
        name: "Synthetic",
        family: chain::Family::SecpHash160,
        curve: chain::Curve::Secp256k1,
        encoding: chain::AddressEncoding::EvmHex,
        hd_path: None,
        wif_version: Some(0x80),
        explorer: "",
    };
    assert!(
        engine::emit_hit(&mut file, &key, &point, true, &unsupported).is_err(),
        "an unimplemented encoding must not write a block"
    );

    // TON's CPU search is not implemented for secp hits.
    let ton = chain::by_id("ton").expect("known chain");
    assert!(engine::emit_hit(&mut file, &key, &point, true, ton).is_err());

    drop(file);
    assert_eq!(output_text(&output), "", "a failed hit must write nothing");
    let _ = std::fs::remove_file(&output);
}

#[test]
fn resume_continue_file_shifts_the_start() {
    let dir = TempDir::new("resume_shift");
    let output = dir.path().join("Found.txt");
    let mut config = address_config("17Vu7st1U1KwymUKU4jJheHHGRVNqrcfLD", "1", "A", &output);
    config.next = 1;

    checkpoint::write_continue(
        &dir.path().join("Rotor-Cuda_Continue.bat"),
        "rotor.exe -r 1:A -n 1",
        5,
    )
    .expect("write checkpoint");

    // The checkpoint moves the start to 6, so key 5 is not scanned again.
    let outcome = engine::run_in(&config, Some(dir.path())).expect("search should run");
    assert_eq!(outcome.found, 0);
    assert_eq!(outcome.scanned, 5);
}

#[test]
fn zero_count_checkpoint_does_not_shift() {
    let dir = TempDir::new("resume_zero");
    let output = dir.path().join("Found.txt");
    let mut config = address_config("17Vu7st1U1KwymUKU4jJheHHGRVNqrcfLD", "1", "A", &output);
    config.next = 1;

    checkpoint::write_continue(&dir.path().join("Rotor-Cuda_Continue.bat"), "rotor.exe", 0)
        .expect("write checkpoint");

    let outcome = engine::run_in(&config, Some(dir.path())).expect("search should run");
    let text = output_text(&output);
    assert_eq!(outcome.found, 1);
    assert!(text.contains("Priv (HEX): 5\n"), "missing key 5:\n{text}");
    // A zero count means "nothing scanned yet", so START.bat is still written.
    assert!(dir.path().join("Rotor-Cuda_START.bat").exists());
}

#[test]
fn start_file_is_written_only_in_checkpoint_mode() {
    let dir = TempDir::new("start_on");
    let output = dir.path().join("Found.txt");
    let mut config = address_config("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "1", "2", &output);
    config.next = 1;
    engine::run_in(&config, Some(dir.path())).expect("search should run");

    let start_path = dir.path().join("Rotor-Cuda_START.bat");
    let text = std::fs::read_to_string(&start_path).expect("START.bat should exist");
    assert!(
        text.starts_with(":loop \n"),
        "unexpected START.bat:\n{text}"
    );
    assert!(
        text.contains(" \ngoto :loop \n\n"),
        "unexpected START.bat:\n{text}"
    );
    assert!(!dir.path().join("Rotor-Cuda_Continue.bat").exists());

    let dir = TempDir::new("start_off");
    let output = dir.path().join("Found.txt");
    let config = address_config("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "1", "2", &output);
    engine::run_in(&config, Some(dir.path())).expect("search should run");
    assert!(!dir.path().join("Rotor-Cuda_START.bat").exists());
}

/// Writes compressed hash160 records for the given private keys.
fn write_hash160_targets(path: &Path, keys: &[u64]) {
    let mut bytes = Vec::with_capacity(keys.len() * 20);
    for key in keys {
        bytes.extend_from_slice(&secp::hash160(&mul_g(&Scalar::from_u64(*key)), true));
    }
    std::fs::write(path, bytes).expect("write target file");
}

#[test]
fn per_chunk_extension_resumes_each_worker() {
    let dir = TempDir::new("chunk_resume");
    let targets = dir.path().join("targets.bin");
    write_hash160_targets(&targets, &[5, 6, 9]);
    let output = dir.path().join("Found.txt");
    let mut config = config();
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("1", "A"));
    config.output_file = output.to_string_lossy().into_owned();
    config.threads = 2;
    config.next = 1;

    checkpoint::write_continue_with_chunks(
        &dir.path().join("Rotor-Cuda_Continue.bat"),
        "rotor.exe -r 1:A -n 1 -t 2",
        10,
        &[5, 5],
    )
    .expect("write checkpoint");

    // Two chunks of five: worker 0 resumes at 6, worker 1 is done.
    let outcome = engine::run_in(&config, Some(dir.path())).expect("search should run");
    let text = output_text(&output);
    assert_eq!(outcome.found, 2);
    assert!(text.contains("Priv (HEX): 6\n"), "missing key 6:\n{text}");
    assert!(text.contains("Priv (HEX): 9\n"), "missing key 9:\n{text}");
    assert!(
        !text.contains("Priv (HEX): 5\n"),
        "key 5 must not be rescanned:\n{text}"
    );
}

#[test]
fn old_format_checkpoint_shifts_each_chunk() {
    let dir = TempDir::new("old_fallback");
    let targets = dir.path().join("targets.bin");
    write_hash160_targets(&targets, &[2, 3, 4, 8]);
    let output = dir.path().join("Found.txt");
    let mut config = config();
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("1", "A"));
    config.output_file = output.to_string_lossy().into_owned();
    config.threads = 2;
    config.next = 1;

    // No `chunks:` extension: C++ fallback shifts each chunk by 4 / 2 = 2.
    checkpoint::write_continue(
        &dir.path().join("Rotor-Cuda_Continue.bat"),
        "rotor.exe -r 1:A -n 1 -t 2",
        4,
    )
    .expect("write checkpoint");

    let outcome = engine::run_in(&config, Some(dir.path())).expect("search should run");
    let text = output_text(&output);
    assert_eq!(outcome.found, 3, "expected keys 3, 4 and 8:\n{text}");
    assert!(text.contains("Priv (HEX): 3\n"), "missing key 3:\n{text}");
    assert!(text.contains("Priv (HEX): 4\n"), "missing key 4:\n{text}");
    assert!(text.contains("Priv (HEX): 8\n"), "missing key 8:\n{text}");
    assert!(
        !text.contains("Priv (HEX): 2\n"),
        "key 2 must not be scanned:\n{text}"
    );
}

#[test]
fn multi_mode_stops_after_the_target_set_is_found() {
    let dir = TempDir::new("stop_after");
    let targets = dir.path().join("targets.bin");
    write_hash160_targets(&targets, &[1]);
    let output = dir.path().join("Found.txt");
    let mut config = config();
    config.mode = Some(SearchMode::Addresses);
    config.input_file = Some(targets.to_string_lossy().into_owned());
    config.range = Some(range("1", "2710"));
    config.output_file = output.to_string_lossy().into_owned();

    let outcome = engine::run(&config).expect("search should run");
    assert_eq!(outcome.found, 1);
    assert_eq!(
        outcome.scanned, 2048,
        "the worker should stop after the batch that found the only target"
    );
}

#[test]
fn multi_modes_reject_positional_operands() {
    let mut config = config();
    config.range = Some(range("1", "2"));
    config.input_file = Some("unused.bin".to_owned());
    config.operands = vec!["1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH".to_owned()];

    config.mode = Some(SearchMode::Addresses);
    let err = engine::run(&config).expect_err("addresses mode must reject an operand");
    assert_eq!(
        err,
        "Wrong search mode provided for multiple addresses or xpoints"
    );

    config.mode = Some(SearchMode::XPoints);
    let err = engine::run(&config).expect_err("xpoints mode must reject an operand");
    assert_eq!(
        err,
        "Wrong search mode provided for multiple addresses or xpoints"
    );
}

#[test]
fn zero_threads_is_rejected() {
    let output = temp_path("no_threads");
    let mut config = address_config("1BgGZ9tcN4rm9KBzDn7KprQz87SZ26SAMH", "1", "2", &output);
    config.threads = 0;

    let err = engine::run(&config).expect_err("zero threads must fail");
    assert_eq!(err, "no CPU threads requested");
}
