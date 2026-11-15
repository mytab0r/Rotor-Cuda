use std::path::{Path, PathBuf};

use rotor::checkpoint;
use rotor::cli::{Coin, CompMode, Config, Range, SearchMode, U256};
use rotor::engine;
use rotor::filter::TargetSet;
use rotor::scalar::Scalar;
use rotor::{secp, secp::mul_g};

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
        coin: Coin::Btc,
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
    config.coin = Coin::Eth;
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
    config.coin = Coin::Eth;
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
