//! Binary BSGS work files: persist a baby table and giant-walk position so an
//! offline CPU-BSGS run can resume without rebuilding the table.
//!
//! Layout (design D2, little-endian integers):
//!
//! ```text
//! magic      "RBWF"
//! version    u32 = 1
//! curve      1 byte (1 = secp256k1)
//! flags      1 byte (bit0 = target compressed)
//! reserved   u16 = 0
//! k_start    32 bytes big-endian
//! k_end      32 bytes big-endian
//! baby_size  u64
//! giant_index u64
//! checksum   u64  (table_checksum of folds)
//! target_len u8, target bytes (33 or 65)
//! folds      baby_size x u64
//! digest     32 bytes SHA-256 of everything above
//! ```

use std::collections::HashMap;
use std::fmt::Write as _;
use std::fs;
use std::path::{Path, PathBuf};

use crate::bsgs::{
    BsgsTable, TableManifest, baby_size_for, map_from_folds, range_id, span_u128, table_checksum,
};
use crate::hashes;
use crate::point::Affine;
use crate::scalar::Scalar;
use crate::secp;

/// Work-file magic.
pub const WORKFILE_MAGIC: [u8; 4] = *b"RBWF";
/// Current work-file format version (bump when the layout changes).
pub const WORKFILE_VERSION: u32 = 1;
/// Curve byte for secp256k1.
pub const CURVE_SECP256K1: u8 = 1;

const FLAG_TARGET_COMPRESSED: u8 = 1;
/// Bytes before the target bytes: magic (4) + version (4) + curve (1) +
/// flags (1) + reserved (2) + k_start (32) + k_end (32) + baby size (8) +
/// giant index (8) + checksum (8) + target length (1).
const HEADER_LEN: usize = 101;
const DIGEST_LEN: usize = 32;

/// A persisted CPU-BSGS run: table identity, range, target and walk position.
#[derive(Clone, Debug)]
pub struct WorkFile {
    pub table: BsgsTable,
    pub k_start: Scalar,
    pub k_end: Scalar,
    pub target: Affine,
    pub giant_index: u64,
}

/// Write `work` atomically via `<path>.tmp` + rename.
pub fn save(path: &Path, work: &WorkFile) -> Result<(), String> {
    save_parts(
        path,
        &work.table,
        &work.k_start,
        &work.k_end,
        &work.target,
        work.giant_index,
    )
}

/// Write a work file from borrowed parts, avoiding a table clone on every
/// throttled save.
pub(crate) fn save_parts(
    path: &Path,
    table: &BsgsTable,
    k_start: &Scalar,
    k_end: &Scalar,
    target: &Affine,
    giant_index: u64,
) -> Result<(), String> {
    if table.folds.len() as u64 != table.baby_size {
        return Err(format!(
            "table has {} folds but baby size {}",
            table.folds.len(),
            table.baby_size
        ));
    }

    let target_bytes = secp::compress(target);
    let mut data = Vec::with_capacity(
        HEADER_LEN
            + target_bytes.len()
            + table.folds.len() * std::mem::size_of::<u64>()
            + DIGEST_LEN,
    );
    data.extend_from_slice(&WORKFILE_MAGIC);
    data.extend_from_slice(&WORKFILE_VERSION.to_le_bytes());
    data.push(CURVE_SECP256K1);
    data.push(FLAG_TARGET_COMPRESSED);
    data.extend_from_slice(&0u16.to_le_bytes());
    data.extend_from_slice(&k_start.to_bytes_be());
    data.extend_from_slice(&k_end.to_bytes_be());
    data.extend_from_slice(&table.baby_size.to_le_bytes());
    data.extend_from_slice(&giant_index.to_le_bytes());
    data.extend_from_slice(&table_checksum(&table.folds).to_le_bytes());
    data.push(target_bytes.len() as u8);
    data.extend_from_slice(&target_bytes);
    for fold in &table.folds {
        data.extend_from_slice(&fold.to_le_bytes());
    }

    let digest = hashes::sha256(&data);
    data.extend_from_slice(&digest);

    let tmp = tmp_path(path);
    fs::write(&tmp, &data).map_err(|err| format!("cannot write '{}': {err}", tmp.display()))?;
    if let Err(err) = fs::rename(&tmp, path) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("cannot replace '{}': {err}", path.display()));
    }
    Ok(())
}

/// Read and verify a work file, rebuilding `map` from the stored folds.
pub fn load(path: &Path) -> Result<WorkFile, String> {
    let data = fs::read(path).map_err(|err| format!("cannot read '{}': {err}", path.display()))?;
    if data.len() < HEADER_LEN + DIGEST_LEN {
        return Err(format!(
            "file is truncated: {} bytes is shorter than the {}-byte header plus {DIGEST_LEN}-byte digest",
            data.len(),
            HEADER_LEN
        ));
    }

    let (body, stored_digest) = data.split_at(data.len() - DIGEST_LEN);
    if hashes::sha256(body) != stored_digest {
        return Err("SHA-256 digest mismatch (file is corrupted or truncated)".to_string());
    }

    if body.get(..4) != Some(WORKFILE_MAGIC.as_slice()) {
        return Err("bad magic (not a Rotor BSGS work file)".to_string());
    }
    let version = u32::from_le_bytes(expect_array(body, 4, "version"));
    if version != WORKFILE_VERSION {
        return Err(format!(
            "unsupported work file version {version} (expected {WORKFILE_VERSION})"
        ));
    }
    let curve = body[8];
    if curve != CURVE_SECP256K1 {
        return Err(format!(
            "unsupported curve byte {curve} (expected {CURVE_SECP256K1} = secp256k1)"
        ));
    }
    let flags = body[9];
    if flags & !FLAG_TARGET_COMPRESSED != 0 {
        return Err(format!(
            "unsupported flags {flags:#04x} (only bit0 is defined)"
        ));
    }
    let reserved = u16::from_le_bytes(expect_array(body, 10, "reserved"));
    if reserved != 0 {
        return Err(format!("reserved field is {reserved}, expected 0"));
    }

    let k_start = Scalar::from_bytes_be(&expect_array(body, 12, "k_start"))
        .ok_or_else(|| "k_start is not a valid scalar (< curve order)".to_string())?;
    let k_end = Scalar::from_bytes_be(&expect_array(body, 44, "k_end"))
        .ok_or_else(|| "k_end is not a valid scalar (< curve order)".to_string())?;
    if k_end < k_start {
        return Err(format!(
            "range end is below range start ({})",
            range_id(&k_start, &k_end)
        ));
    }
    let baby_size = u64::from_le_bytes(expect_array(body, 76, "baby_size"));
    if baby_size == 0 {
        return Err("baby size is 0".to_string());
    }
    if baby_size > u64::from(u32::MAX) {
        return Err(format!("baby size {baby_size} would exceed 32-bit indices"));
    }
    let giant_index = u64::from_le_bytes(expect_array(body, 84, "giant_index"));
    let stored_checksum = u64::from_le_bytes(expect_array(body, 92, "checksum"));

    let target_len = usize::from(body[100]);
    let compressed = flags & FLAG_TARGET_COMPRESSED != 0;
    let expected_target_len = if compressed { 33 } else { 65 };
    if target_len != expected_target_len {
        return Err(format!(
            "target length {target_len} does not match the compressed flag (expected {expected_target_len})"
        ));
    }

    let folds_bytes = usize::try_from(baby_size)
        .ok()
        .and_then(|value| value.checked_mul(std::mem::size_of::<u64>()))
        .ok_or_else(|| format!("baby size {baby_size} does not fit this platform"))?;
    let expected_len = HEADER_LEN + target_len + folds_bytes;
    if body.len() != expected_len {
        return Err(format!(
            "length {} does not match the layout for baby size {baby_size} and target length {target_len} (expected {expected_len})",
            body.len()
        ));
    }

    let target_start = HEADER_LEN;
    let target_end = target_start + target_len;
    let target_hex = to_hex(&body[target_start..target_end]);
    let mut target_compressed = compressed;
    let target = secp::parse_pubkey_hex(&target_hex, &mut target_compressed)
        .map_err(|err| format!("invalid target public key: {err}"))?;

    let folds_start = target_end;
    let mut folds = Vec::with_capacity(folds_bytes / std::mem::size_of::<u64>());
    for chunk in body[folds_start..].as_chunks::<8>().0 {
        folds.push(u64::from_le_bytes(*chunk));
    }

    let checksum = table_checksum(&folds);
    if checksum != stored_checksum {
        return Err(format!(
            "table checksum mismatch: file stores {stored_checksum:#018x}, folds hash to {checksum:#018x}"
        ));
    }

    let span =
        span_u128(&k_start, &k_end).ok_or_else(|| "range span does not fit u128".to_string())?;
    let manifest = TableManifest {
        format_version: WORKFILE_VERSION,
        curve: "secp256k1".to_string(),
        baby_size,
        range_id: range_id(&k_start, &k_end),
        table_checksum: checksum,
    };
    let map: HashMap<u64, u32> = map_from_folds(&folds);

    Ok(WorkFile {
        table: BsgsTable {
            span,
            baby_size,
            map,
            manifest,
            folds,
        },
        k_start,
        k_end,
        target,
        giant_index,
    })
}

/// Compare a loaded work file against the parameters of the current run.
///
/// `m` follows `build_table`: `0` selects the automatic baby size. Any
/// mismatch names the field that differs.
pub fn validate(
    work: &WorkFile,
    k_start: &Scalar,
    k_end: &Scalar,
    target: &Affine,
    m: u64,
) -> Result<(), String> {
    if work.k_start != *k_start || work.k_end != *k_end {
        return Err(format!(
            "range mismatch: file has {}, run has {}",
            range_id(&work.k_start, &work.k_end),
            range_id(k_start, k_end)
        ));
    }
    if work.target != *target {
        return Err(format!(
            "target public key mismatch: file has {}, run has {}",
            to_hex(&secp::compress(&work.target)),
            to_hex(&secp::compress(target))
        ));
    }

    let expected_baby_size = baby_size_for(work.table.span, m)?;
    if work.table.baby_size != expected_baby_size {
        return Err(format!(
            "baby size mismatch: file has {}, run needs {expected_baby_size}",
            work.table.baby_size
        ));
    }

    let manifest = &work.table.manifest;
    let expected = TableManifest {
        format_version: WORKFILE_VERSION,
        curve: "secp256k1".to_string(),
        baby_size: expected_baby_size,
        range_id: range_id(k_start, k_end),
        table_checksum: table_checksum(&work.table.folds),
    };
    if manifest.format_version != expected.format_version {
        return Err(format!(
            "manifest format version mismatch: file has {}, expected {}",
            manifest.format_version, expected.format_version
        ));
    }
    if manifest.curve != expected.curve {
        return Err(format!(
            "manifest curve mismatch: file has '{}', expected '{}'",
            manifest.curve, expected.curve
        ));
    }
    if manifest.baby_size != expected.baby_size {
        return Err(format!(
            "manifest baby size mismatch: file has {}, expected {}",
            manifest.baby_size, expected.baby_size
        ));
    }
    if manifest.range_id != expected.range_id {
        return Err(format!(
            "manifest range mismatch: file has '{}', expected '{}'",
            manifest.range_id, expected.range_id
        ));
    }
    if manifest.table_checksum != expected.table_checksum {
        return Err(format!(
            "manifest table checksum mismatch: file has {:#018x}, folds hash to {:#018x}",
            manifest.table_checksum, expected.table_checksum
        ));
    }
    Ok(())
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.as_os_str().to_os_string();
    name.push(".tmp");
    PathBuf::from(name)
}

/// Copy `LEN` bytes at `offset` into a fixed-size array; checked lengths make
/// the `expect` unreachable for the fixed header fields.
fn expect_array<const LEN: usize>(bytes: &[u8], offset: usize, field: &str) -> [u8; LEN] {
    let end = offset + LEN;
    match bytes.get(offset..end) {
        Some(slice) => slice
            .try_into()
            .expect("slice length equals the target array length"),
        None => panic!("work file field '{field}' is outside the checked header"),
    }
}

fn to_hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        let _ = write!(out, "{byte:02X}");
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bsgs::{build_table, solve_with_table};
    use crate::secp;

    const BASE: u64 = 1000;
    const END: u64 = 5095;
    const KEY: u64 = 3047;

    fn scalar(value: u64) -> Scalar {
        Scalar::from_u64(value)
    }

    fn temp_path(tag: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "rotor_workfile_unit_{}_{tag}.bin",
            std::process::id()
        ))
    }

    fn work(tag: &str, giant_index: u64) -> (PathBuf, WorkFile) {
        let path = temp_path(tag);
        let table = build_table(&scalar(BASE), &scalar(END), 64).expect("build table");
        let work = WorkFile {
            table,
            k_start: scalar(BASE),
            k_end: scalar(END),
            target: secp::mul_g(&scalar(KEY)),
            giant_index,
        };
        (path, work)
    }

    #[test]
    fn table_roundtrip_rebuilds_map_and_checksum() {
        let (path, work) = work("roundtrip", 2);
        save(&path, &work).expect("save");

        let loaded = load(&path).expect("load");
        assert_eq!(loaded.table.map, work.table.map);
        assert_eq!(loaded.table.folds, work.table.folds);
        assert_eq!(loaded.table.manifest, work.table.manifest);
        assert_eq!(loaded.table.span, work.table.span);
        assert_eq!(loaded.target, work.target);
        assert_eq!(loaded.k_start, work.k_start);
        assert_eq!(loaded.k_end, work.k_end);
        assert_eq!(loaded.giant_index, 2);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn partial_walk_resumes_and_finds_the_key() {
        let (path, work) = work("resume", 2);
        save(&path, &work).expect("save");
        let loaded = load(&path).expect("load");

        let result = solve_with_table(
            &loaded.target,
            &loaded.k_start,
            &loaded.k_end,
            &loaded.table,
            u128::from(loaded.giant_index),
            &mut |_, _| true,
        );
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(result.found);
        assert_eq!(result.key, scalar(KEY));

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn resumed_past_the_found_index_does_not_find_the_key() {
        // Proves the walk really starts at the stored giant index instead of
        // silently rebuilding or restarting from zero.
        let (path, work) = work("past", 32);
        save(&path, &work).expect("save");
        let loaded = load(&path).expect("load");

        let result = solve_with_table(
            &loaded.target,
            &loaded.k_start,
            &loaded.k_end,
            &loaded.table,
            u128::from(loaded.giant_index),
            &mut |_, _| true,
        );
        assert!(result.error.is_none(), "{:?}", result.error);
        assert!(!result.found);

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn mismatches_are_named() {
        let (path, work) = work("mismatch", 0);

        let other_target = secp::mul_g(&scalar(KEY + 1));
        let err = validate(&work, &scalar(BASE), &scalar(END), &other_target, 64)
            .expect_err("wrong target");
        assert!(err.contains("target public key mismatch"), "{err}");

        let err = validate(&work, &scalar(BASE + 1), &scalar(END), &work.target, 64)
            .expect_err("wrong range");
        assert!(err.contains("range mismatch"), "{err}");

        let err =
            validate(&work, &scalar(BASE), &scalar(END), &work.target, 32).expect_err("wrong m");
        assert!(err.contains("baby size mismatch"), "{err}");

        let mut forged = work.clone();
        forged.table.manifest.table_checksum ^= 1;
        let err = validate(&forged, &scalar(BASE), &scalar(END), &work.target, 64)
            .expect_err("forged manifest");
        assert!(err.contains("manifest table checksum mismatch"), "{err}");

        // A valid file passes.
        validate(&work, &scalar(BASE), &scalar(END), &work.target, 64).expect("valid");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn corrupted_byte_and_truncated_file_are_rejected() {
        let (path, work) = work("corrupt", 0);
        save(&path, &work).expect("save");
        let bytes = fs::read(&path).expect("read");

        let mut corrupted = bytes.clone();
        corrupted[40] ^= 0xFF;
        fs::write(&path, &corrupted).expect("write corrupted");
        let err = load(&path).expect_err("corrupted byte");
        assert!(err.contains("digest mismatch"), "{err}");

        fs::write(&path, &bytes[..bytes.len() / 2]).expect("write truncated");
        let err = load(&path).expect_err("truncated");
        assert!(err.contains("truncated") || err.contains("length"), "{err}");

        let _ = fs::remove_file(&path);
    }

    #[test]
    fn foreign_checksum_with_valid_digest_is_rejected() {
        let (path, work) = work("checksum", 0);
        save(&path, &work).expect("save");
        let mut bytes = fs::read(&path).expect("read");

        // Flip the last fold, keeping the trailing digest consistent.
        let fold_offset = bytes.len() - DIGEST_LEN - std::mem::size_of::<u64>();
        bytes[fold_offset] ^= 0x01;
        let digest = hashes::sha256(&bytes[..bytes.len() - DIGEST_LEN]);
        let digest_offset = bytes.len() - DIGEST_LEN;
        bytes[digest_offset..].copy_from_slice(&digest);
        fs::write(&path, &bytes).expect("write");

        let err = load(&path).expect_err("checksum mismatch");
        assert!(err.contains("checksum mismatch"), "{err}");

        let _ = fs::remove_file(&path);
    }
}
