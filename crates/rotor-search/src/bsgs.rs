//! BSGS table identity: the manifest, baby-step count, range id and the
//! checksum of the fold list.
//!
//! These are the deterministic, protocol-side pieces of the solver. The baby
//! table build and the giant-step walk stay in the desktop crate along with
//! the CUDA driver; the coordinator only needs the identity to store and
//! compare a resume point.

use std::collections::HashMap;

use rotor_core::scalar::Scalar;

use crate::fnv::{FNV_OFFSET, FNV_PRIME};

/// Bump when the baby-table layout or fold changes so a stale checkpoint that
/// names an older version is rejected instead of silently trusted.
pub const BSGS_TABLE_FORMAT_VERSION: u32 = 1;

/// Canonical identity of a built baby-step table.
///
/// A saved checkpoint/resume must carry one of these and is rejected on any
/// field mismatch, so a table from different `m`/range/content is never reused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TableManifest {
    pub format_version: u32,
    pub curve: String,
    pub baby_size: u64,
    pub range_id: String,
    pub table_checksum: u64,
}

impl Default for TableManifest {
    fn default() -> Self {
        Self {
            format_version: BSGS_TABLE_FORMAT_VERSION,
            curve: "secp256k1".to_string(),
            baby_size: 0,
            range_id: String::new(),
            table_checksum: 0,
        }
    }
}

impl TableManifest {
    /// `true` only when both manifests name the exact same table.
    pub fn compatible(&self, other: &Self) -> bool {
        self.format_version == other.format_version
            && self.curve == other.curve
            && self.baby_size == other.baby_size
            && self.range_id == other.range_id
            && self.table_checksum == other.table_checksum
    }
}

/// Rebuild the baby map from an ordered fold list with the same first-j-wins
/// rule as the table build, without any baby-step EC work.
pub fn map_from_folds(folds: &[u64]) -> HashMap<u64, u32> {
    let mut map = HashMap::with_capacity(folds.len());
    for (offset, fold) in folds.iter().enumerate() {
        map.entry(*fold).or_insert((offset as u64 + 1) as u32);
    }
    map
}

/// FNV-1a/64 over the little-endian bytes of every fold, in table order.
pub fn table_checksum(folds: &[u64]) -> u64 {
    let mut hash = FNV_OFFSET;
    for fold in folds {
        for byte in fold.to_le_bytes() {
            hash ^= u64::from(byte);
            hash = hash.wrapping_mul(FNV_PRIME);
        }
    }
    hash
}

/// Baby-step count for a span: explicit `m` or the `isqrt(span + 1) + 1`
/// default, clamped and validated exactly like the table build.
pub fn baby_size_for(span: u128, m: u64) -> Result<u64, String> {
    let mut baby_size = m;
    if baby_size == 0 {
        let root = span.saturating_add(1).isqrt();
        if root >= u128::from(u32::MAX) {
            return Err("baby table would exceed 32-bit indices".to_string());
        }
        baby_size = root as u64 + 1;
    }
    if baby_size > u64::from(u32::MAX) {
        return Err("baby table would exceed 32-bit indices".to_string());
    }
    Ok(baby_size.max(1))
}

/// Canonical manifest range identity, e.g. `"3E8:13E7"`.
pub fn range_id(k_start: &Scalar, k_end: &Scalar) -> String {
    format!("{}:{}", hex_trim(k_start), hex_trim(k_end))
}

/// The scalar span `k_end - k_start` as `u128`, or `None` when it does not fit.
pub fn span_u128(k_start: &Scalar, k_end: &Scalar) -> Option<u128> {
    scalar_to_u128(&k_end.sub(k_start))
}

/// Scalar as `u128`, or `None` when any bit at 128 or above is set.
pub fn scalar_to_u128(value: &Scalar) -> Option<u128> {
    if (128..256).any(|index| value.bit(index)) {
        return None;
    }
    let bytes = value.to_bytes_be();
    let mut low = [0u8; 16];
    low.copy_from_slice(&bytes[16..]);
    Some(u128::from_be_bytes(low))
}

/// Uppercase hex with no leading zeros; zero prints as `"0"`.
pub fn hex_trim(value: &Scalar) -> String {
    let hex = value.to_hex();
    let trimmed = hex.trim_start_matches('0');
    let trimmed = if trimmed.is_empty() { "0" } else { trimmed };
    trimmed.to_ascii_uppercase()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn manifest_defaults_to_the_current_format_and_compares_every_field() {
        let manifest = TableManifest {
            baby_size: 3,
            range_id: range_id(&Scalar::from_u64(1000), &Scalar::from_u64(5095)),
            table_checksum: table_checksum(&[7, 7, 9]),
            ..TableManifest::default()
        };
        assert_eq!(manifest.format_version, BSGS_TABLE_FORMAT_VERSION);
        assert_eq!(manifest.curve, "secp256k1");
        assert!(manifest.compatible(&manifest.clone()));

        let mut other = manifest.clone();
        other.table_checksum ^= 1;
        assert!(!manifest.compatible(&other));
    }

    #[test]
    fn range_id_is_uppercase_and_trimmed() {
        // 1000 = 0x3E8, 5095 = 0x13E7.
        assert_eq!(
            range_id(&Scalar::from_u64(1000), &Scalar::from_u64(5095)),
            "3E8:13E7"
        );
        assert_eq!(range_id(&Scalar::ZERO, &Scalar::from_u64(1)), "0:1");
    }

    #[test]
    fn baby_size_golden() {
        // Explicit m is clamped to at least 1 and rejected above 32 bits.
        assert_eq!(baby_size_for(99, 1), Ok(1));
        assert_eq!(baby_size_for(99, 10), Ok(10));
        assert!(baby_size_for(99, u64::from(u32::MAX) + 1).is_err());
        // Default: isqrt(span + 1) + 1.
        assert_eq!(baby_size_for(0, 0), Ok(2));
        assert_eq!(baby_size_for(99, 0), Ok(11));
        assert_eq!(baby_size_for(10_000, 0), Ok(101));
    }

    #[test]
    fn fold_map_is_first_j_wins() {
        let map = map_from_folds(&[7, 7, 9]);
        assert_eq!(map.get(&7), Some(&1));
        assert_eq!(map.get(&9), Some(&3));
        assert_eq!(map.len(), 2);
    }

    #[test]
    fn table_checksum_golden() {
        assert_eq!(table_checksum(&[]), 14_695_981_039_346_656_037);
        assert_eq!(table_checksum(&[1, 2]), 8_581_494_755_304_202_342);
        assert_eq!(table_checksum(&[7, 7, 9]), 15_253_963_222_228_185_996);
    }

    #[test]
    fn span_u128_accepts_128_bits_and_rejects_higher() {
        let low = Scalar::from_u64(1);
        assert_eq!(span_u128(&low, &Scalar::from_u64(1001)), Some(1000));

        let high = Scalar::from_bytes_be(&{
            let mut bytes = [0u8; 32];
            bytes[15] = 1; // bit 128
            bytes
        })
        .expect("canonical scalar");
        assert_eq!(scalar_to_u128(&high), None);
        // `high - 1` still fits in 128 bits; the full span does not.
        assert_eq!(span_u128(&Scalar::from_u64(1), &high), Some(u128::MAX));
        assert_eq!(span_u128(&Scalar::ZERO, &high), None);
    }
}
