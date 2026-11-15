use std::path::Path;

use rotor::filter::{TargetSet, murmurhash2};

fn eth_targets() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("Others/Puzzles_1_37_ETH.bin")
}

fn temp_path(tag: &str) -> std::path::PathBuf {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .expect("system clock after the epoch")
        .as_nanos();
    std::env::temp_dir().join(format!(
        "rotor_filter_{tag}_{}_{nanos}.bin",
        std::process::id()
    ))
}

#[test]
fn eth_puzzle_set_has_37_records_and_no_false_negatives() {
    let set = TargetSet::load(&eth_targets(), 20).expect("load ETH target file");
    assert_eq!(set.len(), 37);
    assert!(!set.is_empty());
    assert_eq!(set.record_len(), 20);
    for record in set.records() {
        assert_eq!(record.len(), 20);
        assert!(set.contains(record), "false negative for {record:02x?}");
    }
}

#[test]
fn mutated_record_is_not_a_member() {
    let set = TargetSet::load(&eth_targets(), 20).expect("load ETH target file");
    let mut needle = set.records()[0].clone();
    for byte in &mut needle {
        *byte = !*byte;
    }
    // The Bloom filter may false-positive here; the exact check must not.
    assert!(!set.contains(&needle), "flipped record must not match");
}

#[test]
fn file_size_not_multiple_of_record_len_is_rejected() {
    let path = temp_path("invalid_size");
    std::fs::write(&path, vec![0u8; 37]).expect("write temp file");
    let result = TargetSet::load(&path, 20);
    let _ = std::fs::remove_file(&path);

    let Err(err) = result else {
        panic!("37-byte file must be rejected");
    };
    assert!(
        err.contains("has 37 bytes"),
        "error should report 37: {err}"
    );
    assert!(
        err.contains("20-byte record length"),
        "error should report 20: {err}"
    );
}

#[test]
fn empty_file_is_rejected() {
    let path = temp_path("empty");
    std::fs::write(&path, b"").expect("write temp file");
    let result = TargetSet::load(&path, 20);
    let _ = std::fs::remove_file(&path);

    assert!(result.is_err(), "empty file must be rejected");
}

#[test]
fn record_len_32_rejects_the_20_byte_file() {
    let result = TargetSet::load(&eth_targets(), 32);
    let Err(err) = result else {
        panic!("20-byte records cannot fill 32-byte records");
    };
    assert!(
        err.contains("740"),
        "error should report the file size: {err}"
    );
    assert!(err.contains("32-byte"), "error should report 32: {err}");
}

#[test]
fn from_records_sorts_unsorted_input() {
    let mut records: Vec<Vec<u8>> = (0..50u8).map(|i| vec![i; 20]).collect();
    records.reverse();
    let set = TargetSet::from_records(&records, 20);
    assert_eq!(set.len(), 50);
    for record in &records {
        assert!(set.contains(record), "missing {record:02x?}");
    }
}

#[test]
fn murmurhash2_is_deterministic_and_seed_sensitive() {
    let data = [0x42u8; 20];
    let seed = 0x9747_b28c;
    let first = murmurhash2(&data, seed);

    assert_eq!(first, murmurhash2(&data, seed));
    assert_eq!(
        first, 0x1a41_60c7,
        "reference value from Bloom.cpp semantics"
    );
    assert_ne!(first, murmurhash2(&data, 0));
    assert_ne!(first, murmurhash2(&data, 0xdead_beef));
}
