//! Work-file resume fixtures for the CPU baby-step/giant-step solver.

use std::path::{Path, PathBuf};

use rotor::bsgs::{BsgsTable, build_table, solve_with_table};
use rotor::bsgs_workfile::{WorkFile, load, save, validate};
use rotor::cli::{Config, Range, SearchMode, U256};
use rotor::point::Affine;
use rotor::scalar::Scalar;
use rotor::secp;

const BASE: u64 = 1000;
const END: u64 = 5095;
const KEY: u64 = 3047;
/// Explicit baby size used by the fixtures (the CLI default for this range is
/// 65, so a 64-fold file is also a useful mismatch case).
const M: u64 = 64;

fn scalar(value: u64) -> Scalar {
    Scalar::from_u64(value)
}

fn target_for(key: u64) -> Affine {
    secp::mul_g(&scalar(key))
}

fn temp_path(tag: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "rotor_bsgs_workfile_{}_{tag}.bin",
        std::process::id()
    ))
}

fn build_work(giant_index: u64) -> WorkFile {
    WorkFile {
        table: build_table(&scalar(BASE), &scalar(END), M).expect("build table"),
        k_start: scalar(BASE),
        k_end: scalar(END),
        target: target_for(KEY),
        giant_index,
    }
}

fn solve_from(table: &BsgsTable, work: &WorkFile, start_index: u128) -> (bool, Scalar) {
    let result = solve_with_table(
        &work.target,
        &work.k_start,
        &work.k_end,
        table,
        start_index,
        &mut |_, _| true,
    );
    assert!(result.error.is_none(), "{:?}", result.error);
    (result.found, result.key)
}

fn to_hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02X}")).collect()
}

fn pubkey_hex(point: &Affine) -> String {
    to_hex(&secp::compress(point))
}

fn cli_config(work_path: Option<&Path>, output: &Path, reset: bool) -> Config {
    Config {
        mode: Some(SearchMode::Bsgs),
        range: Some(Range {
            start: U256::from_u64(BASE),
            end: U256::from_u64(END),
        }),
        operands: vec![pubkey_hex(&target_for(KEY))],
        output_file: output.to_string_lossy().into_owned(),
        bsgs_work: work_path.map(|path| path.to_string_lossy().into_owned()),
        bsgs_work_reset: reset,
        ..Config::default()
    }
}

#[test]
fn save_partial_walk_load_and_resume_finds_key() {
    let path = temp_path("partial");
    let work = build_work(2);
    save(&path, &work).expect("save");
    let loaded = load(&path).expect("load");

    let (found, key) = solve_from(&loaded.table, &loaded, u128::from(loaded.giant_index));
    assert!(found);
    assert_eq!(key, scalar(KEY));

    let _ = std::fs::remove_file(&path);
}

#[test]
fn resume_from_a_mid_index_still_finds_the_key() {
    let path = temp_path("mid");
    let work = build_work(0);
    save(&path, &work).expect("save");
    let loaded = load(&path).expect("load");

    for mid in [2u64, 31] {
        let (found, key) = solve_from(&loaded.table, &loaded, u128::from(mid));
        assert!(found, "mid index {mid}");
        assert_eq!(key, scalar(KEY));
    }

    let _ = std::fs::remove_file(&path);
}

#[test]
fn load_path_reuses_the_table_and_the_stored_index() {
    let path = temp_path("identity");
    let work = build_work(2);
    save(&path, &work).expect("save");
    let loaded = load(&path).expect("load");

    // No baby-step EC is observable here; the rebuilt map and the fold order
    // must be exactly the ones the saved table had.
    assert_eq!(loaded.table.map, work.table.map);
    assert_eq!(loaded.table.folds, work.table.folds);
    assert_eq!(loaded.table.baby_size, M);
    assert_eq!(loaded.table.manifest, work.table.manifest);
    assert_eq!(loaded.giant_index, 2);

    // Past the found giant index (31) the walk must not find the key, which
    // proves the run starts at the stored index instead of from zero.
    let past = build_work(32);
    save(&path, &past).expect("save past");
    let past = load(&path).expect("load past");
    let (found, _) = solve_from(&past.table, &past, u128::from(past.giant_index));
    assert!(!found);

    let _ = std::fs::remove_file(&path);
}

#[test]
fn mismatched_work_files_are_rejected_with_the_field_name() {
    let work = build_work(0);

    let other_target = target_for(KEY + 1);
    let err =
        validate(&work, &scalar(BASE), &scalar(END), &other_target, M).expect_err("wrong target");
    assert!(err.contains("target public key mismatch"), "{err}");

    let err =
        validate(&work, &scalar(BASE + 1), &scalar(END), &work.target, M).expect_err("wrong range");
    assert!(err.contains("range mismatch"), "{err}");

    let err = validate(&work, &scalar(BASE), &scalar(END), &work.target, 32).expect_err("wrong m");
    assert!(err.contains("baby size mismatch"), "{err}");

    validate(&work, &scalar(BASE), &scalar(END), &work.target, M).expect("matching file");
}

#[test]
fn corrupted_and_truncated_files_error_without_panic() {
    let path = temp_path("broken");
    let work = build_work(0);
    save(&path, &work).expect("save");
    let bytes = std::fs::read(&path).expect("read");

    let mut corrupted = bytes.clone();
    corrupted[50] ^= 0xFF;
    std::fs::write(&path, &corrupted).expect("write corrupted");
    let err = load(&path).expect_err("corrupted byte");
    assert!(err.contains("digest mismatch"), "{err}");

    std::fs::write(&path, &bytes[..bytes.len() / 2]).expect("write truncated");
    let err = load(&path).expect_err("truncated file");
    assert!(err.contains("truncated") || err.contains("length"), "{err}");

    // Empty file as well: still an error, never a panic.
    std::fs::write(&path, []).expect("write empty");
    assert!(load(&path).is_err());

    let _ = std::fs::remove_file(&path);
}

#[test]
fn foreign_checksum_with_valid_digest_is_rejected() {
    let path = temp_path("checksum");
    let work = build_work(0);
    save(&path, &work).expect("save");
    let mut bytes = std::fs::read(&path).expect("read");

    let fold_offset = bytes.len() - 32 - 8;
    bytes[fold_offset] ^= 0x01;
    let digest = rotor::hashes::sha256(&bytes[..bytes.len() - 32]);
    let digest_offset = bytes.len() - 32;
    bytes[digest_offset..].copy_from_slice(&digest);
    std::fs::write(&path, &bytes).expect("write");

    let err = load(&path).expect_err("checksum mismatch");
    assert!(err.contains("checksum mismatch"), "{err}");

    let _ = std::fs::remove_file(&path);
}

#[test]
fn cli_reset_overwrites_a_mismatched_file_and_then_resumes() {
    let path = temp_path("cli");
    let output = temp_path("cli_out.txt");
    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&output);

    // The fixture uses m = 64 while the CLI default is m = 65, so the file is
    // a genuine identity mismatch, not corruption.
    save(&path, &build_work(0)).expect("save mismatched work");

    let err = rotor::bsgs::run_cli(&cli_config(Some(&path), &output, false))
        .expect_err("mismatch must fail");
    assert!(err.contains("--bsgs-work-reset"), "{err}");

    // Reset: overwrite and start from index 0.
    let code = rotor::bsgs::run_cli(&cli_config(Some(&path), &output, true)).expect("reset run");
    assert_eq!(code, 0);
    let written = std::fs::read_to_string(&output).expect("read Found.txt");
    assert!(written.contains(&pubkey_hex(&target_for(KEY))), "{written}");

    let reloaded = load(&path).expect("load reset work");
    assert_eq!(reloaded.table.baby_size, 65);
    assert_eq!(reloaded.target, target_for(KEY));
    assert_eq!(reloaded.k_start, scalar(BASE));
    assert_eq!(reloaded.k_end, scalar(END));

    // A second run without reset loads the file and resumes at the saved index.
    let code = rotor::bsgs::run_cli(&cli_config(Some(&path), &output, false))
        .expect("resumed run from the work file");
    assert_eq!(code, 0);

    let _ = std::fs::remove_file(&path);
    let _ = std::fs::remove_file(&output);
}

#[test]
fn cli_reset_without_a_work_file_is_rejected() {
    let output = temp_path("cli_no_work.txt");
    let err = rotor::bsgs::run_cli(&cli_config(None, &output, true))
        .expect_err("reset requires a work file");
    assert!(
        err.contains("--bsgs-work-reset requires --bsgs-work"),
        "{err}"
    );
    let _ = std::fs::remove_file(&output);
}
