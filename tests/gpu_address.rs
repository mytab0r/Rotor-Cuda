//! CPU/GPU address and xpoint search equivalence. Requires `--features gpu`
//! and a CUDA device; without a device the fixtures print a skip line, while
//! the no-device error path is always checked.

#![cfg(feature = "gpu")]

use std::path::{Path, PathBuf};

use rotor::base58;
use rotor::cli::{Coin, CompMode, Config, Range, SearchMode, U256};
use rotor::engine;
use rotor::gpu_search;
use rotor::scalar::Scalar;
use rotor::secp;

fn temp_path(tag: &str) -> PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rotor_gpu_addr_{tag}_{}_{nanos}.txt",
        std::process::id()
    ))
}

fn has_device() -> bool {
    if rotor::gpu::device_count().unwrap_or(0) == 0 {
        eprintln!("skipping: no CUDA device");
        return false;
    }
    true
}

fn config(mode: SearchMode, coin: Coin, comp: CompMode, target: String, output: &Path) -> Config {
    let start = U256::from_u64(0x1F2E_3D4C_5B6A - 0x400);
    let end = U256::from_u64(0x1F2E_3D4C_5B6A + 0x400);
    Config {
        gpu: true,
        mode: Some(mode),
        coin,
        comp_mode: comp,
        range: Some(Range { start, end }),
        operands: vec![target],
        input_file: None,
        output_file: output.display().to_string(),
        gpu_ids: vec![0],
        grid_size: vec![1, 128],
        display: 0,
        ..Config::default()
    }
}

fn private_keys(path: &Path) -> Vec<String> {
    std::fs::read_to_string(path)
        .unwrap_or_default()
        .lines()
        .filter_map(|line| line.strip_prefix("Priv (HEX): "))
        .map(str::to_owned)
        .collect()
}

fn hex_lower(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[test]
fn cpu_and_gpu_find_the_same_btc_key() {
    if !has_device() {
        return;
    }
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let hash = secp::hash160(&secp::mul_g(&k), true);

    let cpu_out = temp_path("btc_cpu");
    let gpu_out = temp_path("btc_gpu");
    let address = base58::address_from_hash160(&hash, true);

    let cpu_config = config(
        SearchMode::Address,
        Coin::Btc,
        CompMode::Compressed,
        address.clone(),
        &cpu_out,
    );
    let gpu_config = config(
        SearchMode::Address,
        Coin::Btc,
        CompMode::Compressed,
        address,
        &gpu_out,
    );

    engine::run(&cpu_config).expect("CPU search");
    gpu_search::run(&gpu_config).expect("GPU search");

    let cpu = private_keys(&cpu_out);
    let gpu = private_keys(&gpu_out);
    let _ = std::fs::remove_file(&cpu_out);
    let _ = std::fs::remove_file(&gpu_out);

    assert_eq!(cpu.first().map(String::as_str), Some("1F2E3D4C5B6A"));
    assert_eq!(gpu, cpu, "GPU and CPU must report the same private key");
}

#[test]
fn cpu_and_gpu_find_the_same_eth_key() {
    if !has_device() {
        return;
    }
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let address = format!("0x{}", hex_lower(&secp::eth_address(&secp::mul_g(&k))));

    let cpu_out = temp_path("eth_cpu");
    let gpu_out = temp_path("eth_gpu");
    let cpu_config = config(
        SearchMode::Address,
        Coin::Eth,
        CompMode::Uncompressed,
        address.clone(),
        &cpu_out,
    );
    let gpu_config = config(
        SearchMode::Address,
        Coin::Eth,
        CompMode::Uncompressed,
        address,
        &gpu_out,
    );

    engine::run(&cpu_config).expect("CPU search");
    gpu_search::run(&gpu_config).expect("GPU search");

    let cpu = private_keys(&cpu_out);
    let gpu = private_keys(&gpu_out);
    let _ = std::fs::remove_file(&cpu_out);
    let _ = std::fs::remove_file(&gpu_out);

    assert_eq!(cpu.first().map(String::as_str), Some("1F2E3D4C5B6A"));
    assert_eq!(gpu, cpu, "GPU and CPU must report the same private key");
}

#[test]
fn cpu_and_gpu_agree_for_uncompressed_and_both_modes() {
    if !has_device() {
        return;
    }
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let point = secp::mul_g(&k);

    for (comp, compressed) in [(CompMode::Uncompressed, false), (CompMode::Both, true)] {
        let hash = secp::hash160(&point, compressed);
        let address = base58::address_from_hash160(&hash, compressed);
        let cpu_out = temp_path("btc_modes_cpu");
        let gpu_out = temp_path("btc_modes_gpu");

        engine::run(&config(
            SearchMode::Address,
            Coin::Btc,
            comp,
            address.clone(),
            &cpu_out,
        ))
        .expect("CPU search");
        gpu_search::run(&config(
            SearchMode::Address,
            Coin::Btc,
            comp,
            address,
            &gpu_out,
        ))
        .expect("GPU search");

        let cpu = private_keys(&cpu_out);
        let gpu = private_keys(&gpu_out);
        let _ = std::fs::remove_file(&cpu_out);
        let _ = std::fs::remove_file(&gpu_out);
        assert_eq!(gpu, cpu, "GPU and CPU must agree for {comp:?}");
        assert_eq!(cpu.first().map(String::as_str), Some("1F2E3D4C5B6A"));
    }
}

#[test]
fn unavailable_device_is_a_loud_error() {
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let hash = secp::hash160(&secp::mul_g(&k), true);
    let address = base58::address_from_hash160(&hash, true);
    let output = temp_path("no_device");
    let mut config = config(
        SearchMode::Address,
        Coin::Btc,
        CompMode::Compressed,
        address,
        &output,
    );
    config.gpu_ids = vec![9999];
    let err = gpu_search::run(&config).expect_err("an invalid device must fail");
    // Hosted CI has no GPU at all, so the failure can be either the device
    // count probe or the invalid id, but it must always name the device.
    assert!(err.contains("device"), "unexpected error: {err}");
    let _ = std::fs::remove_file(&output);
}

#[test]
fn unsupported_gpu_options_are_rejected() {
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let hash = secp::hash160(&secp::mul_g(&k), true);
    let address = base58::address_from_hash160(&hash, true);
    let output = temp_path("limits");
    let mut config = config(
        SearchMode::Address,
        Coin::Btc,
        CompMode::Compressed,
        address,
        &output,
    );

    config.rkey = 10;
    assert!(
        gpu_search::run(&config)
            .unwrap_err()
            .contains("random mode")
    );

    config.rkey = 0;
    config.next = 5;
    assert!(
        gpu_search::run(&config)
            .unwrap_err()
            .contains("checkpoint mode")
    );

    config.next = 0;
    config.gpu_ids = vec![0, 1];
    assert!(gpu_search::run(&config).unwrap_err().contains("one GPU"));
    let _ = std::fs::remove_file(&output);
}

#[test]
fn cpu_and_gpu_find_the_same_xpoint() {
    if !has_device() {
        return;
    }
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let x = hex_upper(&secp::mul_g(&k).x.to_bytes_be());

    let cpu_out = temp_path("sx_cpu");
    let gpu_out = temp_path("sx_gpu");
    let cpu_config = config(
        SearchMode::XPoint,
        Coin::Btc,
        CompMode::Both,
        x.clone(),
        &cpu_out,
    );
    let gpu_config = config(SearchMode::XPoint, Coin::Btc, CompMode::Both, x, &gpu_out);

    engine::run(&cpu_config).expect("CPU search");
    gpu_search::run(&gpu_config).expect("GPU search");

    let cpu = private_keys(&cpu_out);
    let gpu = private_keys(&gpu_out);
    let _ = std::fs::remove_file(&cpu_out);
    let _ = std::fs::remove_file(&gpu_out);

    assert_eq!(cpu.len(), 2, "both compression modes emit one block each");
    assert_eq!(gpu, cpu, "GPU and CPU must report the same xpoint key");
}

#[test]
fn cpu_and_gpu_find_multi_target_records() {
    if !has_device() {
        return;
    }
    let k = Scalar::from_u64(0x1F2E_3D4C_5B6A);
    let point = secp::mul_g(&k);

    // Multi addresses: the bloom upload path.
    let mut records = Vec::new();
    records.extend_from_slice(&secp::hash160(&point, true));
    records.extend_from_slice(&[0xAA; 20]);
    records.extend_from_slice(&[0x55; 20]);
    let bin = temp_path("addresses").with_extension("bin");
    std::fs::write(&bin, &records).expect("write target file");

    let cpu_out = temp_path("ma_cpu");
    let gpu_out = temp_path("ma_gpu");
    let mut cpu_config = config(
        SearchMode::Addresses,
        Coin::Btc,
        CompMode::Compressed,
        String::new(),
        &cpu_out,
    );
    cpu_config.operands.clear();
    cpu_config.input_file = Some(bin.display().to_string());
    let mut gpu_config = cpu_config.clone();
    gpu_config.output_file = gpu_out.display().to_string();

    engine::run(&cpu_config).expect("CPU addresses search");
    gpu_search::run(&gpu_config).expect("GPU addresses search");
    let cpu = private_keys(&cpu_out);
    let gpu = private_keys(&gpu_out);
    assert_eq!(gpu, cpu, "multi-address bloom path must agree");
    assert_eq!(cpu.first().map(String::as_str), Some("1F2E3D4C5B6A"));

    // Multi xpoints: 32-byte records.
    let mut records = Vec::new();
    records.extend_from_slice(&point.x.to_bytes_be());
    records.extend_from_slice(&[0x11; 32]);
    records.extend_from_slice(&[0x22; 32]);
    std::fs::write(&bin, &records).expect("write xpoint file");

    let cpu_out = temp_path("mx_cpu");
    let gpu_out = temp_path("mx_gpu");
    let mut cpu_config = config(
        SearchMode::XPoints,
        Coin::Btc,
        CompMode::Both,
        String::new(),
        &cpu_out,
    );
    cpu_config.operands.clear();
    cpu_config.input_file = Some(bin.display().to_string());
    let mut gpu_config = cpu_config.clone();
    gpu_config.output_file = gpu_out.display().to_string();

    engine::run(&cpu_config).expect("CPU xpoints search");
    gpu_search::run(&gpu_config).expect("GPU xpoints search");
    let cpu = private_keys(&cpu_out);
    let gpu = private_keys(&gpu_out);
    let _ = std::fs::remove_file(&bin);
    let _ = std::fs::remove_file(&cpu_out);
    let _ = std::fs::remove_file(&gpu_out);
    assert_eq!(gpu, cpu, "multi-xpoint bloom path must agree");
    assert_eq!(cpu.len(), 2, "both compression modes emit one block each");
}

fn hex_upper(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}
