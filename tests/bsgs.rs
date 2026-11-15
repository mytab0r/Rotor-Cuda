//! Fixtures for the M6 CPU baby-step/giant-step solver, ported from
//! `Rotor-Cuda/bsgs/bsgs_selftest.cpp`.

use rotor::bsgs::{BSGS_TABLE_FORMAT_VERSION, BsgsResult, TableManifest, solve};
use rotor::point::Affine;
use rotor::scalar::Scalar;
use rotor::secp;

const BASE: u64 = 1000;
const SPAN: u64 = 4095;

fn scalar(value: u64) -> Scalar {
    Scalar::from_u64(value)
}

fn target_for(k: u64) -> Affine {
    secp::mul_g(&scalar(k))
}

fn solve_in_range(k: u64, m: u64) -> BsgsResult {
    solve(&target_for(k), &scalar(BASE), &scalar(BASE + SPAN), m)
}

#[test]
fn auto_m_recovers_range_start_middle_and_end() {
    // span = 4095, so the default m = isqrt(4096) + 1 = 65.
    for k in [BASE, BASE + SPAN / 2, BASE + SPAN] {
        let result = solve_in_range(k, 0);
        assert!(result.error.is_none(), "k={k}: {:?}", result.error);
        assert!(result.found, "k={k} not found");
        assert_eq!(result.key, scalar(k), "k={k}");
        assert_eq!(result.baby_size, 65);
        assert_eq!(result.manifest.baby_size, 65);
    }
}

#[test]
fn explicit_m_recovers_giant_and_baby_boundaries() {
    // k = base + 64 sits on the first giant/baby boundary; k = base + 127 is
    // mid-way through the second giant step for m = 64.
    for k in [BASE + 64, BASE + 127] {
        let result = solve_in_range(k, 64);
        assert!(result.error.is_none(), "k={k}: {:?}", result.error);
        assert!(result.found, "k={k} not found");
        assert_eq!(result.key, scalar(k), "k={k}");
        assert_eq!(result.manifest.baby_size, 64);
    }
}

#[test]
fn key_just_outside_the_range_is_not_found() {
    let result = solve_in_range(BASE + SPAN + 1, 0);
    assert!(result.error.is_none(), "{:?}", result.error);
    assert!(!result.found);
    assert_eq!(result.key, Scalar::ZERO);
}

#[test]
fn repeated_solves_are_deterministic() {
    let target = target_for(BASE + 7);
    let first = solve(&target, &scalar(BASE), &scalar(BASE + SPAN), 0);
    let second = solve(&target, &scalar(BASE), &scalar(BASE + SPAN), 0);

    assert!(first.found && second.found);
    assert_eq!(first.key, second.key);
    assert_eq!(first.manifest, second.manifest);
}

#[test]
fn manifest_identity_and_mismatch_rejection() {
    let target = target_for(BASE + 7);
    let a = solve(&target, &scalar(BASE), &scalar(BASE + SPAN), 64);
    let b = solve(&target, &scalar(BASE), &scalar(BASE + SPAN), 64);

    assert_eq!(a.manifest.format_version, BSGS_TABLE_FORMAT_VERSION);
    assert_eq!(a.manifest.format_version, 1);
    assert_eq!(a.manifest.curve, "secp256k1");
    assert_eq!(a.manifest.baby_size, 64);
    assert_eq!(a.manifest.range_id, format!("{BASE:X}:{:X}", BASE + SPAN));
    assert_ne!(a.manifest.table_checksum, 0);
    assert!(a.manifest.compatible(&b.manifest));

    // Different m builds a different table.
    let different_m = solve(&target, &scalar(BASE), &scalar(BASE + SPAN), 32);
    assert!(!a.manifest.compatible(&different_m.manifest));

    // Corrupted/forged checksum.
    let mut forged = a.manifest.clone();
    forged.table_checksum ^= 1;
    assert!(!a.manifest.compatible(&forged));

    // Stale format version.
    let mut old_version = a.manifest.clone();
    old_version.format_version = 0;
    assert!(!a.manifest.compatible(&old_version));
}

#[test]
fn public_key_round_trip_in_small_range() {
    let low = 1_000_000u64;
    let high = 1_010_000u64;
    let k = 1_005_432u64;
    let target = secp::mul_g(&scalar(k));

    let result = solve(&target, &scalar(low), &scalar(high), 0);
    assert!(result.error.is_none(), "{:?}", result.error);
    assert!(result.found);
    assert_eq!(result.key, scalar(k));
    assert_eq!(secp::mul_g(&result.key), target);
}

#[test]
fn oversized_range_and_table_fail_loudly() {
    let target = target_for(BASE);

    // span = 2^248 - 1 does not fit in u128: reject instead of walking garbage.
    let huge = Scalar::from_hex("0100000000000000000000000000000000000000000000000000000000000000")
        .expect("valid scalar");
    let too_wide = solve(&target, &Scalar::ONE, &huge, 0);
    assert!(!too_wide.found);
    assert_eq!(
        too_wide.error.as_deref(),
        Some("range too large for CPU-BSGS")
    );

    // m above the 32-bit index space is rejected before any table is built.
    let too_many = solve(
        &target,
        &scalar(BASE),
        &scalar(BASE + SPAN),
        u64::from(u32::MAX) + 1,
    );
    assert!(!too_many.found);
    assert_eq!(
        too_many.error.as_deref(),
        Some("baby table would exceed 32-bit indices")
    );
}

#[test]
fn compatible_with_identical_manifest() {
    let manifest = TableManifest {
        format_version: 1,
        curve: "secp256k1".to_string(),
        baby_size: 64,
        range_id: "3E8:13E7".to_string(),
        table_checksum: 0x1234_5678_9ABC_DEF0,
    };
    assert!(manifest.compatible(&manifest.clone()));
}

#[test]
fn cli_bsgs_recovers_scalar() {
    let output_path =
        std::env::temp_dir().join(format!("rotor_bsgs_cli_{}.txt", std::process::id()));
    let _ = std::fs::remove_file(&output_path);

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_rotor"))
        .args([
            "-m",
            "bsgs",
            "--range",
            "3E8:13E7",
            "02E37648435C60DCD181B3D41D50857BA5B5ABEBE279429AA76558F6653F1658F2",
            "-o",
        ])
        .arg(&output_path)
        .output()
        .expect("run the rotor binary");

    assert!(
        output.status.success(),
        "exit {:?}, stderr: {}",
        output.status,
        String::from_utf8_lossy(&output.stderr)
    );

    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("KEY FOUND: 4D2"), "stdout: {stdout}");

    let written = std::fs::read_to_string(&output_path).expect("read the output file");
    assert!(
        written.contains("02E37648435C60DCD181B3D41D50857BA5B5ABEBE279429AA76558F6653F1658F2 4D2"),
        "output file: {written}"
    );

    let _ = std::fs::remove_file(&output_path);
}
